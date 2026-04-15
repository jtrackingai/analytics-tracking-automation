import { chromium, Browser, BrowserContext, Page, Request } from 'playwright';
import { GTMClient } from './client';
import { EventSchema, GA4Event, isRedundantAutoEvent } from '../generator/event-schema';
import { SiteAnalysis } from '../crawler/page-analyzer';

export interface FiredEvent {
  eventName: string;
  timestamp: number;
  url: string;
  parameters: Record<string, string>;
  rawPayload: string;
}

export type FailureCategory =
  | 'requires_login'       // element/page is behind authentication
  | 'requires_journey'     // multi-step flow (cart, checkout, etc.)
  | 'selector_mismatch'    // CSS selector didn't match any DOM element
  | 'config_error';        // no hit received — likely a real config issue

export interface TagVerificationResult {
  event: GA4Event;
  fired: boolean;
  firedCount: number;
  firedEvents: FiredEvent[];
  failureReason?: string;
  failureCategory?: FailureCategory;
}

export interface PreviewResult {
  siteUrl: string;
  previewStartedAt: string;
  previewEndedAt: string;
  gtmContainerId: string;
  timing?: {
    totalMs: number;
    quickPreviewMs?: number;
    previewEnvironmentMs?: number;
    browserVerificationMs?: number;
  };
  results: TagVerificationResult[];
  totalSchemaEvents: number;
  totalExpected: number;
  totalFired: number;
  totalFailed: number;
  redundantAutoEventsSkipped: number;
  unexpectedFiredEvents: FiredEvent[];
}

interface BrowserVerificationArgs {
  siteAnalysis: SiteAnalysis;
  schema: EventSchema;
  gtmPublicId: string;
  startedAt?: string;
  gtmScriptUrl?: string | null;
  mapPageUrl?: (url: string) => string;
  browser?: Browser;
}

interface PageVerificationPlan {
  pageAnalysis: SiteAnalysis['pages'][number];
  applicableEvents: GA4Event[];
}

function getEventIdentity(event: Pick<GA4Event, 'eventName' | 'triggerType' | 'elementSelector' | 'pageUrlPattern'>): string {
  return [
    event.eventName,
    event.triggerType,
    event.elementSelector || '',
    event.pageUrlPattern || '',
  ].join('::');
}

function parseGA4Payload(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  try {
    const searchParams = new URLSearchParams(body);
    searchParams.forEach((value, key) => {
      params[key] = value;
    });
  } catch {
    // ignore parse errors
  }
  return params;
}

function inferFailureReason(event: GA4Event): { reason: string; category: FailureCategory } {
  switch (event.triggerType) {
    case 'click':
      if (event.elementSelector) {
        const authKeywords = /login|signin|sign-in|logout|account|dashboard|profile|checkout|cart/i;
        if (authKeywords.test(event.elementSelector) || authKeywords.test(event.eventName)) {
          return {
            reason: `Element "${event.elementSelector}" is likely behind authentication. Manual verification required.`,
            category: 'requires_login',
          };
        }
        return {
          reason: `Selector "${event.elementSelector}" did not match a visible, clickable element. Verify with browser DevTools.`,
          category: 'selector_mismatch',
        };
      }
      return {
        reason: 'Click trigger did not fire. Check if the target element exists and is clickable.',
        category: 'config_error',
      };
    case 'form_submit':
      return {
        reason: `Form "${event.elementSelector || 'unknown'}" could not be submitted. May require valid input, reCAPTCHA, or login.`,
        category: 'requires_journey',
      };
    case 'scroll':
      return {
        reason: 'Scroll depth did not reach threshold. Page may be too short, or scroll events are suppressed by the site.',
        category: 'config_error',
      };
    case 'video':
      return {
        reason: 'Video trigger did not fire. Player may require user interaction to start, or is an unsupported type (non-YouTube).',
        category: 'requires_journey',
      };
    case 'page_view':
      return {
        reason: `Page view did not fire. URL may not match pattern "${event.pageUrlPattern || 'all pages'}", or page requires login.`,
        category: 'config_error',
      };
    default:
      return {
        reason: 'Custom event did not fire. The dataLayer.push() call may not be reached by automated preview.',
        category: 'config_error',
      };
  }
}

export interface GTMCheckResult {
  siteLoadsGTM: boolean;
  loadedContainerIds: string[]; // e.g. ["GTM-ABC123"]
  hasExpectedContainer: boolean;
  pageLoaded: boolean;
  navigationError?: string;
}

