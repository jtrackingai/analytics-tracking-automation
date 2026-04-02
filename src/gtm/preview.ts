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
  results: TagVerificationResult[];
  totalExpected: number;
  totalFired: number;
  totalFailed: number;
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
}

export async function checkGTMOnPage(url: string, expectedPublicId: string): Promise<GTMCheckResult> {
  const browser: Browser = await chromium.launch({ headless: true });
  const loadedContainerIds: string[] = [];

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    await context.route('**googletagmanager.com/gtm.js**', async (route, request) => {
      const reqUrl = new URL(request.url());
      const id = reqUrl.searchParams.get('id');
      if (id && !loadedContainerIds.includes(id)) loadedContainerIds.push(id);
      await route.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await context.close();
  } finally {
    await browser.close();
  }

  return {
    siteLoadsGTM: loadedContainerIds.length > 0,
    loadedContainerIds,
    hasExpectedContainer: loadedContainerIds.includes(expectedPublicId),
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

async function injectPreviewContainer(page: Page, gtmScriptUrl: string | null, gtmPublicId: string): Promise<void> {
  if (!gtmScriptUrl || page.isClosed()) return;

  await page.evaluate((args: { src: string; containerId: string }) => {
    if ((window as any).google_tag_manager?.[args.containerId]) return;
    (window as any).dataLayer = (window as any).dataLayer || [];
    (window as any).dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    const s = document.createElement('script');
    s.async = false;
    s.src = args.src;
    (document.head || document.documentElement).appendChild(s);
  }, { src: gtmScriptUrl, containerId: gtmPublicId }).catch(() => {});

  await new Promise<void>(resolve => setTimeout(resolve, 4000));
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
}

async function restoreOriginalPage(
  page: Page,
  originalPageUrl: string,
  gtmScriptUrl: string | null,
  gtmPublicId: string,
): Promise<void> {
  if (page.isClosed()) return;

  if (page.url() !== originalPageUrl) {
    await page.goto(originalPageUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    await injectPreviewContainer(page, gtmScriptUrl, gtmPublicId);
    return;
  }

  if (!gtmScriptUrl) {
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await new Promise<void>(resolve => setTimeout(resolve, 500));
  }
}

async function clickFirstVisibleMatch(page: Page, selector: string): Promise<boolean> {
  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);

  for (let i = 0; i < Math.min(count, 5); i++) {
    const candidate = locator.nth(i);
    const isVisible = await candidate.isVisible({ timeout: 2000 }).catch(() => false);
    if (!isVisible) continue;

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
        // Try the next visible candidate.
      }
    }
  }

  return false;
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

export async function runPreviewVerification(
  siteAnalysis: SiteAnalysis,
  schema: EventSchema,
  client: GTMClient,
  accountId: string,
  containerId: string,
  workspaceId: string,
  gtmPublicId: string, // GTM-XXXXXX
  injectGTM: boolean = false
): Promise<PreviewResult> {
  const startedAt = new Date().toISOString();
  const managedEvents = schema.events.filter(event => !isRedundantAutoEvent(event));
  const shouldSimulateScroll = managedEvents.some(event => event.triggerType === 'scroll');

  // Enable GTM preview mode
  console.log('  Enabling GTM Quick Preview...');
  await client.quickPreview(accountId, containerId, workspaceId);

  // Get preview environment auth params for client-side GTM preview URL injection
  let previewUrlParams: string | null = null;
  if (injectGTM) {
    console.log('  Fetching GTM preview environment token...');
    const previewEnv = await client.getPreviewEnvironment(accountId, containerId, workspaceId);
    if (previewEnv) {
      previewUrlParams = `gtm_preview=${previewEnv.gtmPreview}&gtm_auth=${previewEnv.gtmAuth}`;
      console.log(`  ✅ Preview env: ${previewEnv.gtmPreview}`);
    } else {
      console.log(`  ⚠️  No preview environment found — injecting GTM without preview params (will load published version only)`);
    }
  }

  const allFiredEvents: FiredEvent[] = [];
  const browser: Browser = await chromium.launch({ headless: true });

  // Build GTM script URL (with or without preview params)
  let gtmScriptUrl: string | null = null;
  if (injectGTM && gtmPublicId && gtmPublicId !== 'UNKNOWN') {
    gtmScriptUrl = previewUrlParams
      ? `https://www.googletagmanager.com/gtm.js?id=${gtmPublicId}&${previewUrlParams}`
      : `https://www.googletagmanager.com/gtm.js?id=${gtmPublicId}`;
    console.log(`  💉 GTM container ${gtmPublicId} will be injected per-page${previewUrlParams ? ' (with preview params)' : ''}...`);
  }

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

    // Helper: append GTM preview URL params when injecting GTM so the workspace version loads
    function buildPageUrl(originalUrl: string): string {
      if (!injectGTM || !previewUrlParams) return originalUrl;
      const separator = originalUrl.includes('?') ? '&' : '?';
      return `${originalUrl}${separator}${previewUrlParams}`;
    }

    // Visit each page and simulate interactions
    for (const pageAnalysis of siteAnalysis.pages) {
      const page = await context.newPage();
      console.log(`  Verifying: ${pageAnalysis.url}`);

      try {
        await page.goto(buildPageUrl(pageAnalysis.url), { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (page.isClosed()) continue;
        console.log(`    [page loaded]`);

        // Inject GTM after DOM is ready (so document.head exists for script insertion)
        if (gtmScriptUrl) {
          await injectPreviewContainer(page, gtmScriptUrl, gtmPublicId);
          console.log(`    [GTM injected]`);
        } else {
          await new Promise<void>(resolve => setTimeout(resolve, 2000));
        }
        if (page.isClosed()) continue;

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
          await new Promise<void>(resolve => setTimeout(resolve, 1000));
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

        const originalPageUrl = buildPageUrl(pageAnalysis.url);
        const clickableElements = pageAnalysis.elements.filter(e =>
          e.isVisible &&
          (e.type === 'button' || e.type === 'link') &&
          e.text && e.text.length < 80
        ).slice(0, 5);

        console.log(`    [clicking ${clickableElements.length} elements]`);
        for (const el of clickableElements) {
          if (page.isClosed()) break;
          try {
            // Always start from original page for each click (avoids pending-navigation state)
            await restoreOriginalPage(page, originalPageUrl, gtmScriptUrl, gtmPublicId);
            if (page.isClosed()) break;

            const cssSelector = el.selector.replace(/:contains\(".*?"\)/, '').trim();
            // Use accessible role + exact name matching to avoid selecting wrong element
            // when multiple elements share the same CSS selector (e.g. two buttons with same classes)
            let locator;
            if (el.text && el.type === 'button') {
              locator = page.getByRole('button', { name: el.text, exact: true });
            } else if (el.text && el.type === 'link') {
              locator = page.getByRole('link', { name: el.text, exact: true });
            } else {
              locator = page.locator(cssSelector).first();
            }
            const isVisible = await locator.isVisible({ timeout: 3000 }).catch(() => false);
            if (!isVisible) { console.log(`      skip (not visible): ${el.text?.slice(0, 30)}`); continue; }

            console.log(`      click: ${el.text?.slice(0, 30)}`);
            await locator.click({ timeout: 2000, force: false, noWaitAfter: true }).catch(() => {});
            // Pure Node timer — no Playwright calls while page may be navigating
            await new Promise<void>(resolve => setTimeout(resolve, 800));
            console.log(`      click done: ${el.text?.slice(0, 30)}`);
          } catch {
            // Ignore interaction errors
          }
        }

        const schemaClickEvents = managedEvents.filter(event =>
          event.triggerType === 'click' &&
          event.elementSelector &&
          eventAppliesToPage(event, pageAnalysis.url, siteAnalysis.rootUrl)
        );

        console.log(`    [schema clicks ${schemaClickEvents.length}]`);
        for (const event of schemaClickEvents) {
          if (page.isClosed()) break;
          try {
            await restoreOriginalPage(page, originalPageUrl, gtmScriptUrl, gtmPublicId);
            if (page.isClosed()) break;

            const cleanSelector = event.elementSelector!.replace(/:contains\([^)]*\)/g, '').trim();
            const beforeHits = allFiredEvents.filter(fe => fe.eventName === event.eventName).length;

            let clicked = await clickFirstVisibleMatch(page, cleanSelector);
            if (clicked) {
              await new Promise<void>(resolve => setTimeout(resolve, 1500));
            }

            let afterHits = allFiredEvents.filter(fe => fe.eventName === event.eventName).length;
            if (afterHits <= beforeHits) {
              const filledInputs = await fillNearbyInputsForSelector(page, cleanSelector);
              if (filledInputs > 0) {
                console.log(`      schema prepare: ${event.eventName} (filled ${filledInputs} input${filledInputs > 1 ? 's' : ''})`);
                await new Promise<void>(resolve => setTimeout(resolve, 500));
                clicked = await clickFirstVisibleMatch(page, cleanSelector) || clicked;
                if (clicked) {
                  await new Promise<void>(resolve => setTimeout(resolve, 1500));
                }
                afterHits = allFiredEvents.filter(fe => fe.eventName === event.eventName).length;
              }
            }

            if (!clicked) {
              console.log(`      schema skip: ${event.eventName}`);
              continue;
            }

            if (afterHits > beforeHits) {
              console.log(`      schema click: ${event.eventName}`);
            } else {
              console.log(`      schema no hit: ${event.eventName}`);
            }
          } catch {
            // Ignore interaction errors
          }
        }

        await page.unroute('**', blockNav).catch(() => {});

        await new Promise<void>(resolve => setTimeout(resolve, 2000));
      } catch (err) {
        console.warn(`  Warning: Failed to verify ${pageAnalysis.url}: ${(err as Error).message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }

    await context.close().catch(() => {});
  } finally {
    await browser.close();
  }

  // Match fired events against expected events
  const results: TagVerificationResult[] = managedEvents.map(event => {
    const matchedFired = allFiredEvents.filter(fe => fe.eventName === event.eventName);
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
  const expectedEventNames = new Set(managedEvents.map(e => e.eventName));
  const unexpectedFired = allFiredEvents.filter(fe => !expectedEventNames.has(fe.eventName));
  if (unexpectedFired.length > 0) {
    console.log(`  ℹ️  ${unexpectedFired.length} additional events fired (not in schema): ${[...new Set(unexpectedFired.map(e => e.eventName))].join(', ')}`);
  }

  const totalFired = results.filter(r => r.fired).length;
  const totalFailed = results.filter(r => !r.fired).length;

  return {
    siteUrl: siteAnalysis.rootUrl,
    previewStartedAt: startedAt,
    previewEndedAt: new Date().toISOString(),
    gtmContainerId: gtmPublicId,
    results,
    totalExpected: schema.events.length,
    totalFired,
    totalFailed,
  };
}
