import { SiteAnalysis, PageGroup, PageAnalysis, InteractiveElement, DataLayerEvent } from '../crawler/page-analyzer';
import { SitePlatform } from '../crawler/platform-detector';
import { LiveGtmAnalysis } from '../gtm/live-parser';
import { ExistingTrackingBaseline, buildExistingTrackingBaseline } from './live-tracking-insights';

/**
 * Compressed per-group summary for AI event schema generation.
 * Deduplicates elements across pages in the same group and drops
 * per-page details that the AI doesn't need for Step 2.
 */
export interface GroupSummary {
  name: string;
  displayName: string;
  description: string;
  contentType: string;
  urlPattern: string;
  pageCount: number;
  urls: string[];
  hasSearchForm: boolean;
  hasVideoPlayer: boolean;
  hasInfiniteScroll: boolean;
  isSPA: boolean;
  elements: DeduplicatedElement[];
  representativeHtml?: string;
}

export interface DeduplicatedElement {
  type: InteractiveElement['type'];
  selector: string;
  text?: string;
  href?: string;
  formAction?: string;
  formMethod?: string;
  inputType?: string;
  ariaLabel?: string;
  parentSection?: string;
  isVisible: boolean;
  occurrences: number;
}

export interface SchemaContext {
  rootUrl: string;
  rootDomain: string;
  platform: SitePlatform;
  totalPagesCrawled: number;
  crawlWarnings: string[];
  dataLayerEvents: DataLayerEvent[];
  existingTrackingBaseline?: ExistingTrackingBaseline;
  groups: GroupSummary[];
  reusableInteractions: ReusableInteractionSummary[];
}

export interface ReusableInteractionSummary {
  key: string;
  type: InteractiveElement['type'];
  urls: string[];
  urlCount: number;
  groupNames: string[];
  groupCount: number;
  selectors: string[];
  hrefs: string[];
  textSamples: string[];
  ariaLabels: string[];
  occurrences: number;
}

function elementKey(el: InteractiveElement): string {
  return `${el.type}|${el.selector}|${el.text || ''}|${el.parentSection || ''}`;
}

function normalizeWhitespace(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\s+/g, ' ') : undefined;
}

