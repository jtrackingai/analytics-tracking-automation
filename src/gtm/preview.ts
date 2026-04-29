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

interface InteractionOutcome {
  attempted: boolean;
  clicked: boolean;
  prepared: boolean;
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

// Ignore GA4 auto/enhanced-measurement noise in preview drift reporting.
// `audiences` is treated as ignorable based on observed Google tag/GA audience
// processing behavior; this is an inference from preview traffic, not an official
// GA4 auto-collected event classification.
const IGNORABLE_UNEXPECTED_EVENT_NAMES = new Set([
  'audiences',
  'click',
  'file_download',
  'first_visit',
  'form_start',
  'form_submit',
  'page_view',
  'scroll',
  'session_start',
  'user_engagement',
  'video_complete',
  'video_progress',
  'video_start',
  'view_search_results',
]);

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

function normalizeEventName(eventName: string | undefined): string {
  return (eventName || 'unknown').trim();
}

export function isIgnorableUnexpectedEventName(eventName: string | undefined): boolean {
  return IGNORABLE_UNEXPECTED_EVENT_NAMES.has(normalizeEventName(eventName));
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
const PREVIEW_INJECTION_SCRIPT_TIMEOUT_MS = 8000;
const PREVIEW_INJECTION_READY_TIMEOUT_MS = 8000;
const PREVIEW_INJECTION_SETTLE_MS = 1000;
const PREVIEW_INJECTION_MAX_ATTEMPTS = 2;
const PREVIEW_CLICK_WAIT_MS = 6000;
const PREVIEW_CLICK_RETRY_WAIT_MS = 7000;
const PREVIEW_SUBMIT_WAIT_MS = 6000;
const PREVIEW_CUSTOM_CLICK_WAIT_MS = 6000;

function splitSelectorList(selector: string): string[] {
  return selector.split(',').map(part => part.trim()).filter(Boolean);
}

function parseContainsSelector(selector: string): { cssSelector: string; textMatches: string[] } {
  const textMatches = Array.from(selector.matchAll(/:contains\((["'])(.*?)\1\)/g))
    .map(match => match[2]?.trim())
    .filter((value): value is string => !!value);
  const cssSelector = selector.replace(/:contains\((["'])(.*?)\1\)/g, '').trim() || '*';
  return { cssSelector, textMatches };
}

function buildPreviewClickTargets(selector: string): Array<{ cssSelector: string; textMatches: string[] }> {
  return splitSelectorList(selector).map(parseContainsSelector);
}

function selectorLooksLikeForm(selector: string): boolean {
  return splitSelectorList(selector)
    .map(parseContainsSelector)
    .map(item => item.cssSelector.trim())
    .filter(Boolean)
    .every(item => /^form(?=[.#:\[\s]|$)/i.test(item));
}

async function enablePreviewSubmitGuard(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__jtrackingPreviewMode = true;
    if (!(window as any).__jtrackingPreviewSubmitGuardInstalled) {
      document.addEventListener('submit', (evt) => {
        if (!(window as any).__jtrackingPreviewMode) return;
        evt.preventDefault();
      }, true);
      (window as any).__jtrackingPreviewSubmitGuardInstalled = true;
    }
  }).catch(() => {});
}

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
  buildPreviewClickTargets,
  selectorLooksLikeForm,
  waitForHitCount,
  eventAppliesToPage,
  normalizeComparableUrl,
  isSameRegistrableDomain,
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

  return true;
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

function getRegistrableDomain(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  const parts = normalized.split('.').filter(Boolean);
  if (parts.length <= 2) return normalized;
  return parts.slice(-2).join('.');
}

function isSameRegistrableDomain(leftUrl: string, rightUrl: string): boolean {
  try {
    const left = new URL(leftUrl);
    const right = new URL(rightUrl);
    return getRegistrableDomain(left.hostname) === getRegistrableDomain(right.hostname);
  } catch {
    return false;
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
        target.dispatchEvent(new SubmitEvent('submit', {
          bubbles: true,
          cancelable: true,
          submitter: null,
        }));
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

  for (let attempt = 1; attempt <= PREVIEW_INJECTION_MAX_ATTEMPTS; attempt++) {
    const scriptState = await page.evaluate(async (args: {
      src: string;
      containerId: string;
      scriptTimeoutMs: number;
    }) => {
      if ((window as any).google_tag_manager?.[args.containerId]) {
        return 'already_ready';
      }

      const existing = Array.from(document.querySelectorAll<HTMLScriptElement>('script[data-jtracking-preview="1"]'))
        .find(script => script.src === args.src);
      if (existing) {
        return await new Promise<'loaded' | 'error' | 'timeout'>(resolve => {
          const timeoutId = window.setTimeout(() => resolve('timeout'), args.scriptTimeoutMs);
          const finish = (value: 'loaded' | 'error' | 'timeout') => {
            window.clearTimeout(timeoutId);
            resolve(value);
          };

          existing.addEventListener('load', () => finish('loaded'), { once: true });
          existing.addEventListener('error', () => finish('error'), { once: true });
        });
      }

      (window as any).dataLayer = (window as any).dataLayer || [];
      (window as any).dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });

      const script = document.createElement('script');
      script.async = false;
      script.src = args.src;
      script.dataset.jtrackingPreview = '1';

      return await new Promise<'loaded' | 'error' | 'timeout'>(resolve => {
        const timeoutId = window.setTimeout(() => resolve('timeout'), args.scriptTimeoutMs);
        const finish = (value: 'loaded' | 'error' | 'timeout') => {
          window.clearTimeout(timeoutId);
          resolve(value);
        };

        script.addEventListener('load', () => finish('loaded'), { once: true });
        script.addEventListener('error', () => finish('error'), { once: true });
        (document.head || document.documentElement).appendChild(script);
      });
    }, {
      src: gtmScriptUrl,
      containerId: gtmPublicId,
      scriptTimeoutMs: PREVIEW_INJECTION_SCRIPT_TIMEOUT_MS,
    }).catch(() => 'error');

    const gtmReady = await page.waitForFunction((containerId: string) => {
      return Boolean((window as any).google_tag_manager?.[containerId]);
    }, gtmPublicId, { timeout: PREVIEW_INJECTION_READY_TIMEOUT_MS }).then(() => true).catch(() => false);

    if (gtmReady) {
      await enablePreviewSubmitGuard(page);
      await page.waitForTimeout(PREVIEW_INJECTION_SETTLE_MS).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
      return true;
    }

    if (attempt < PREVIEW_INJECTION_MAX_ATTEMPTS) {
      console.warn(`    [GTM inject retry ${attempt + 1}/${PREVIEW_INJECTION_MAX_ATTEMPTS}] script=${scriptState}`);
      await page.evaluate((src: string) => {
        for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>('script[data-jtracking-preview="1"]'))) {
          if (script.src === src) script.remove();
        }
      }, gtmScriptUrl).catch(() => {});
      await page.waitForTimeout(500).catch(() => {});
    }
  }

  return false;
}

async function restoreOriginalPage(
  page: Page,
  originalPageUrl: string,
  gtmScriptUrl: string | null,
  gtmPublicId: string,
): Promise<boolean> {
  if (page.isClosed()) return false;

  try {
    await navigateForPreviewPage(page, originalPageUrl, {
      phaseLabel: 'Preview restore',
      primaryTimeoutMs: PREVIEW_RESTORE_TIMEOUT_MS,
      fallbackTimeoutMs: PREVIEW_RESTORE_FALLBACK_TIMEOUT_MS,
      settleMs: PREVIEW_RESTORE_SETTLE_MS,
    });
  } catch {
    return false;
  }

  if (gtmScriptUrl) {
    return injectPreviewContainer(page, gtmScriptUrl, gtmPublicId);
  }

  await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
  return true;
}

async function clickVisibleMatchAt(
  page: Page,
  selector: string,
  candidateIndex: number,
  textMatches: string[] = [],
): Promise<boolean> {
  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);
  if (count <= 0) return false;

  const candidateIndexes: number[] = [];
  for (let i = 0; i < Math.min(count, 8); i++) {
    const candidate = locator.nth(i);
    const matchesText = textMatches.length === 0 || await candidate.evaluate((el, expectedTexts: string[]) => {
      const text = (el.textContent || '').trim();
      return expectedTexts.some(expected => text.includes(expected));
    }, textMatches).catch(() => false);
    if (matchesText) candidateIndexes.push(i);
  }

  if (candidateIndex < 0 || candidateIndex >= candidateIndexes.length) return false;
  const candidate = locator.nth(candidateIndexes[candidateIndex]);
  const isVisible = await candidate.isVisible({ timeout: 2000 }).catch(() => false);
  if (isVisible) {
    const clickedViaPreviewSafeLink = await candidate.evaluate((el) => {
      const linkTarget = el.closest('a[href], area[href]') as HTMLElement | null;
      if (!linkTarget) return false;

      const href = linkTarget.getAttribute('href') || '';
      const rawTarget = (linkTarget.getAttribute('target') || '').trim().toLowerCase();
      const opensNewWindow = rawTarget === '_blank';
      let shouldKeepNavigation = false;

      try {
        const resolvedUrl = new URL((linkTarget as HTMLAnchorElement).href, window.location.href);
        const sameOrigin = resolvedUrl.origin === window.location.origin;
        const httpProtocol = resolvedUrl.protocol === 'http:' || resolvedUrl.protocol === 'https:';
        shouldKeepNavigation = sameOrigin && httpProtocol && !opensNewWindow;
      } catch {
        shouldKeepNavigation = href.startsWith('/') && !opensNewWindow;
      }

      // Let same-origin same-tab links navigate normally. Many SPA sites only
      // complete tracking after router/history updates, so preventing default
      // here can create preview false negatives.
      if (shouldKeepNavigation) {
        return false;
      }

      const rect = linkTarget.getBoundingClientRect();
      const style = window.getComputedStyle(linkTarget);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') {
        return false;
      }

      const preventOnce = (evt: Event) => {
        const eventTarget = evt.target instanceof Element ? evt.target : null;
        if (eventTarget?.closest('a[href], area[href]') === linkTarget) {
          evt.preventDefault();
          linkTarget.removeEventListener('click', preventOnce, true);
        }
      };

      linkTarget.addEventListener('click', preventOnce, true);
      linkTarget.scrollIntoView({ block: 'center', inline: 'center' });
      (linkTarget as HTMLElement).focus?.();

      for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
        linkTarget.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
        }));
      }
      return true;
    }).catch(() => false);

    if (clickedViaPreviewSafeLink) {
      return true;
    }

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
        try {
          await candidate.scrollIntoViewIfNeeded().catch(() => {});
          const box = await candidate.boundingBox();
          if (box && box.width > 0 && box.height > 0) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.up();
            return true;
          }
        } catch {
          // Fall through to the DOM-level fallback below.
        }
      }
    }
  }