export interface GTMPageCheckResult extends GTMCheckResult {
  url: string;
}

const PREVIEW_PREFLIGHT_TIMEOUT_MS = 20000;
const PREVIEW_PREFLIGHT_FALLBACK_TIMEOUT_MS = 20000;
const PREVIEW_PREFLIGHT_SETTLE_MS = 1500;
const PREVIEW_PAGE_TIMEOUT_MS = 30000;
const PREVIEW_PAGE_FALLBACK_TIMEOUT_MS = 20000;
const PREVIEW_PAGE_SETTLE_MS = 4000;
const PREVIEW_RESTORE_TIMEOUT_MS = 10000;
const PREVIEW_RESTORE_FALLBACK_TIMEOUT_MS = 10000;
const PREVIEW_RESTORE_SETTLE_MS = 2000;

async function navigateForPreviewPreflight(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PREVIEW_PREFLIGHT_TIMEOUT_MS });
    await page.waitForTimeout(PREVIEW_PREFLIGHT_SETTLE_MS);
  } catch (err) {
    const message = (err as Error).message || '';
    if (!message.includes('Timeout')) throw err;

    console.warn(`  Preview preflight timeout on ${url}; retrying with commit fallback.`);
    await page.goto(url, { waitUntil: 'commit', timeout: PREVIEW_PREFLIGHT_FALLBACK_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }
}

async function navigateForPreviewPage(
  page: Page,
  url: string,
  args: {
    phaseLabel: string;
    primaryTimeoutMs: number;
    fallbackTimeoutMs: number;
    settleMs: number;
  },
): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: args.primaryTimeoutMs });
    await page.waitForTimeout(args.settleMs);
  } catch (err) {
    const message = (err as Error).message || '';
    if (!message.includes('Timeout')) throw err;

    console.warn(`  ${args.phaseLabel} timeout on ${url}; retrying with commit fallback.`);
    await page.goto(url, { waitUntil: 'commit', timeout: args.fallbackTimeoutMs });
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(args.settleMs);
  }
}

function mapPreviewPageUrl(originalUrl: string, injectGTM: boolean, previewUrlParams: string | null): string {
  if (!injectGTM) return originalUrl;

  // Inject mode carries preview auth on the GTM script request. Appending the same
  // params to the site URL can trigger slow or broken page navigations on some sites.
  return originalUrl;
}

export const __testOnly = {
  navigateForPreviewPreflight,
  navigateForPreviewPage,
  mapPreviewPageUrl,
  clickVisibleMatchAt,
};

function getManagedPreviewEvents(schema: EventSchema): GA4Event[] {
  return schema.events.filter(event => !isRedundantAutoEvent(event));
}

function buildPageVerificationPlan(siteAnalysis: SiteAnalysis, schema: EventSchema): PageVerificationPlan[] {
  const managedEvents = getManagedPreviewEvents(schema);
  return siteAnalysis.pages
    .map(pageAnalysis => ({
      pageAnalysis,
      applicableEvents: managedEvents.filter(event => eventAppliesToPage(event, pageAnalysis.url, siteAnalysis.rootUrl)),
    }))
    .filter(entry => entry.applicableEvents.length > 0);
}

export function getSchemaRelevantPageUrls(siteAnalysis: SiteAnalysis, schema: EventSchema, maxPages: number = 6): string[] {
  const relevantUrls = buildPageVerificationPlan(siteAnalysis, schema)
    .map(entry => entry.pageAnalysis.url);

  const ordered = [siteAnalysis.rootUrl, ...relevantUrls];
  return Array.from(new Set(ordered)).slice(0, Math.max(1, maxPages));
}

export async function checkGTMOnPages(urls: string[], expectedPublicId: string): Promise<GTMPageCheckResult[]> {
  const browser: Browser = await chromium.launch({ headless: true });
  const uniqueUrls = Array.from(new Set(urls.filter(Boolean)));
  const results: GTMPageCheckResult[] = [];

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const loadedIdsByUrl = new Map<string, string[]>();
    let currentUrl = '';

    await context.route('**googletagmanager.com/gtm.js**', async (route, request) => {
      const reqUrl = new URL(request.url());
      const id = reqUrl.searchParams.get('id');
      if (id && currentUrl) {
        const loadedForUrl = loadedIdsByUrl.get(currentUrl) || [];
        if (!loadedForUrl.includes(id)) loadedForUrl.push(id);
        loadedIdsByUrl.set(currentUrl, loadedForUrl);
      }
      await route.continue();
    });

    for (const url of uniqueUrls) {
      currentUrl = url;
      let pageLoaded = false;
      let navigationError: string | undefined;

      try {
        await navigateForPreviewPreflight(page, url);
        pageLoaded = true;
      } catch (error) {
        navigationError = (error as Error).message;
      }

      const loadedContainerIds = loadedIdsByUrl.get(url) || [];
      results.push({
        url,
        siteLoadsGTM: loadedContainerIds.length > 0,
        loadedContainerIds,
        hasExpectedContainer: loadedContainerIds.includes(expectedPublicId),
        pageLoaded,
        navigationError,
      });
    }

    await context.close();
  } finally {
    await browser.close();
  }

  return results;
}

