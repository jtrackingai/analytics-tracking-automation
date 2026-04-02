import { chromium, Browser, Page, Response } from 'playwright';
import {
  extractDomain, isSameDomain, normalizeUrl, getSectionPrefix,
  sampleUrlsBySection, detectEcommerceSite, reorderForEcommerce,
  discoverNavLinks, discoverAllLinks,
} from './url-utils';
import { extractCleanedHtml } from './html-cleaner';
import { removeContentDuplicates } from './content-dedup';
import {
  SitePlatform,
  detectPlatformOnPage,
  mergePlatformDetections,
  makeGenericPlatform,
} from './platform-detector';

// ─── Type definitions ─────────────────────────────────────────────────────────

export interface InteractiveElement {
  type: 'button' | 'link' | 'form' | 'input' | 'select' | 'video' | 'nav' | 'custom';
  selector: string;
  text?: string;
  href?: string;
  formAction?: string;
  formMethod?: string;
  inputType?: string;
  ariaLabel?: string;
  dataAttributes: Record<string, string>;
  isVisible: boolean;
  parentSection?: 'header' | 'footer' | 'nav' | 'main' | 'aside' | 'article';
}

export interface PageAnalysis {
  url: string;
  title: string;
  description?: string;
  elements: InteractiveElement[];
  hasSearchForm: boolean;
  hasVideoPlayer: boolean;
  hasInfiniteScroll: boolean;
  isSPA: boolean;
  sectionClasses: string[];
  cleanedHtml: string;
}

export type PageContentType =
  | 'landing'
  | 'marketing'
  | 'legal'
  | 'blog'
  | 'case_study'
  | 'documentation'
  | 'about'
  | 'global'
  | 'other';

export interface PageGroup {
  name: string;
  displayName: string;
  description: string;
  contentType: PageContentType;
  urls: string[];
  urlPattern: string;
  representativeHtml?: string;
}

export interface DataLayerEvent {
  event: string;
  keys: string[];
  pageUrl: string;
}

export interface SiteAnalysis {
  rootUrl: string;
  rootDomain: string;
  platform: SitePlatform;
  pages: PageAnalysis[];
  pageGroups: PageGroup[];
  discoveredUrls: string[];
  skippedUrls: string[];
  crawlWarnings: string[];
  dataLayerEvents: DataLayerEvent[];
}

export interface CrawlOptions {
  mode: 'full' | 'partial';
  urls?: string[];
  storefrontPassword?: string;
}

interface VisitResult {
  analysis: PageAnalysis | null;
  discoveredLinks: string[];
  wafDetected: boolean;
  dataLayerEvents: DataLayerEvent[];
  platform: SitePlatform;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const CRAWL_MAX_TOTAL        = 40;
export const CRAWL_MAX_PER_SECTION  = 5;
export const CRAWL_MAX_PARTIAL_URLS = 20;

// ─── WAF / bot-protection detection ──────────────────────────────────────────

const WAF_CHALLENGE_SELECTORS = [
  '#challenge-form',
  '#challenge-running',
  '#cf-challenge-running',
  '.cf-browser-verification',
  '#px-captcha',
  '.g-recaptcha',
  '#captcha-form',
].join(', ');

const NAVIGATION_TIMEOUT_MS = 30000;
const FALLBACK_COMMIT_TIMEOUT_MS = 20000;
const DEFAULT_SETTLE_MS = 1500;
const FALLBACK_SETTLE_MS = 4000;

async function detectWaf(page: Page, httpStatus: number): Promise<boolean> {
  if (httpStatus === 403 || httpStatus === 503) return true;

  return page.evaluate((selectors: string) => {
    const title = document.title.toLowerCase();
    const bodyText = (document.body?.innerText || '').substring(0, 2000).toLowerCase();
    const combined = `${title} ${bodyText}`;

    const signatures = [
      'just a moment', 'checking your browser', 'attention required',
      'cloudflare', 'please verify you are a human', 'access denied',
      'bot detection', 'ddos-guard', 'sucuri website firewall',
    ];

    const hasChallengeElement = !!document.querySelector(selectors);
    return hasChallengeElement || signatures.some(sig => combined.includes(sig));
  }, WAF_CHALLENGE_SELECTORS);
}

async function navigateForAnalysis(page: Page, url: string): Promise<Response | null> {
  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await page.waitForTimeout(DEFAULT_SETTLE_MS);
    return response;
  } catch (err) {
    const message = (err as Error).message || '';
    if (!message.includes('Timeout')) throw err;

    console.warn(`  Navigation timeout on ${url}; retrying with commit fallback.`);

    const response = await page.goto(url, {
      waitUntil: 'commit',
      timeout: FALLBACK_COMMIT_TIMEOUT_MS,
    });

    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(FALLBACK_SETTLE_MS);
    return response;
  }
}