  const clickedViaFallback = await candidate.evaluate((el) => {
    const target = (el.closest('a, button, input, label, summary, [role="button"]') || el) as HTMLElement | null;
    if (!target) return false;

    const rect = target.getBoundingClientRect();
    const style = window.getComputedStyle(target);
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') {
      return false;
    }

    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.focus?.();
    if (typeof target.click === 'function') {
      target.click();
      return true;
    }
    for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
      }));
    }
    return true;
  }).catch(() => false);

  return clickedViaFallback;
}

async function clickVisibleMatchesUntilEvent(
  page: Page,
  targets: Array<{ cssSelector: string; textMatches: string[] }>,
  args: {
    beforeHits: number;
    getHitCount: () => number;
    waitMs: number;
    eventName: string;
  },
): Promise<{ clicked: boolean; afterHits: number }> {
  let clicked = false;
  let afterHits = args.beforeHits;
  let attemptedCandidates = 0;

  for (const target of targets) {
    const locator = page.locator(target.cssSelector);
    const count = await locator.count().catch(() => 0);
    const matchingCount = target.textMatches.length === 0
      ? Math.min(count, 8)
      : await locator.evaluateAll((elements, expectedTexts: string[]) => {
        const visibleMatches = elements.filter((el) => {
          const text = (el.textContent || '').trim();
          return expectedTexts.some(expected => text.includes(expected));
        });
        return Math.min(visibleMatches.length, 8);
      }, target.textMatches).catch(() => 0);
    const maxAttempts = Math.min(matchingCount, 8);

    for (let i = 0; i < maxAttempts; i++) {
      const attemptClicked = await clickVisibleMatchAt(page, target.cssSelector, i, target.textMatches);
      if (!attemptClicked) continue;

      clicked = true;
      attemptedCandidates += 1;
      afterHits = await waitForHitCount(args.getHitCount, args.beforeHits, args.waitMs);
      if (afterHits > args.beforeHits) {
        return { clicked, afterHits };
      }

      const remainingCandidates = maxAttempts - (i + 1);
      if (remainingCandidates > 0) {
        console.log(`      schema retry: ${args.eventName} (candidate ${attemptedCandidates + 1}/${attemptedCandidates + remainingCandidates})`);
      }
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
  const interactionOutcomes = new Map<string, InteractionOutcome>();
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
        const eventName = normalizeEventName(params['en'] || params['event_name'] || 'unknown');
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
          await enablePreviewSubmitGuard(page);
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

        const blockNav = async (route: import('playwright').Route) => {
          const req = route.request();
          try {
            if (req.resourceType() === 'document' && !isSameRegistrableDomain(req.url(), pageAnalysis.url)) {
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
                console.warn(`      schema skip: ${event.eventName} (restore failed for ${pageAnalysis.url})`);
                break;
              }
            }

            const beforeHits = getMatchingFiredEvents(event, siteAnalysis.rootUrl, allFiredEvents).length;
            let afterHits = beforeHits;
            let interactionPerformed = false;
            let interactionPrepared = false;
            let interactionClicked = false;

            if (event.triggerType === 'page_view') {
              afterHits = await waitForHitCount(
                () => getMatchingFiredEvents(event, siteAnalysis.rootUrl, allFiredEvents).length,
                beforeHits,
                800,
              );
              interactionPerformed = true;
            } else if (event.triggerType === 'custom') {
              if (event.elementSelector) {
                if (selectorLooksLikeForm(event.elementSelector)) {
                  const cleanSelector = event.elementSelector.replace(/:contains\([^)]*\)/g, '').trim();
                  const filledInputs = await fillNearbyInputsForSelector(page, cleanSelector);
                  if (filledInputs > 0) {
                    interactionPrepared = true;
                    console.log(`      schema prepare: ${event.eventName} (filled ${filledInputs} input${filledInputs > 1 ? 's' : ''})`);
                  }
                  const submitted = await attemptFormSubmit(page, cleanSelector);
                  if (!submitted) {
                    interactionOutcomes.set(eventId, {
                      attempted: true,
                      clicked: false,
                      prepared: interactionPrepared,
                    });
                    console.log(`      schema skip: ${event.eventName}`);
                    continue;
                  }
                  interactionPerformed = true;
                  afterHits = await waitForHitCount(
                    () => getMatchingFiredEvents(event, siteAnalysis.rootUrl, allFiredEvents).length,
                    beforeHits,
                    PREVIEW_SUBMIT_WAIT_MS,
                  );
                } else {
                  const clickTargets = buildPreviewClickTargets(event.elementSelector);
                  const customClickResult = await clickVisibleMatchesUntilEvent(page, clickTargets, {
                    beforeHits,
                    getHitCount: () => getMatchingFiredEvents(event, siteAnalysis.rootUrl, allFiredEvents).length,
                    waitMs: PREVIEW_CUSTOM_CLICK_WAIT_MS,
                    eventName: event.eventName,
                  });
                  afterHits = customClickResult.afterHits;
                  interactionPerformed = customClickResult.clicked;
                  interactionClicked = customClickResult.clicked;
                  if (!customClickResult.clicked) {
                    interactionOutcomes.set(eventId, {
                      attempted: true,
                      clicked: false,
                      prepared: false,
                    });
                    console.log(`      schema skip: ${event.eventName}`);
                    continue;
                  }
                }
              } else {
                afterHits = await attemptCustomEventDetection(page, event, siteAnalysis.rootUrl, allFiredEvents, 800);
                interactionPerformed = true;
              }
            } else if (event.triggerType === 'form_submit' && event.elementSelector) {
              const cleanSelector = event.elementSelector.replace(/:contains\([^)]*\)/g, '').trim();
              const filledInputs = await fillNearbyInputsForSelector(page, cleanSelector);
              if (filledInputs > 0) {
                interactionPrepared = true;
                console.log(`      schema prepare: ${event.eventName} (filled ${filledInputs} input${filledInputs > 1 ? 's' : ''})`);
              }
              const submitted = await attemptFormSubmit(page, cleanSelector);
              if (!submitted) {
                interactionOutcomes.set(eventId, {
                  attempted: true,
                  clicked: false,
                  prepared: interactionPrepared,
                });
                console.log(`      schema skip: ${event.eventName}`);
                continue;
              }
              interactionPerformed = true;
              afterHits = await waitForHitCount(
                () => getMatchingFiredEvents(event, siteAnalysis.rootUrl, allFiredEvents).length,
                beforeHits,
                PREVIEW_SUBMIT_WAIT_MS,
              );
            } else if (event.triggerType === 'click' && event.elementSelector) {
              const clickTargets = buildPreviewClickTargets(event.elementSelector);
              let { clicked, afterHits: clickHits } = await clickVisibleMatchesUntilEvent(page, clickTargets, {
                beforeHits,
                getHitCount: () => getMatchingFiredEvents(event, siteAnalysis.rootUrl, allFiredEvents).length,
                waitMs: PREVIEW_CLICK_WAIT_MS,
                eventName: event.eventName,
              });
              afterHits = clickHits;
              if (clicked) {
                interactionPerformed = true;
                interactionClicked = true;
              }

              if (afterHits <= beforeHits) {
                const fallbackSelector = clickTargets[0]?.cssSelector || event.elementSelector.replace(/:contains\([^)]*\)/g, '').trim();
                const filledInputs = await fillNearbyInputsForSelector(page, fallbackSelector);
                if (filledInputs > 0) {
                  interactionPrepared = true;
                  console.log(`      schema prepare: ${event.eventName} (filled ${filledInputs} input${filledInputs > 1 ? 's' : ''})`);
                  const retryResult = await clickVisibleMatchesUntilEvent(page, clickTargets, {
                    beforeHits,
                    getHitCount: () => getMatchingFiredEvents(event, siteAnalysis.rootUrl, allFiredEvents).length,
                    waitMs: PREVIEW_CLICK_RETRY_WAIT_MS,
                    eventName: event.eventName,
                  });
                  clicked = retryResult.clicked || clicked;
                  if (clicked) {
                    interactionPerformed = true;
                    interactionClicked = true;
                    afterHits = retryResult.afterHits;
                  }
                }
              }

              if (!clicked) {
                interactionOutcomes.set(eventId, {
                  attempted: true,
                  clicked: false,
                  prepared: interactionPrepared,
                });
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

            interactionOutcomes.set(eventId, {
              attempted: true,
              clicked: interactionClicked,
              prepared: interactionPrepared,
            });

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
    const eventId = getEventIdentity(event);
    const interaction = interactionOutcomes.get(eventId);
    const baselineFailure = inferFailureReason(event);
    let failure = baselineFailure;

    if (!fired && baselineFailure.category === 'requires_login') {
      failure = baselineFailure;
    } else if (!fired && interaction?.clicked) {
      failure = {
        reason: 'Preview clicked a matching element, but no GA4 hit was observed. Check GTM trigger filters, URL conditions, and tag firing.',
        category: 'config_error',
      };
    } else if (!fired && interaction?.prepared) {
      failure = {
        reason: 'Preview interacted with nearby inputs, but no matching GA4 hit was observed. Check GTM trigger filters and the actual page URL during interaction.',
        category: 'config_error',
      };
    }

    return {
      event,
      fired,
      firedCount: matchedFired.length,
      firedEvents: matchedFired,
      failureReason: fired ? undefined : failure.reason,
      failureCategory: fired ? undefined : failure.category,
    };
  });

  // Also include any unexpected GA4 events that fired
  const expectedEventNames = new Set(schema.events.map(event => event.eventName));
  const unexpectedFired = allFiredEvents.filter(fe =>
    !expectedEventNames.has(fe.eventName) && !isIgnorableUnexpectedEventName(fe.eventName),
  );
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
