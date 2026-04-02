import { SiteAnalysis, PageGroup, PageAnalysis, InteractiveElement, DataLayerEvent } from '../crawler/page-analyzer';
import { SitePlatform } from '../crawler/platform-detector';

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
  groups: GroupSummary[];
}

function elementKey(el: InteractiveElement): string {
  return `${el.type}|${el.selector}|${el.text || ''}|${el.parentSection || ''}`;
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
    representativeHtml: group.representativeHtml,
  };
}

/**
 * Compresses site-analysis.json into a smaller context file
 * optimized for AI event schema generation.
 */
export function buildSchemaContext(analysis: SiteAnalysis): SchemaContext {
  return {
    rootUrl: analysis.rootUrl,
    rootDomain: analysis.rootDomain,
    platform: analysis.platform,
    totalPagesCrawled: analysis.pages.length,
    crawlWarnings: analysis.crawlWarnings,
    dataLayerEvents: analysis.dataLayerEvents || [],
    groups: analysis.pageGroups.map(g => summarizeGroup(g, analysis.pages)),
  };
}