// ─── Page content extraction ──────────────────────────────────────────────────

async function extractPageContent(page: Page, url: string): Promise<PageAnalysis> {
  const analysis = await page.evaluate(() => {
    const elements: InteractiveElement[] = [];

    function getDataAttributes(el: Element): Record<string, string> {
      const attrs: Record<string, string> = {};
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('data-')) attrs[attr.name] = attr.value;
      }
      return attrs;
    }

    function isElementVisible(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0'
      );
    }

    function makeSelector(el: Element): string {
      if (el.id) return `#${el.id}`;
      if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
      if (el.getAttribute('data-tracking')) return `[data-tracking="${el.getAttribute('data-tracking')}"]`;
      const tag = el.tagName.toLowerCase();
      const classes = Array.from(el.classList).slice(0, 2).join('.');
      const text = el.textContent?.trim().slice(0, 30);
      if (text) return `${tag}${classes ? '.' + classes : ''}:contains("${text}")`;
      return `${tag}${classes ? '.' + classes : ''}`;
    }

    const SECTION_TAGS = ['header', 'footer', 'nav', 'main', 'aside', 'article'];
    function getParentSection(el: Element): string | undefined {
      let cur = el.parentElement;
      while (cur && cur !== document.body) {
        const tag = cur.tagName.toLowerCase();
        if (SECTION_TAGS.includes(tag)) return tag;
        if (cur.getAttribute('role') === 'navigation') return 'nav';
        if (cur.getAttribute('role') === 'banner') return 'header';
        if (cur.getAttribute('role') === 'contentinfo') return 'footer';
        cur = cur.parentElement;
      }
      return undefined;
    }

    // Buttons
    document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach(el => {
      elements.push({
        type: 'button',
        selector: makeSelector(el),
        text: el.textContent?.trim() || (el as HTMLInputElement).value || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        dataAttributes: getDataAttributes(el),
        isVisible: isElementVisible(el),
        parentSection: getParentSection(el) as any,
      });
    });

    // Links
    document.querySelectorAll('a[href]').forEach(el => {
      const href = (el as HTMLAnchorElement).href;
      elements.push({
        type: 'link',
        selector: makeSelector(el),
        text: el.textContent?.trim() || undefined,
        href,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        dataAttributes: getDataAttributes(el),
        isVisible: isElementVisible(el),
        parentSection: getParentSection(el) as any,
      });
    });

    // Forms
    document.querySelectorAll('form').forEach(el => {
      const form = el as HTMLFormElement;
      elements.push({
        type: 'form',
        selector: makeSelector(el),
        formAction: form.action || undefined,
        formMethod: form.method || 'get',
        dataAttributes: getDataAttributes(el),
        isVisible: isElementVisible(el),
        parentSection: getParentSection(el) as any,
      });
    });

    // Inputs
    document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select').forEach(el => {
      const input = el as HTMLInputElement;
      elements.push({
        type: el.tagName.toLowerCase() === 'select' ? 'select' : 'input',
        selector: makeSelector(el),
        inputType: input.type || el.tagName.toLowerCase(),
        ariaLabel: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || undefined,
        dataAttributes: getDataAttributes(el),
        isVisible: isElementVisible(el),
        parentSection: getParentSection(el) as any,
      });
    });

    // Videos
    document.querySelectorAll('video, iframe[src*="youtube"], iframe[src*="vimeo"]').forEach(el => {
      elements.push({
        type: 'video',
        selector: makeSelector(el),
        dataAttributes: getDataAttributes(el),
        isVisible: isElementVisible(el),
        parentSection: getParentSection(el) as any,
      });
    });

    // Navigation
    document.querySelectorAll('nav, [role="navigation"]').forEach(el => {
      elements.push({
        type: 'nav',
        selector: makeSelector(el),
        text: el.getAttribute('aria-label') || undefined,
        dataAttributes: getDataAttributes(el),
        isVisible: isElementVisible(el),
        parentSection: getParentSection(el) as any,
      });
    });

    const hasSearchForm    = !!document.querySelector('input[type="search"], input[name="q"], input[name="search"], [role="search"]');
    const hasVideoPlayer   = !!document.querySelector('video, iframe[src*="youtube"], iframe[src*="vimeo"], .video-player');
    const hasInfiniteScroll = !!document.querySelector('[data-infinite-scroll], .infinite-scroll, [data-load-more]');
    const isSPA = !!(window as any).__NEXT_DATA__ || !!(window as any).__nuxt || !!(window as any).angular || !!document.querySelector('[data-reactroot], [ng-version]');

    const classSet = new Set();
    document.querySelectorAll(
      'body > div, body > main, body > section, body > header, body > footer, body > nav, body > article, main > *, [role="main"] > *'
    ).forEach(el => el.classList.forEach(cls => classSet.add(cls)));
    const sectionClasses = Array.from(classSet) as string[];

    return {
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.getAttribute('content') || undefined,
      elements,
      hasSearchForm,
      hasVideoPlayer,
      hasInfiniteScroll,
      isSPA,
      sectionClasses,
    };
  });

  const cleanedHtml = await extractCleanedHtml(page);
  return { url, ...analysis, cleanedHtml };
}