export async function checkGTMOnPage(url: string, expectedPublicId: string): Promise<GTMCheckResult> {
  const [result] = await checkGTMOnPages([url], expectedPublicId);
  if (result) {
    return {
      siteLoadsGTM: result.siteLoadsGTM,
      loadedContainerIds: result.loadedContainerIds,
      hasExpectedContainer: result.hasExpectedContainer,
      pageLoaded: result.pageLoaded,
      navigationError: result.navigationError,
    };
  }

  return {
    siteLoadsGTM: false,
    loadedContainerIds: [],
    hasExpectedContainer: false,
    pageLoaded: false,
    navigationError: 'No URL provided for GTM check.',
  };
}

function eventAppliesToPage(event: GA4Event, pageUrl: string, rootUrl: string): boolean {
  if (event.pageUrlPattern) {
    try {
      return new RegExp(event.pageUrlPattern).test(pageUrl);
    } catch {
      return false;
    }
  }

  return pageUrl === rootUrl;
}

function normalizeComparableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url.split('#')[0] || url;
  }
}

function isBlockingNavigationError(message: string): boolean {
  return /ERR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Timeout|Navigation timeout|NS_ERROR|net::|certificate|SSL|TLS|Target page, context or browser has been closed/i.test(message);
}

async function waitForHitCount(
  getCount: () => number,
  previousCount: number,
  timeoutMs: number,
): Promise<number> {
  const startedAt = Date.now();
  let currentCount = getCount();

  while (Date.now() - startedAt < timeoutMs) {
    if (currentCount > previousCount) return currentCount;
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    currentCount = getCount();
  }

  return currentCount;
}

function getMatchingFiredEvents(event: GA4Event, rootUrl: string, firedEvents: FiredEvent[]): FiredEvent[] {
  return firedEvents.filter(fe =>
    fe.eventName === event.eventName && eventAppliesToPage(event, fe.url, rootUrl),
  );
}

function getPriorityWeight(priority: GA4Event['priority']): number {
  switch (priority) {
    case 'high': return 0;
    case 'medium': return 1;
    default: return 2;
  }
}

function sortEventsForPreview(events: GA4Event[]): GA4Event[] {
  return [...events].sort((left, right) => {
    const priorityDelta = getPriorityWeight(left.priority) - getPriorityWeight(right.priority);
    if (priorityDelta !== 0) return priorityDelta;
    return left.eventName.localeCompare(right.eventName);
  });
}