function canonicalizeHref(href: string | undefined, rootUrl: string): string | undefined {
  const trimmed = normalizeWhitespace(href);
  if (!trimmed) return undefined;

  try {
    const parsed = new URL(trimmed, rootUrl);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function interactionKey(el: InteractiveElement, rootUrl: string): string | undefined {
  const href = canonicalizeHref(el.href, rootUrl);
  if (href) return `href|${el.type}|${href}`;

  const selector = normalizeWhitespace(el.selector);
  if (selector) return `selector|${el.type}|${selector}`;

  return undefined;
}

function buildReusableInteractions(analysis: SiteAnalysis): ReusableInteractionSummary[] {
  const groupNamesByUrl = new Map<string, Set<string>>();
  for (const group of analysis.pageGroups) {
    for (const url of group.urls) {
      const names = groupNamesByUrl.get(url) || new Set<string>();
      names.add(group.name);
      groupNamesByUrl.set(url, names);
    }
  }

  const summaryByKey = new Map<string, {
    type: InteractiveElement['type'];
    urls: Set<string>;
    groupNames: Set<string>;
    selectors: Set<string>;
    hrefs: Set<string>;
    textSamples: Set<string>;
    ariaLabels: Set<string>;
    occurrences: number;
  }>();

  for (const page of analysis.pages) {
    const pageGroupNames = groupNamesByUrl.get(page.url) || new Set<string>();

    for (const el of page.elements) {
      if (!el.isVisible) continue;
      if (el.type !== 'link' && el.type !== 'button') continue;

      const key = interactionKey(el, analysis.rootUrl);
      if (!key) continue;

      const summary = summaryByKey.get(key) || {
        type: el.type,
        urls: new Set<string>(),
        groupNames: new Set<string>(),
        selectors: new Set<string>(),
        hrefs: new Set<string>(),
        textSamples: new Set<string>(),
        ariaLabels: new Set<string>(),
        occurrences: 0,
      };

      summary.urls.add(page.url);
      for (const groupName of pageGroupNames) summary.groupNames.add(groupName);

      const selector = normalizeWhitespace(el.selector);
      if (selector) summary.selectors.add(selector);

      const href = canonicalizeHref(el.href, analysis.rootUrl);
      if (href) summary.hrefs.add(href);

      const text = normalizeWhitespace(el.text);
      if (text) summary.textSamples.add(text);

      const ariaLabel = normalizeWhitespace(el.ariaLabel);
      if (ariaLabel) summary.ariaLabels.add(ariaLabel);

      summary.occurrences += 1;
      summaryByKey.set(key, summary);
    }
  }

  return Array.from(summaryByKey.entries())
    .map(([key, summary]) => ({
      key,
      type: summary.type,
      urls: Array.from(summary.urls).sort(),
      urlCount: summary.urls.size,
      groupNames: Array.from(summary.groupNames).sort(),
      groupCount: summary.groupNames.size,
      selectors: Array.from(summary.selectors).sort(),
      hrefs: Array.from(summary.hrefs).sort(),
      textSamples: Array.from(summary.textSamples).sort(),
      ariaLabels: Array.from(summary.ariaLabels).sort(),
      occurrences: summary.occurrences,
    }))
    .filter(item => item.urlCount >= 2)
    .sort((left, right) => {
      if (right.groupCount !== left.groupCount) {
        return right.groupCount - left.groupCount;
      }
      if (right.urlCount !== left.urlCount) {
        return right.urlCount - left.urlCount;
      }
      return right.occurrences - left.occurrences;
    });
}

function pickRepresentativeHtml(group: PageGroup, groupPages: PageAnalysis[]): string | undefined {
  const existing = group.representativeHtml?.trim();
  if (existing && existing.length > 0) return existing;

  const bestPage = [...groupPages]
    .sort((a, b) => {
      if (b.elements.length !== a.elements.length) {
        return b.elements.length - a.elements.length;
      }
      return (b.cleanedHtml?.length || 0) - (a.cleanedHtml?.length || 0);
    })[0];

  const cleaned = bestPage?.cleanedHtml?.trim();
  return cleaned || undefined;
}

function summarizeGroup(group: PageGroup, pages: PageAnalysis[]): GroupSummary {
  const groupPages = pages.filter(p => group.urls.includes(p.url));

  const elemMap = new Map<string, { el: DeduplicatedElement; count: number }>();

  let hasSearchForm = false;
  let hasVideoPlayer = false;
  let hasInfiniteScroll = false;
  let isSPA = false;

  for (const page of groupPages) {
    if (page.hasSearchForm) hasSearchForm = true;
    if (page.hasVideoPlayer) hasVideoPlayer = true;
    if (page.hasInfiniteScroll) hasInfiniteScroll = true;
    if (page.isSPA) isSPA = true;

    for (const el of page.elements) {
      const key = elementKey(el);
      const existing = elemMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        elemMap.set(key, {
          el: {
            type: el.type,
            selector: el.selector,
            text: el.text,
            href: el.href,
            formAction: el.formAction,
            formMethod: el.formMethod,
            inputType: el.inputType,
            ariaLabel: el.ariaLabel,
            parentSection: el.parentSection,
            isVisible: el.isVisible,
            occurrences: 1,
          },
          count: 1,
        });
      }
    }
  }

  const elements = Array.from(elemMap.values())
    .map(({ el, count }) => ({ ...el, occurrences: count }))
    .sort((a, b) => b.occurrences - a.occurrences);

  return {
    name: group.name,
    displayName: group.displayName,
    description: group.description,
    contentType: group.contentType,
    urlPattern: group.urlPattern,
    pageCount: groupPages.length,
    urls: group.urls,
    hasSearchForm,
    hasVideoPlayer,
    hasInfiniteScroll,
    isSPA,
    elements,
    representativeHtml: pickRepresentativeHtml(group, groupPages),
  };
}

/**
 * Compresses site-analysis.json into a smaller context file
 * optimized for AI event schema generation.
 */
export function buildSchemaContext(analysis: SiteAnalysis, liveAnalysis?: LiveGtmAnalysis | null): SchemaContext {
  return {
    rootUrl: analysis.rootUrl,
    rootDomain: analysis.rootDomain,
    platform: analysis.platform,
    totalPagesCrawled: analysis.pages.length,
    crawlWarnings: analysis.crawlWarnings,
    dataLayerEvents: analysis.dataLayerEvents || [],
    existingTrackingBaseline: liveAnalysis ? buildExistingTrackingBaseline(liveAnalysis) : undefined,
    groups: analysis.pageGroups.map(g => summarizeGroup(g, analysis.pages)),
    reusableInteractions: buildReusableInteractions(analysis),
  };
}
