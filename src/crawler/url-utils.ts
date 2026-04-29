import { Page } from 'playwright';

export function extractDomain(url: string): string {
  try {
    const parts = new URL(url).hostname.split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : new URL(url).hostname;
  } catch {
    return '';
  }
}

export function isSameDomain(url: string, rootDomain: string): boolean {
  try {
    const domain = extractDomain(url);
    return domain === rootDomain || domain.endsWith('.' + rootDomain);
  } catch {
    return false;
  }
}

export function normalizeUrl(url: string, base: string): string | null {
  try {
    const parsed = new URL(url, base);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

export function getSectionPrefix(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments.length > 0 ? '/' + segments[0] : '/';
  } catch {
    return '/';
  }
}

const BUSINESS_CRITICAL_SUBDOMAIN_LABELS = new Set([
  'account',
  'accounts',
  'app',
  'auth',
  'billing',
  'checkout',
  'login',
  'my',
  'pay',
  'payment',
  'payments',
  'secure',
  'signup',
]);

const BUSINESS_CRITICAL_PATH_PATTERNS: RegExp[] = [
  /\/(?:account|accounts|auth|billing|cart|checkout|contact-sales|demo|forgot-password|log-?in|password|pay|payment|pricing|register|reset-password|sign-?in|sign-?up|subscribe|subscription|trial)(?:[/?#]|$|-)/i,
];

const BUSINESS_CRITICAL_QUERY_KEYS = new Set([
  'checkout',
  'package_type',
  'pay_cycle',
  'plan',
  'price',
  'price_id',
  'priceid',
  'subscribe_type',
  'subscription',
  'trial',
]);

function getSubdomainLabels(hostname: string, rootDomain: string): string[] {
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, '');
  const normalizedRoot = rootDomain.toLowerCase().replace(/\.$/, '');

  if (normalizedHost === normalizedRoot || !normalizedHost.endsWith(`.${normalizedRoot}`)) {
    return [];
  }

  return normalizedHost
    .slice(0, -(normalizedRoot.length + 1))
    .split('.')
    .filter(Boolean);
}

export function isBusinessCriticalUrl(url: string, rootDomain: string): boolean {
  try {
    const parsed = new URL(url);
    const subdomainLabels = getSubdomainLabels(parsed.hostname, rootDomain);
    if (subdomainLabels.some(label => BUSINESS_CRITICAL_SUBDOMAIN_LABELS.has(label))) {
      return true;
    }

    if (BUSINESS_CRITICAL_PATH_PATTERNS.some(pattern => pattern.test(parsed.pathname))) {
      return true;
    }

    return Array.from(parsed.searchParams.keys()).some(key =>
      BUSINESS_CRITICAL_QUERY_KEYS.has(key.toLowerCase()),
    );
  } catch {
    return false;
  }
}

export function prioritizeBusinessCriticalUrls(urls: string[], rootDomain: string): string[] {
  const seen = new Set<string>();
  const critical: string[] = [];
  const standard: string[] = [];

  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);

    if (isBusinessCriticalUrl(url, rootDomain)) {
      critical.push(url);
    } else {
      standard.push(url);
    }
  }

  return [...critical, ...standard];
}

function getUrlTemplate(url: string): string {
  try {
    const semanticKeywords = new Set([
      'about', 'pricing', 'contact', 'blog', 'news', 'case-studies',
      'how-it-works', 'features', 'docs', 'documentation', 'privacy',
      'terms', 'legal', 'help', 'support', 'faq', 'api', 'changelog',
    ]);
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const normalized = segments.map(seg => {
      if (/^\d+$/.test(seg)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':uuid';
      if (seg.split('-').length >= 3 && !semanticKeywords.has(seg)) return ':slug';
      return seg;
    });
    return '/' + normalized.join('/');
  } catch {
    return url;
  }
}

function getParentPath(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    return '/' + segments.slice(0, -1).join('/');
  } catch {
    return null;
  }
}