async function attemptFormSubmit(page: Page, selector: string): Promise<boolean> {
  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);

  for (let i = 0; i < Math.min(count, 3); i++) {
    const candidate = locator.nth(i);
    const isVisible = await candidate.isVisible({ timeout: 2000 }).catch(() => false);
    if (!isVisible) continue;

    try {
      await candidate.scrollIntoViewIfNeeded().catch(() => {});
      await candidate.evaluate((form: Element) => {
        const target = form as HTMLFormElement;
        if (typeof target.requestSubmit === 'function') {
          target.requestSubmit();
          return;
        }
        target.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      return true;
    } catch {
      // Try next visible form candidate.
    }
  }

  return false;
}

async function attemptCustomEventDetection(
  page: Page,
  event: GA4Event,
  rootUrl: string,
  firedEvents: FiredEvent[],
  waitMs: number = 800,
): Promise<number> {
  const beforeHits = getMatchingFiredEvents(event, rootUrl, firedEvents).length;
  return waitForHitCount(
    () => getMatchingFiredEvents(event, rootUrl, firedEvents).length,
    beforeHits,
    waitMs,
  );
}

async function injectPreviewContainer(page: Page, gtmScriptUrl: string | null, gtmPublicId: string): Promise<boolean> {
  if (!gtmScriptUrl || page.isClosed()) return false;

  await page.evaluate((args: { src: string; containerId: string }) => {
    if ((window as any).google_tag_manager?.[args.containerId]) return;
    (window as any).dataLayer = (window as any).dataLayer || [];
    (window as any).dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    const s = document.createElement('script');
    s.async = false;
    s.src = args.src;
    (document.head || document.documentElement).appendChild(s);
  }, { src: gtmScriptUrl, containerId: gtmPublicId }).catch(() => {});

  const gtmReady = await page.waitForFunction((containerId: string) => {
    return Boolean((window as any).google_tag_manager?.[containerId]);
  }, gtmPublicId, { timeout: 2500 }).then(() => true).catch(() => false);

  if (!gtmReady) {
    await page.waitForLoadState('networkidle', { timeout: 1000 }).catch(() => {});
  }

  return gtmReady;
}

async function restoreOriginalPage(
  page: Page,
  originalPageUrl: string,
  gtmScriptUrl: string | null,
  gtmPublicId: string,
): Promise<boolean> {
  if (page.isClosed()) return false;

  await navigateForPreviewPage(page, originalPageUrl, {
    phaseLabel: 'Preview restore',
    primaryTimeoutMs: PREVIEW_RESTORE_TIMEOUT_MS,
    fallbackTimeoutMs: PREVIEW_RESTORE_FALLBACK_TIMEOUT_MS,
    settleMs: PREVIEW_RESTORE_SETTLE_MS,
  });

  if (gtmScriptUrl) {
    return injectPreviewContainer(page, gtmScriptUrl, gtmPublicId);
  }

  await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
  return true;
}

async function clickVisibleMatchAt(page: Page, selector: string, candidateIndex: number): Promise<boolean> {
  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);
  if (candidateIndex < 0 || candidateIndex >= Math.min(count, 8)) return false;

  const candidate = locator.nth(candidateIndex);
  const isVisible = await candidate.isVisible({ timeout: 2000 }).catch(() => false);
  if (!isVisible) return false;

  try {
    await candidate.scrollIntoViewIfNeeded().catch(() => {});
    await candidate.click({ timeout: 2000, force: false, noWaitAfter: true });
    return true;
  } catch {
    try {
      await candidate.scrollIntoViewIfNeeded().catch(() => {});
      await candidate.click({ timeout: 2000, force: true, noWaitAfter: true });
      return true;
    } catch {
      return false;
    }
  }
}

async function clickVisibleMatchesUntilEvent(
  page: Page,
  selector: string,
  args: {
    beforeHits: number;
    getHitCount: () => number;
    waitMs: number;
    eventName: string;
  },
): Promise<{ clicked: boolean; afterHits: number }> {
  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);
  const maxAttempts = Math.min(count, 8);
  let clicked = false;
  let afterHits = args.beforeHits;

  for (let i = 0; i < maxAttempts; i++) {
    const attemptClicked = await clickVisibleMatchAt(page, selector, i);
    if (!attemptClicked) continue;

    clicked = true;
    afterHits = await waitForHitCount(args.getHitCount, args.beforeHits, args.waitMs);
    if (afterHits > args.beforeHits) {
      return { clicked, afterHits };
    }

    if (maxAttempts > 1 && i < maxAttempts - 1) {
      console.log(`      schema retry: ${args.eventName} (candidate ${i + 2}/${maxAttempts})`);
    }
  }

  return { clicked, afterHits };
}

function inferSyntheticInputValue(input: {
  placeholder?: string | null;
  id?: string | null;
  name?: string | null;
  type?: string | null;
}): string {
  const hint = `${input.placeholder || ''} ${input.id || ''} ${input.name || ''}`.toLowerCase();
  const inputType = (input.type || '').toLowerCase();

  if (inputType === 'url' || /(website|site|domain|url)/.test(hint)) {
    return 'https://example.com';
  }

  if (/(gtm|tag manager|measurement|tracking id)/.test(hint)) {
    return 'GTM-ABC1234';
  }

  if (inputType === 'email' || /email/.test(hint)) {
    return 'test@example.com';
  }

  if (inputType === 'tel' || /phone|mobile|tel/.test(hint)) {
    return '13800138000';
  }

  return 'test';
}