function isLoginPage(analysis: PageAnalysis): boolean {
  return analysis.elements.some(el =>
    el.type === 'input' &&
    (el.inputType === 'password' || el.ariaLabel?.toLowerCase().includes('password')),
  );
}

async function isShopifyPasswordPage(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const hasPasswordForm = !!document.querySelector(
      'form[action*="/password"] input[type="password"], input[type="password"][name="password"], #password',
    );
    if (!hasPasswordForm) return false;

    const bodyText = (document.body?.innerText || '').toLowerCase();
    return (
      bodyText.includes('password protected') ||
      bodyText.includes('enter store password') ||
      bodyText.includes('use the password to enter the store')
    );
  });
}

type StorefrontUnlockResult = 'not_required' | 'unlocked' | 'missing_password' | 'failed';

async function unlockShopifyStorefrontIfNeeded(
  page: Page,
  storefrontPassword?: string,
): Promise<StorefrontUnlockResult> {
  const locked = await isShopifyPasswordPage(page);
  if (!locked) return 'not_required';
  if (!storefrontPassword) return 'missing_password';

  const passwordInput = page
    .locator('form[action*="/password"] input[type="password"], input[type="password"][name="password"], #password')
    .first();
  const submitButton = page
    .locator('form[action*="/password"] button[type="submit"], form[action*="/password"] input[type="submit"]')
    .first();

  if ((await passwordInput.count()) === 0) return 'failed';

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
  await page.waitForTimeout(DEFAULT_SETTLE_MS);

  return (await isShopifyPasswordPage(page)) ? 'failed' : 'unlocked';
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function analyzeSite(
  rootUrl: string,
  options: CrawlOptions = { mode: 'full' },
): Promise<SiteAnalysis> {
  const rootDomain = extractDomain(rootUrl);
  const crawlWarnings: string[] = [];
  let storefrontPasswordWarningShown = false;

  function noteStorefrontPasswordIssue(message: string): void {
    if (storefrontPasswordWarningShown) return;
    crawlWarnings.push(message);
    storefrontPasswordWarningShown = true;
  }

  if (options.mode === 'partial') {
    const urls = options.urls ?? [];

    if (urls.length === 0) {
      throw new Error('Partial mode requires at least one URL.');
    }
    if (urls.length > CRAWL_MAX_PARTIAL_URLS) {
      throw new Error(
        `Partial mode accepts at most ${CRAWL_MAX_PARTIAL_URLS} URLs per call (got ${urls.length}). ` +
        `Split into batches or use full-site mode instead.`,
      );
    }
    const offDomain = urls.filter(u => {
      const clean = normalizeUrl(u, rootUrl);
      return !clean || !isSameDomain(clean, rootDomain);
    });
    if (offDomain.length > 0) {
      throw new Error(
        `The following URLs are off-domain (expected domain: ${rootDomain}):\n` +
        offDomain.map(u => `  ${u}`).join('\n'),
      );
    }
  }

  const browser: Browser = await chromium.launch({ headless: true });
  const pages: PageAnalysis[] = [];
  const skippedUrls: string[] = [];
  const visitedUrls = new Set<string>();
  const collectedDLEvents: DataLayerEvent[] = [];
  const detectedPlatforms: SitePlatform[] = [];
  let wafBlockedCount = 0;

  async function visitUrl(
    context: Awaited<ReturnType<Browser['newContext']>>,
    url: string,
    opts?: { discoverLinks?: boolean },
  ): Promise<VisitResult> {
    if (visitedUrls.has(url)) {
      return {
        analysis: null,
        discoveredLinks: [],
        wafDetected: false,
        dataLayerEvents: [],
        platform: makeGenericPlatform(),
      };
    }
    visitedUrls.add(url);

    const p = await context.newPage();
    try {
      console.log(`  Analyzing: ${url}`);

      await p.addInitScript(() => {
        (window as any).__dl_captured = [] as Array<{ event: string; keys: string[] }>;
        const orig = Array.prototype.push;
        const hook = function (this: any[], ...args: any[]) {
          for (const obj of args) {
            if (obj && typeof obj === 'object' && typeof obj.event === 'string') {
              (window as any).__dl_captured.push({
                event: obj.event,
                keys: Object.keys(obj).filter((k: string) => k !== 'event'),
              });
            }
          }
          return orig.apply(this, args);
        };
        Object.defineProperty(window, 'dataLayer', {
          configurable: true,
          set(arr) {
            if (Array.isArray(arr)) arr.push = hook;
            Object.defineProperty(window, 'dataLayer', { value: arr, writable: true, configurable: true });
          },
          get() { return undefined; },
        });
        if (Array.isArray((window as any).dataLayer)) {
          (window as any).dataLayer.push = hook;
        }
      });

      const response = await navigateForAnalysis(p, url);

      const status = response?.status() ?? 200;
      const wafBlocked = await detectWaf(p, status);
      if (wafBlocked) {
        skippedUrls.push(url);
        wafBlockedCount++;
        console.log(`  Blocked (WAF/bot protection): ${url}`);
        return {
          analysis: null,
          discoveredLinks: [],
          wafDetected: true,
          dataLayerEvents: [],
          platform: makeGenericPlatform(),
        };
      }

      const unlockResult = await unlockShopifyStorefrontIfNeeded(p, options.storefrontPassword);
      if (unlockResult === 'missing_password') {
        skippedUrls.push(url);
        noteStorefrontPasswordIssue(
          'Shopify storefront password page detected. Re-run analyze with --storefront-password or set SHOPIFY_STOREFRONT_PASSWORD.',
        );
        console.log(`  Skipped (Shopify storefront password required): ${url}`);
        return {
          analysis: null,
          discoveredLinks: [],
          wafDetected: false,
          dataLayerEvents: [],
          platform: makeGenericPlatform(),
        };
      }
      if (unlockResult === 'failed') {
        skippedUrls.push(url);
        noteStorefrontPasswordIssue(
          'A Shopify storefront password was provided, but the storefront remained locked. Verify the password and try analyze again.',
        );
        console.log(`  Skipped (Shopify storefront unlock failed): ${url}`);
        return {
          analysis: null,
          discoveredLinks: [],
          wafDetected: false,
          dataLayerEvents: [],
          platform: makeGenericPlatform(),
        };
      }

      const platform = await detectPlatformOnPage(p);
      const analysis = await extractPageContent(p, url);

      if (isLoginPage(analysis)) {
        skippedUrls.push(url);
        console.log(`  Skipped (login page): ${url}`);
        return {
          analysis: null,
          discoveredLinks: [],
          wafDetected: false,
          dataLayerEvents: [],
          platform,
        };
      }

      const dlEvents: DataLayerEvent[] = await p.evaluate((pageUrl: string) => {
        const captured = (window as any).__dl_captured || [];
        return captured.map((e: any) => ({ event: e.event, keys: e.keys, pageUrl }));
      }, url);

      let discoveredLinks: string[] = [];
      if (opts?.discoverLinks) {
        discoveredLinks = await discoverAllLinks(p, url, rootDomain);
        discoveredLinks = discoveredLinks.filter(u => !visitedUrls.has(u));
      }

      return { analysis, discoveredLinks, wafDetected: false, dataLayerEvents: dlEvents, platform };
    } catch (err) {
      skippedUrls.push(url);
      console.warn(`  Failed: ${url} — ${(err as Error).message}`);
      return {
        analysis: null,
        discoveredLinks: [],
        wafDetected: false,
        dataLayerEvents: [],
        platform: makeGenericPlatform(),
      };
    } finally {
      await p.close();
    }
  }

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; EventTrackingSkill/1.0)',
    });

    if (options.mode === 'partial') {
      const normalizedUrls = (options.urls ?? [])
        .map(u => normalizeUrl(u, rootUrl))
        .filter((u): u is string => u !== null);

      for (const url of normalizedUrls) {
        const result = await visitUrl(context, url);
        if (result.analysis) pages.push(result.analysis);
        collectedDLEvents.push(...result.dataLayerEvents);
        detectedPlatforms.push(result.platform);
      }

    } else {
      // ── Full mode: Navigation-first + 2-level section sampling ──────────────

      const rootPage = await context.newPage();
      console.log(`  Analyzing: ${rootUrl}`);

      const rootResponse = await navigateForAnalysis(rootPage, rootUrl);
      visitedUrls.add(rootUrl);

      const rootStatus = rootResponse?.status() ?? 200;
      const rootWafBlocked = await detectWaf(rootPage, rootStatus);

      if (rootWafBlocked) {
        wafBlockedCount++;
        skippedUrls.push(rootUrl);
        console.log(`  Blocked (WAF/bot protection): ${rootUrl}`);
        await rootPage.close();
      } else {
        const rootUnlockResult = await unlockShopifyStorefrontIfNeeded(rootPage, options.storefrontPassword);
        if (rootUnlockResult === 'missing_password') {
          skippedUrls.push(rootUrl);
          noteStorefrontPasswordIssue(
            'Shopify storefront password page detected. Re-run analyze with --storefront-password or set SHOPIFY_STOREFRONT_PASSWORD.',
          );
          console.log(`  Skipped (Shopify storefront password required): ${rootUrl}`);
          await rootPage.close();
        } else if (rootUnlockResult === 'failed') {
          skippedUrls.push(rootUrl);
          noteStorefrontPasswordIssue(
            'A Shopify storefront password was provided, but the storefront remained locked. Verify the password and try analyze again.',
          );
          console.log(`  Skipped (Shopify storefront unlock failed): ${rootUrl}`);
          await rootPage.close();
        } else {
        const rootPlatform = await detectPlatformOnPage(rootPage);
        const rootAnalysis = await extractPageContent(rootPage, rootUrl);
        pages.push(rootAnalysis);
        detectedPlatforms.push(rootPlatform);

        const navLinks = await discoverNavLinks(rootPage, rootUrl, rootDomain);
        const allLinks = await discoverAllLinks(rootPage, rootUrl, rootDomain);
        await rootPage.close();

        const allDiscovered = [...navLinks, ...allLinks];
        const isEcommerce = detectEcommerceSite(allDiscovered);
        if (isEcommerce) {
          console.log('  Detected e-commerce site — prioritizing category/listing pages.');
        }

        const navSet = new Set(navLinks);
        let level1Candidates = [
          ...navLinks,
          ...allLinks.filter(u => !navSet.has(u)),
        ].filter(u => u !== rootUrl && !visitedUrls.has(u));

        if (isEcommerce) {
          level1Candidates = reorderForEcommerce(level1Candidates);
        }

        const level1Urls = sampleUrlsBySection(
          level1Candidates,
          CRAWL_MAX_PER_SECTION,
          CRAWL_MAX_TOTAL - pages.length,
        );

        const level2Candidates: string[] = [];

        for (const url of level1Urls) {
          if (pages.length >= CRAWL_MAX_TOTAL) break;
          const result = await visitUrl(context, url, { discoverLinks: true });
          if (result.analysis) {
            pages.push(result.analysis);
            level2Candidates.push(...result.discoveredLinks);
          }
          collectedDLEvents.push(...result.dataLayerEvents);
          detectedPlatforms.push(result.platform);
        }

        if (pages.length < CRAWL_MAX_TOTAL && level2Candidates.length > 0) {
          let level2Filtered = level2Candidates.filter(u => !visitedUrls.has(u));

          if (isEcommerce) {
            level2Filtered = reorderForEcommerce(level2Filtered);
          }

          const level2Urls = sampleUrlsBySection(
            level2Filtered,
            CRAWL_MAX_PER_SECTION,
            CRAWL_MAX_TOTAL - pages.length,
          );

          for (const url of level2Urls) {
            if (pages.length >= CRAWL_MAX_TOTAL) break;
            const result = await visitUrl(context, url);
            if (result.analysis) pages.push(result.analysis);
            collectedDLEvents.push(...result.dataLayerEvents);
            detectedPlatforms.push(result.platform);
          }
        }

        const beforeDedup = pages.length;
        const deduped = removeContentDuplicates(pages);
        if (deduped.length < beforeDedup) {
          console.log(`  Removed ${beforeDedup - deduped.length} content-duplicate page(s).`);
          pages.length = 0;
          pages.push(...deduped);
        }
        }
      }
    }

    await context.close();
  } finally {
    await browser.close();
  }

  if (wafBlockedCount > 0) {
    crawlWarnings.push(
      `${wafBlockedCount} page(s) were blocked by WAF or bot protection (e.g. Cloudflare, CAPTCHA). ` +
      'Consider allowlisting the crawler user-agent or IP in your site\'s firewall settings.',
    );
  }

  if (pages.length === 0) {
    crawlWarnings.push(
      'No pages were successfully analyzed. This may indicate WAF or bot-protection blocking the crawler. ' +
      'Verify the site URL, ensure HTTPS is used, and consider allowlisting the crawler IP.',
    );
  }

  const discoveredUrls = Array.from(visitedUrls).filter(u => u !== rootUrl);

  const dlSeen = new Set<string>();
  const uniqueDLEvents = collectedDLEvents.filter(e => {
    if (dlSeen.has(e.event)) return false;
    dlSeen.add(e.event);
    return true;
  });

  if (uniqueDLEvents.length > 0) {
    console.log(`  Detected ${uniqueDLEvents.length} existing dataLayer event(s): ${uniqueDLEvents.map(e => e.event).join(', ')}`);
  }

  return {
    rootUrl,
    rootDomain,
    platform: mergePlatformDetections(detectedPlatforms),
    pages,
    pageGroups: [],
    discoveredUrls,
    skippedUrls,
    crawlWarnings,
    dataLayerEvents: uniqueDLEvents,
  };
}