function deduplicateByUrlTemplate(urls: string[], maxPerTemplate: number): string[] {
  const templateCounts = new Map<string, number>();
  const afterTemplate: string[] = [];
  for (const url of urls) {
    const tmpl = getUrlTemplate(url);
    const n = templateCounts.get(tmpl) ?? 0;
    if (n < maxPerTemplate) {
      afterTemplate.push(url);
      templateCounts.set(tmpl, n + 1);
    }
  }

  const siblingCounts = new Map<string, number>();
  const selected: string[] = [];
  for (const url of afterTemplate) {
    const parent = getParentPath(url);
    if (!parent) {
      selected.push(url);
      continue;
    }
    const n = siblingCounts.get(parent) ?? 0;
    if (n < maxPerTemplate) {
      selected.push(url);
      siblingCounts.set(parent, n + 1);
    }
  }

  return selected;
}

export function sampleUrlsBySection(
  urls: string[],
  maxPerSection: number,
  maxTotal: number,
): string[] {
  const sections = new Map<string, string[]>();
  for (const url of urls) {
    const s = getSectionPrefix(url);
    if (!sections.has(s)) sections.set(s, []);
    sections.get(s)!.push(url);
  }
  const selected: string[] = [];
  for (const [, sectionUrls] of sections) {
    if (selected.length >= maxTotal) break;
    const deduped = deduplicateByUrlTemplate(sectionUrls, maxPerSection);
    const remaining = maxTotal - selected.length;
    selected.push(...deduped.slice(0, remaining));
  }
  return selected;
}

// ─── E-commerce detection & URL ordering ─────────────────────────────────────

const ECOMMERCE_PATH_PATTERNS: RegExp[] = [
  /\/products?\//i, /\/items?\//i, /\/shop\//i, /\/store\//i,
  /\/cart\b/i, /\/checkout\b/i, /\/collections?\//i,
  /\/categor(?:y|ies)\//i, /\/catalog\//i,
];

const PRODUCT_DETAIL_PATTERNS: RegExp[] = [
  /\/products?\/[^/]+$/i, /\/items?\/[^/]+$/i,
  /\/p\/[^/]+$/i, /\/dp\/[^/]+$/i,
];

const LISTING_PAGE_PATTERNS: RegExp[] = [
  /\/collections?\/?$/i, /\/collections?\/[^/]+$/i,
  /\/categor(?:y|ies)\/?$/i, /\/categor(?:y|ies)\/[^/]+$/i,
  /\/shop\/?$/i, /\/products?\/?$/i, /\/catalog\/?$/i,
];

export function detectEcommerceSite(urls: string[]): boolean {
  let hits = 0;
  for (const url of urls) {
    try {
      if (ECOMMERCE_PATH_PATTERNS.some(re => re.test(new URL(url).pathname))) hits++;
    } catch { /* skip invalid URLs */ }
  }
  return hits >= 3;
}

export function reorderForEcommerce(urls: string[]): string[] {
  const listing: string[] = [];
  const other: string[] = [];
  const productDetail: string[] = [];

  for (const url of urls) {
    try {
      const pathname = new URL(url).pathname;
      if (LISTING_PAGE_PATTERNS.some(re => re.test(pathname))) {
        listing.push(url);
      } else if (PRODUCT_DETAIL_PATTERNS.some(re => re.test(pathname))) {
        productDetail.push(url);
      } else {
        other.push(url);
      }
    } catch {
      other.push(url);
    }
  }

  return [...listing, ...other, ...productDetail];
}

// ─── Link discovery ────────────────────────────────────────────────────────────

export async function discoverNavLinks(page: Page, rootUrl: string, rootDomain: string): Promise<string[]> {
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('nav a[href], header a[href]'))
      .map(a => (a as HTMLAnchorElement).href)
      .filter(h => h && !h.startsWith('javascript:') && !h.startsWith('mailto:') && !h.startsWith('tel:')),
  );
  const normalized = new Set<string>();
  for (const raw of hrefs) {
    const clean = normalizeUrl(raw, rootUrl);
    if (clean && isSameDomain(clean, rootDomain)) normalized.add(clean);
  }
  return Array.from(normalized);
}

export async function discoverAllLinks(page: Page, rootUrl: string, rootDomain: string): Promise<string[]> {
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map(a => (a as HTMLAnchorElement).href)
      .filter(h => h && !h.startsWith('javascript:') && !h.startsWith('mailto:') && !h.startsWith('tel:')),
  );
  const normalized = new Set<string>();
  for (const raw of hrefs) {
    const clean = normalizeUrl(raw, rootUrl);
    if (clean && isSameDomain(clean, rootDomain)) normalized.add(clean);
  }
  return Array.from(normalized);
}