async function fillNearbyInputsForSelector(page: Page, selector: string): Promise<number> {
  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);

  for (let i = 0; i < Math.min(count, 5); i++) {
    const candidate = locator.nth(i);
    const isVisible = await candidate.isVisible({ timeout: 2000 }).catch(() => false);
    if (!isVisible) continue;

    const inputs = await candidate.evaluate((el) => {
      const candidates: HTMLInputElement[] = [];
      let current: Element | null = el.parentElement;
      let depth = 0;

      while (current && depth < 4 && candidates.length === 0) {
        candidates.push(...Array.from(
          current.querySelectorAll<HTMLInputElement>('input:not([type="hidden"]):not([disabled]), textarea:not([disabled])')
        ));
        current = current.parentElement;
        depth++;
      }

      return candidates
        .filter(input => {
          const rect = input.getBoundingClientRect();
          const style = window.getComputedStyle(input);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        })
        .slice(0, 3)
        .map(input => ({
          placeholder: input.getAttribute('placeholder'),
          id: input.id || null,
          name: input.getAttribute('name'),
          type: input.getAttribute('type'),
        }));
    }).catch(() => []);

    if (!inputs || inputs.length === 0) continue;

    const filled = await candidate.evaluate((el, inputPlans: Array<{ placeholder?: string | null; id?: string | null; name?: string | null; type?: string | null; value: string }>) => {
      const candidates: Array<HTMLInputElement | HTMLTextAreaElement> = [];
      let current: Element | null = el.parentElement;
      let depth = 0;

      while (current && depth < 4 && candidates.length === 0) {
        candidates.push(...Array.from(
          current.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type="hidden"]):not([disabled]), textarea:not([disabled])')
        ));
        current = current.parentElement;
        depth++;
      }

      let fillCount = 0;
      for (const input of candidates.slice(0, inputPlans.length)) {
        const plan = inputPlans[fillCount];
        if (!plan) break;
        if (input.value && input.value.trim().length > 0) {
          fillCount++;
          continue;
        }
        input.focus();
        input.value = plan.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        fillCount++;
      }

      return fillCount;
    }, inputs.map(input => ({ ...input, value: inferSyntheticInputValue(input) }))).catch(() => 0);

    if (filled > 0) return filled;
  }

  return 0;
}

