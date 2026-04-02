import { chromium, Page } from 'playwright';
import { GA4Event } from './event-schema';
import { SiteAnalysis } from '../crawler/page-analyzer';

export interface SelectorCheckResult {
  eventName: string;
  selector: string;
  pageUrl: string;
  matched: boolean;
  matchCount: number;
}

const SELECTOR_CHECK_TIMEOUT_MS = 30000;
const SELECTOR_CHECK_FALLBACK_TIMEOUT_MS = 20000;
const SELECTOR_CHECK_SETTLE_MS = 2000;

async function navigateForSelectorCheck(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SELECTOR_CHECK_TIMEOUT_MS });
    await page.waitForTimeout(SELECTOR_CHECK_SETTLE_MS);
  } catch (err) {
    const message = (err as Error).message || '';
    if (!message.includes('Timeout')) throw err;

    console.warn(`  Selector check timeout on ${url}; retrying with commit fallback.`);
    await page.goto(url, { waitUntil: 'commit', timeout: SELECTOR_CHECK_FALLBACK_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }
}

async function isShopifyPasswordPage(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const passwordField = document.querySelector(
      'form[action*="/password"] input[type="password"], input[type="password"][name="password"], #password',
    );
    if (!passwordField) return false;

    const bodyText = (document.body?.innerText || '').toLowerCase();
    return (
      bodyText.includes('password protected') ||
      bodyText.includes('enter store password') ||
      bodyText.includes('use the password to enter the store')
    );
  });
}

async function unlockShopifyStorefrontIfNeeded(page: Page, storefrontPassword?: string): Promise<void> {
  const locked = await isShopifyPasswordPage(page);
  if (!locked || !storefrontPassword) return;

  const passwordInput = page
    .locator('form[action*="/password"] input[type="password"], input[type="password"][name="password"], #password')
    .first();
  const submitButton = page
    .locator('form[action*="/password"] button[type="submit"], form[action*="/password"] input[type="submit"]')
    .first();

  if ((await passwordInput.count()) === 0) return;

  await passwordInput.fill(storefrontPassword);

  const unlockWait = page.waitForFunction(() => {
    const passwordField = document.querySelector(
      'form[action*="/password"] input[type="password"], input[type="password"][name="password"], #password',
    );
    const bodyText = (document.body?.innerText || '').toLowerCase();
    return !passwordField || (
      !bodyText.includes('password protected') &&
      !bodyText.includes('enter store password') &&
      !bodyText.includes('use the password to enter the store')
    );
  }, { timeout: 10000 }).catch(() => null);

  if ((await submitButton.count()) > 0) {
    await submitButton.click();
  } else {
    await passwordInput.press('Enter');
  }

  await unlockWait;
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(SELECTOR_CHECK_SETTLE_MS);
}

/**
 * Visits representative pages and checks whether each click/form_submit
 * event's elementSelector actually matches any DOM element.
 */
export async function checkSelectors(
  events: GA4Event[],
  analysis: SiteAnalysis,
  storefrontPassword?: string,
): Promise<SelectorCheckResult[]> {
  const clickEvents = events.filter(
    e => (e.triggerType === 'click' || e.triggerType === 'form_submit') && e.elementSelector
  );

  if (clickEvents.length === 0) return [];

  // Build a map: for each event, pick a representative URL to test against
  const eventPages = new Map<string, string>();
  for (const event of clickEvents) {
    if (event.pageUrlPattern) {
      const matching = analysis.pages.find(p => {
        try { return new RegExp(event.pageUrlPattern!).test(p.url); } catch { return false; }
      });
      eventPages.set(event.eventName, matching?.url || analysis.rootUrl);
    } else {
      eventPages.set(event.eventName, analysis.rootUrl);
    }
  }

  // Deduplicate URLs to minimize page loads
  const uniqueUrls = [...new Set(eventPages.values())];
  const urlEventsMap = new Map<string, GA4Event[]>();
  for (const event of clickEvents) {
    const url = eventPages.get(event.eventName)!;
    if (!urlEventsMap.has(url)) urlEventsMap.set(url, []);
    urlEventsMap.get(url)!.push(event);
  }

  const results: SelectorCheckResult[] = [];
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();

    for (const [url, urlEvents] of urlEventsMap) {
      try {
        await navigateForSelectorCheck(page, url);
        await unlockShopifyStorefrontIfNeeded(page, storefrontPassword);

        for (const event of urlEvents) {
          // Strip :contains() for the DOM check (GTM also strips it)
          const cleanSelector = event.elementSelector!
            .replace(/:contains\([^)]*\)/g, '')
            .trim();

          let matchCount = 0;
          try {
            matchCount = await page.evaluate((sel: string) => {
              try { return document.querySelectorAll(sel).length; } catch { return 0; }
            }, cleanSelector);
          } catch {
            matchCount = 0;
          }

          results.push({
            eventName: event.eventName,
            selector: event.elementSelector!,
            pageUrl: url,
            matched: matchCount > 0,
            matchCount,
          });
        }
      } catch {
        for (const event of urlEvents) {
          results.push({
            eventName: event.eventName,
            selector: event.elementSelector!,
            pageUrl: url,
            matched: false,
            matchCount: 0,
          });
        }
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}