async function runBrowserVerification(args: BrowserVerificationArgs): Promise<PreviewResult> {
  const startedAt = args.startedAt || new Date().toISOString();
  const mapPageUrl = args.mapPageUrl || ((url: string) => url);
  const gtmScriptUrl = args.gtmScriptUrl || null;
  const gtmPublicId = args.gtmPublicId;
  const siteAnalysis = args.siteAnalysis;
  const schema = args.schema;
  const managedEvents = getManagedPreviewEvents(schema);
  const pagesToVerify = buildPageVerificationPlan(siteAnalysis, schema);
  const browserVerificationStartedAt = Date.now();

  const allFiredEvents: FiredEvent[] = [];
  const ownsBrowser = !args.browser;
  const browser: Browser = args.browser || await chromium.launch({ headless: true });

  try {
    const context: BrowserContext = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; EventTrackingPreview/1.0)',
    });
    // Note: we intentionally don't handle popup pages here —
    // popups (e.g. Google OAuth) are left to load in the background.
    // The main page continues unblocked once the click fires GTM events.

    // Intercept GA4 collection requests (google-analytics.com and server-side tagging proxies)
    await context.route('**/g/collect**', async (route, request) => {
      const url = new URL(request.url());
      const urlQuery = url.search.slice(1);
      const body = request.postData() || '';

      // GA4 batch requests send multiple hits separated by newlines — parse each hit separately
      const bodyLines = body.split('\n').filter(line => line.trim());
      const hits = bodyLines.length > 0 ? bodyLines : [''];

      for (const hitLine of hits) {
        const params = parseGA4Payload(urlQuery + (hitLine ? '&' + hitLine : ''));
        const eventName = params['en'] || params['event_name'] || 'unknown';
        const pageUrl = params['dl'] || params['page_location'] || url.toString();

        allFiredEvents.push({
          eventName,
          timestamp: Date.now(),
          url: pageUrl,
          parameters: params,
          rawPayload: hitLine || url.search,
        });
      }

      await route.continue().catch(() => {});
    });

    // Also intercept gtm.js to detect if GTM loaded
    let gtmLoaded = false;
    await context.route(`**googletagmanager.com/gtm.js**`, async (route) => {
      gtmLoaded = true;
      await route.continue().catch(() => {});
    });

    if (pagesToVerify.length === 0) {
      await context.close().catch(() => {});
      return {
        siteUrl: siteAnalysis.rootUrl,
        previewStartedAt: startedAt,
        previewEndedAt: new Date().toISOString(),
        gtmContainerId: gtmPublicId,
        timing: {
          totalMs: Date.now() - browserVerificationStartedAt,
          browserVerificationMs: Date.now() - browserVerificationStartedAt,
        },
        results: [],
        totalSchemaEvents: schema.events.length,
        totalExpected: 0,
        totalFired: 0,
        totalFailed: 0,
        redundantAutoEventsSkipped: schema.events.length,
        unexpectedFiredEvents: [],
      };
    }

    const remainingEventIds = new Set(managedEvents.map(event => getEventIdentity(event)));
    const orderedManagedEvents = sortEventsForPreview(managedEvents);

    // Visit only pages that actually have schema events to verify.
    for (const { pageAnalysis, applicableEvents } of pagesToVerify) {
      if (remainingEventIds.size === 0) break;

      const page = await context.newPage();
      console.log(`  Verifying: ${pageAnalysis.url}`);

      try {
        const mappedPageUrl = mapPageUrl(pageAnalysis.url);
        await navigateForPreviewPage(page, mappedPageUrl, {
          phaseLabel: 'Preview verification',
          primaryTimeoutMs: PREVIEW_PAGE_TIMEOUT_MS,
          fallbackTimeoutMs: PREVIEW_PAGE_FALLBACK_TIMEOUT_MS,
          settleMs: PREVIEW_PAGE_SETTLE_MS,
        });
        if (page.isClosed()) continue;
        console.log(`    [page loaded]`);

        let pageReady = true;
        if (gtmScriptUrl) {
          pageReady = await injectPreviewContainer(page, gtmScriptUrl, gtmPublicId);
          if (!pageReady) {
            throw new Error(`Injected GTM container ${gtmPublicId} did not finish loading on ${pageAnalysis.url}.`);
          }
          console.log(`    [GTM injected]`);
        } else {
          await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
        }
        if (page.isClosed()) continue;

        const shouldSimulateScroll = applicableEvents.some(event => event.triggerType === 'scroll');
        if (shouldSimulateScroll) {
          console.log(`    [scrolling]`);
          await page.evaluate(() => {
            return new Promise<void>(resolve => {
              let scrolled = 0;
              const interval = setInterval(() => {
                window.scrollBy(0, window.innerHeight * 0.3);
                scrolled++;
                if (scrolled >= 5) {
                  clearInterval(interval);
                  resolve();
                }
              }, 300);
            });
          }).catch(() => {});
          if (page.isClosed()) continue;
          await page.waitForLoadState('networkidle', { timeout: 800 }).catch(() => {});
          if (page.isClosed()) continue;
        }

        const siteHostname = new URL(pageAnalysis.url).hostname;
        const blockNav = async (route: import('playwright').Route) => {
          const req = route.request();
          try {
            const reqHostname = new URL(req.url()).hostname;
            if (req.resourceType() === 'document' && reqHostname !== siteHostname) {
              await route.abort();
              return;
            }
          } catch { /* ignore malformed URLs */ }
          await route.fallback();
        };
        await page.route('**', blockNav);
        page.setDefaultNavigationTimeout(10000);

        const originalPageUrl = mappedPageUrl;
        const orderedApplicableEvents = orderedManagedEvents.filter(event =>
          applicableEvents.some(candidate => getEventIdentity(candidate) === getEventIdentity(event)),
        );

        console.log(`    [schema events ${orderedApplicableEvents.length}]`);
        let shouldRestoreBeforeNextEvent = false;
        for (const event of orderedApplicableEvents) {
          if (page.isClosed()) break;
          try {
            const eventId = getEventIdentity(event);
            if (!remainingEventIds.has(eventId)) continue;

            if (
              (shouldRestoreBeforeNextEvent && event.triggerType !== 'page_view' && event.triggerType !== 'custom') ||
              normalizeComparableUrl(page.url()) !== normalizeComparableUrl(originalPageUrl)
            ) {
              const restored = await restoreOriginalPage(page, originalPageUrl, gtmScriptUrl, gtmPublicId);
              shouldRestoreBeforeNextEvent = false;
              if (!restored || page.isClosed()) {
                throw new Error(`Failed to restore ${pageAnalysis.url} before previewing ${event.eventName}.`);
              }
            }

            const beforeHits = getMatchingFiredEvents(event, siteAnalysis.rootUrl, allFiredEvents).length;
            let afterHits = beforeHits;
            let interactionPerformed = false;

            if (event.triggerType === 'page_view') {
              afterHits = await waitForHitCount(
                () => getMatchingFiredEvents(event, siteAnalysis.rootUrl, allFiredEvents).length,
                beforeHits,
                800,
              );
              interactionPerformed = true;
            } else if (event.triggerType === 'custom') {
              afterHits = await attemptCustomEventDetection(page, event, siteAnalysis.rootUrl, allFiredEvents, 800);
              interactionPerformed = true;
            } else if (event.triggerType === 'form_submit' && event.elementSelector) {
              const cleanSelector = event.elementSelector.replace(/:contains\([^)]*\)/g, '').trim();
              const filledInputs = await fillNearbyInputsForSelector(page, cleanSelector);
              if (filledInputs > 0) {
                console.log(`      schema prepare: ${event.eventName} (filled ${filledInputs} input${filledInputs > 1 ? 's' : ''})`);
              }
              const submitted = await attemptFormSubmit(page, cleanSelector);
              if (!submitted) {
                console.log(`      schema skip: ${event.eventName}`);
                continue;
              }
              interactionPerformed = true;
              afterHits = await waitForHitCount(
                () => getMatchingFiredEvents(event, siteAnalysis.rootUrl, allFiredEvents).length,
                beforeHits,
                1500,
              );
            } else if (event.triggerType === 'click' && event.elementSelector) {
              const cleanSelector = event.elementSelector.replace(/:contains\([^)]*\)/g, '').trim();
              let { clicked, afterHits: clickHits } = await clickVisibleMatchesUntilEvent(page, cleanSelector, {
                beforeHits,
                getHitCount: () => getMatchingFiredEvents(event, siteAnalysis.rootUrl, allFiredEvents).length,
                waitMs: 1200,
                eventName: event.eventName,
              });
              afterHits = clickHits;
              if (clicked) {
                interactionPerformed = true;
              }

              if (afterHits <= beforeHits) {
                const filledInputs = await fillNearbyInputsForSelector(page, cleanSelector);
                if (filledInputs > 0) {
                  console.log(`      schema prepare: ${event.eventName} (filled ${filledInputs} input${filledInputs > 1 ? 's' : ''})`);
                  const retryResult = await clickVisibleMatchesUntilEvent(page, cleanSelector, {
                    beforeHits,
                    getHitCount: () => getMatchingFiredEvents(event, siteAnalysis.rootUrl, allFiredEvents).length,
                    waitMs: 1500,
                    eventName: event.eventName,
                  });
                  clicked = retryResult.clicked || clicked;
                  if (clicked) {
                    interactionPerformed = true;
                    afterHits = retryResult.afterHits;
                  }
                }
              }

              if (!clicked) {
                console.log(`      schema skip: ${event.eventName}`);
                continue;
              }
            } else {
              afterHits = await waitForHitCount(
                () => getMatchingFiredEvents(event, siteAnalysis.rootUrl, allFiredEvents).length,
                beforeHits,
                800,
              );
            }

            if (afterHits > beforeHits) {
              console.log(`      schema hit: ${event.eventName}`);
              remainingEventIds.delete(eventId);
            } else {
              console.log(`      schema no hit: ${event.eventName}`);
            }

            shouldRestoreBeforeNextEvent = interactionPerformed && (
              page.isClosed()
              || normalizeComparableUrl(page.url()) !== normalizeComparableUrl(originalPageUrl)
            );
          } catch (error) {
            const message = (error as Error).message;
            if (isBlockingNavigationError(message)) {
              throw error;
            }
            console.warn(`      schema error: ${event.eventName}: ${message}`);
          }
        }

        for (const event of managedEvents) {
          const eventId = getEventIdentity(event);
          if (!remainingEventIds.has(eventId)) continue;
          const matched = getMatchingFiredEvents(event, siteAnalysis.rootUrl, allFiredEvents);
          if (matched.length > 0) {
            remainingEventIds.delete(eventId);
          }
        }

        await page.unroute('**', blockNav).catch(() => {});
      } catch (err) {
        const message = (err as Error).message;
        if (isBlockingNavigationError(message)) {
          throw new Error(`Preview aborted on ${pageAnalysis.url}: ${message}`);
        }
        console.warn(`  Warning: Failed to verify ${pageAnalysis.url}: ${message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }

    await context.close().catch(() => {});
  } finally {
    if (ownsBrowser) {
      await browser.close();
    }
  }

  // Match fired events against expected events
  const results: TagVerificationResult[] = managedEvents.map(event => {
    const matchedFired = getMatchingFiredEvents(event, siteAnalysis.rootUrl, allFiredEvents);
    const fired = matchedFired.length > 0;

    return {
      event,
      fired,
      firedCount: matchedFired.length,
      firedEvents: matchedFired,
      failureReason: fired ? undefined : inferFailureReason(event).reason,
      failureCategory: fired ? undefined : inferFailureReason(event).category,
    };
  });

  // Also include any unexpected GA4 events that fired
  const expectedEventNames = new Set(schema.events.map(event => event.eventName));
  const unexpectedFired = allFiredEvents.filter(fe => !expectedEventNames.has(fe.eventName));
  if (unexpectedFired.length > 0) {
    console.log(`  ℹ️  ${unexpectedFired.length} additional events fired (not in schema): ${[...new Set(unexpectedFired.map(e => e.eventName))].join(', ')}`);
  }

  const totalFired = results.filter(r => r.fired).length;
  const totalFailed = results.filter(r => !r.fired).length;
  const browserVerificationMs = Date.now() - browserVerificationStartedAt;

  return {
    siteUrl: siteAnalysis.rootUrl,
    previewStartedAt: startedAt,
    previewEndedAt: new Date().toISOString(),
    gtmContainerId: gtmPublicId,
    timing: {
      totalMs: browserVerificationMs,
      browserVerificationMs,
    },
    results,
    totalSchemaEvents: schema.events.length,
    totalExpected: managedEvents.length,
    totalFired,
    totalFailed,
    redundantAutoEventsSkipped: schema.events.length - managedEvents.length,
    unexpectedFiredEvents: unexpectedFired,
    };
  }

export async function runPreviewVerification(
  siteAnalysis: SiteAnalysis,
  schema: EventSchema,
  client: GTMClient,
  accountId: string,
  containerId: string,
  workspaceId: string,
  gtmPublicId: string, // GTM-XXXXXX
  injectGTM: boolean = false,
  browser?: Browser,
): Promise<PreviewResult> {
  const startedAt = new Date().toISOString();
  const totalStartedAt = Date.now();

  // Enable GTM preview mode
  console.log('  Enabling GTM Quick Preview...');
  const quickPreviewStartedAt = Date.now();
  await client.quickPreview(accountId, containerId, workspaceId);
  const quickPreviewMs = Date.now() - quickPreviewStartedAt;

  // Get preview environment auth params for client-side GTM preview URL injection
  let previewUrlParams: string | null = null;
  let previewEnvironmentMs = 0;
  if (injectGTM) {
    console.log('  Fetching GTM preview environment token...');
    const previewEnvironmentStartedAt = Date.now();
    const previewEnv = await client.getPreviewEnvironment(accountId, containerId, workspaceId);
    previewEnvironmentMs = Date.now() - previewEnvironmentStartedAt;
    if (previewEnv) {
      previewUrlParams = `gtm_preview=${previewEnv.gtmPreview}&gtm_auth=${previewEnv.gtmAuth}`;
      console.log(`  ✅ Preview env: ${previewEnv.gtmPreview}`);
    } else {
      console.log(`  ⚠️  No preview environment found — injecting GTM without preview params (will load published version only)`);
    }
  }

  let gtmScriptUrl: string | null = null;
  if (injectGTM && gtmPublicId && gtmPublicId !== 'UNKNOWN') {
    gtmScriptUrl = previewUrlParams
      ? `https://www.googletagmanager.com/gtm.js?id=${gtmPublicId}&${previewUrlParams}`
      : `https://www.googletagmanager.com/gtm.js?id=${gtmPublicId}`;
    console.log(`  💉 GTM container ${gtmPublicId} will be injected per-page${previewUrlParams ? ' (with preview params)' : ''}...`);
  }

  const mapPageUrl = (originalUrl: string) => {
    return mapPreviewPageUrl(originalUrl, injectGTM, previewUrlParams);
  };

  const previewResult = await runBrowserVerification({
    siteAnalysis,
    schema,
    gtmPublicId,
    startedAt,
    gtmScriptUrl,
    mapPageUrl,
    browser,
  });

  previewResult.timing = {
    totalMs: Date.now() - totalStartedAt,
    quickPreviewMs,
    previewEnvironmentMs: injectGTM ? previewEnvironmentMs : undefined,
    browserVerificationMs: previewResult.timing?.browserVerificationMs,
  };

  return previewResult;
}

export async function runLiveVerification(
  siteAnalysis: SiteAnalysis,
  schema: EventSchema,
  gtmPublicId: string,
): Promise<PreviewResult> {
  return runBrowserVerification({
    siteAnalysis,
    schema,
    gtmPublicId,
    startedAt: new Date().toISOString(),
    gtmScriptUrl: null,
  });
}
