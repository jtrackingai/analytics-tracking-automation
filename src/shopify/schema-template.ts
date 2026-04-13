import { EventSchema, GA4Event, GA4Parameter } from '../generator/event-schema';
import { InteractiveElement, SiteAnalysis } from '../crawler/page-analyzer';

type InferredStorefrontEventName = 'login_click' | 'signup_click' | 'get_started_click' | 'view_search_results';
type ShopifyBootstrapRecommendation = 'keep' | 'review' | 'remove';

export interface ShopifyBootstrapReviewItem {
  eventName: string;
  triggerType: GA4Event['triggerType'];
  sourceType: 'shopify_standard_event' | 'storefront_inference';
  sourceReference: string;
  selector?: string;
  pageUrlPattern?: string;
  sourcePageUrl?: string;
  recommendation: ShopifyBootstrapRecommendation;
  recommendationReason: string;
  rationale: string;
}

export interface ShopifyBootstrapArtifacts {
  schema: EventSchema;
  reviewItems: ShopifyBootstrapReviewItem[];
  reviewMarkdown: string;
}

function baseParameters(): GA4Parameter[] {
  return [
    { name: 'page_location', value: '{{page_location}}', description: 'Shopify storefront page URL from the custom pixel bridge' },
    { name: 'page_title', value: '{{page_title}}', description: 'Shopify storefront page title from the custom pixel bridge' },
    { name: 'page_referrer', value: '{{page_referrer}}', description: 'Referrer captured by the Shopify custom pixel bridge' },
  ];
}

function selectorClickParameters(): GA4Parameter[] {
  return [
    { name: 'page_location', value: '{{Page URL}}', description: 'Current page URL' },
    { name: 'page_title', value: '{{Page Title}}', description: 'Current page title' },
    { name: 'page_referrer', value: '{{Referrer}}', description: 'Previous page URL' },
    { name: 'link_text', value: '{{Click Text}}', description: 'Clicked element text' },
    { name: 'link_url', value: '{{Click URL}}', description: 'Clicked destination URL when available' },
    { name: 'link_classes', value: '{{Click Classes}}', description: 'Clicked element classes for debugging' },
  ];
}

function searchCustomParameters(): GA4Parameter[] {
  return [
    ...baseParameters(),
    { name: 'search_term', value: '{{search_term}}', description: 'Search query from the Shopify `search_submitted` standard event' },
  ];
}

function ecommerceParameters(extra: GA4Parameter[] = []): GA4Parameter[] {
  return [
    ...baseParameters(),
    { name: 'currency', value: '{{currency}}', description: 'Transaction currency from Shopify standard events' },
    { name: 'value', value: '{{value}}', description: 'Event value from Shopify standard events' },
    { name: 'items', value: '{{items}}', description: 'GA4 items array built from Shopify line items or variants' },
    ...extra,
  ];
}

interface InferredStorefrontCandidate {
  eventName: InferredStorefrontEventName;
  description: string;
  priority: 'high' | 'medium' | 'low';
  triggerType: 'click' | 'custom';
  selector: string;
  pageUrl: string;
  pageUrlPattern?: string;
  label: string;
  href?: string;
  parentSection?: InteractiveElement['parentSection'];
  isVisible: boolean;
  score: number;
}

function recommendationLabel(recommendation: ShopifyBootstrapRecommendation): string {
  switch (recommendation) {
    case 'keep':
      return 'Keep';
    case 'review':
      return 'Review';
    case 'remove':
      return 'Remove';
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactPathPattern(pageUrl: string): string | undefined {
  const pathname = new URL(pageUrl).pathname;
  if (pathname === '/') return '\\/$';
  const normalized = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return escapeRegex(normalized);
}

function pagePatternForUrl(pageUrl: string, analysis: SiteAnalysis): string | undefined {
  const matchingGroup = analysis.pageGroups.find(group => group.urls.includes(pageUrl));
  if (matchingGroup?.urlPattern) return matchingGroup.urlPattern;
  return exactPathPattern(pageUrl);
}

function normalizeLabel(element: InteractiveElement): string {
  const uniqueParts = [...new Set(
    [element.text, element.ariaLabel]
      .filter((value): value is string => !!value)
      .map(value => value.trim())
      .filter(Boolean)
  )];

  return uniqueParts
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSelectorForReview(selector: string): string {
  return selector.replace(/:contains\([^)]*\)/g, '').trim();
}

function isWeakSelector(selector: string): boolean {
  const normalized = normalizeSelectorForReview(selector);
  return /^(a|button|form|input|select|textarea)$/i.test(normalized);
}

function classifyStorefrontElement(element: InteractiveElement): {
  eventName: InferredStorefrontEventName;
  description: string;
  priority: 'high' | 'medium' | 'low';
  triggerType: 'click';
  matchedBy: 'text' | 'href';
} | null {
  const label = normalizeLabel(element).toLowerCase();
  const href = (element.href || '').toLowerCase();

  const loginText = /\b(log ?in|sign ?in)\b/i;
  const loginHref = /\/(account\/login|login|sign[-_]?in)(\/|$|\?|#)/i;
  if (loginText.test(label) || loginHref.test(href)) {
    return {
      eventName: 'login_click',
      description: 'User clicks a storefront login entry point.',
      priority: 'high',
      triggerType: 'click',
      matchedBy: loginText.test(label) ? 'text' : 'href',
    };
  }

  const getStartedText = /\b(get started|get started free|start free|try free|free trial|start trial)\b/i;
  if (getStartedText.test(label)) {
    return {
      eventName: 'get_started_click',
      description: 'User clicks a storefront get-started CTA.',
      priority: 'high',
      triggerType: 'click',
      matchedBy: 'text',
    };
  }

  const signupText = /\b(sign ?up|create (an )?account|register|join now|join free)\b/i;
  const signupHref = /\/(account\/register|register|sign[-_]?up|signup)(\/|$|\?|#)/i;
  if (signupText.test(label) || signupHref.test(href)) {
    return {
      eventName: 'signup_click',
      description: 'User clicks a storefront sign-up entry point.',
      priority: 'high',
      triggerType: 'click',
      matchedBy: signupText.test(label) ? 'text' : 'href',
    };
  }

  return null;
}

function inferSearchFormCandidates(analysis: SiteAnalysis): InferredStorefrontCandidate[] {
  const candidates: InferredStorefrontCandidate[] = [];

  for (const page of analysis.pages) {
    if (!page.hasSearchForm) continue;

    const formElements = page.elements.filter(element => {
      if (element.type !== 'form') return false;
      if (!element.selector || !element.isVisible) return false;

      const action = (element.formAction || '').toLowerCase();
      const method = (element.formMethod || '').toLowerCase();
      return action.includes('/search') || method === 'get';
    });

    for (const form of formElements) {
      const action = form.formAction || '';
      const actionLower = action.toLowerCase();
      const method = (form.formMethod || '').toLowerCase();
      const score =
        5 +
        (form.parentSection === 'header' || form.parentSection === 'nav' ? 4 : 0) +
        (actionLower.includes('/search') ? 4 : 0) +
        (method === 'get' ? 2 : 0) +
        (form.selector === 'form' ? -3 : 0);

      candidates.push({
        eventName: 'view_search_results',
        description: 'User views storefront search results.',
        priority: 'medium',
        triggerType: 'custom',
        selector: form.selector,
        pageUrl: page.url,
        pageUrlPattern: pagePatternForUrl(page.url, analysis),
        label: action || 'search form',
        parentSection: form.parentSection,
        isVisible: form.isVisible,
        score,
      });
    }
  }

  return candidates.filter(candidate => candidate.score >= 5);
}

function inferStorefrontSelectorEvents(analysis: SiteAnalysis): {
  events: GA4Event[];
  reviewItems: ShopifyBootstrapReviewItem[];
} {
  const candidates: InferredStorefrontCandidate[] = [];

  for (const page of analysis.pages) {
    for (const element of page.elements) {
      if (element.type !== 'button' && element.type !== 'link') continue;
      if (!element.selector) continue;

      const match = classifyStorefrontElement(element);
      if (!match) continue;

      const label = normalizeLabel(element);
      const score =
        (element.isVisible ? 5 : 0) +
        (element.parentSection === 'header' || element.parentSection === 'nav' ? 4 : 0) +
        (element.parentSection === 'footer' ? 1 : 0) +
        (match.matchedBy === 'text' ? 2 : 1) +
        (element.type === 'link' ? 1 : 0);

      candidates.push({
        eventName: match.eventName,
        description: match.description,
        priority: match.priority,
        triggerType: match.triggerType,
        selector: element.selector,
        pageUrl: page.url,
        pageUrlPattern: pagePatternForUrl(page.url, analysis),
        label,
        href: element.href,
        parentSection: element.parentSection,
        isVisible: element.isVisible,
        score,
      });
    }
  }

  candidates.push(...inferSearchFormCandidates(analysis));

  if (candidates.length === 0) return { events: [], reviewItems: [] };

  const occurrenceKeyCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = `${candidate.eventName}|${candidate.selector}|${candidate.href || ''}`;
    occurrenceKeyCounts.set(key, (occurrenceKeyCounts.get(key) || 0) + 1);
  }

  const globalPageCounts = new Map<InferredStorefrontEventName, number>();
  for (const eventName of ['login_click', 'signup_click', 'get_started_click', 'view_search_results'] as InferredStorefrontEventName[]) {
    globalPageCounts.set(
      eventName,
      new Set(candidates.filter(candidate => candidate.eventName === eventName).map(candidate => candidate.pageUrl)).size,
    );
  }

  const inferredEvents: GA4Event[] = [];
  const reviewItems: ShopifyBootstrapReviewItem[] = [];
  for (const eventName of ['login_click', 'signup_click', 'get_started_click', 'view_search_results'] as InferredStorefrontEventName[]) {
    const matching = candidates.filter(candidate => candidate.eventName === eventName);
    if (matching.length === 0) continue;

    const selected = [...matching].sort((left, right) => {
      const leftOccurrences = occurrenceKeyCounts.get(`${left.eventName}|${left.selector}|${left.href || ''}`) || 0;
      const rightOccurrences = occurrenceKeyCounts.get(`${right.eventName}|${right.selector}|${right.href || ''}`) || 0;
      const leftGlobal = (left.parentSection === 'header' || left.parentSection === 'nav' || left.parentSection === 'footer') ? 1 : 0;
      const rightGlobal = (right.parentSection === 'header' || right.parentSection === 'nav' || right.parentSection === 'footer') ? 1 : 0;

      return (
        (right.score + rightOccurrences * 2 + rightGlobal * 3) -
        (left.score + leftOccurrences * 2 + leftGlobal * 3)
      );
    })[0];

    const appliesGlobally =
      (globalPageCounts.get(eventName) || 0) > 1 ||
      selected.parentSection === 'header' ||
      selected.parentSection === 'nav' ||
      selected.parentSection === 'footer';

    const triggerType = selected.triggerType;
    let recommendation: ShopifyBootstrapRecommendation = 'review';
    let recommendationReason = 'This inferred storefront event should be checked against the real UX before publishing.';

    if (eventName !== 'view_search_results' && isWeakSelector(selected.selector)) {
      recommendation = 'remove';
      recommendationReason = 'The inferred selector is too generic and is likely to match multiple unrelated elements.';
    } else if (eventName === 'view_search_results' && selected.label.toLowerCase().includes('/search')) {
      recommendation = 'keep';
      recommendationReason = 'This event is backed by a visible search form with an explicit `/search` action and can be bridged from Shopify standard search events.';
    } else if ((eventName === 'login_click' || eventName === 'signup_click') && /\/account\/(login|register)/i.test(selected.href || '')) {
      recommendation = 'keep';
      recommendationReason = 'This event points to a canonical Shopify account route and is unlikely to be ambiguous.';
    } else if ((selected.parentSection === 'header' || selected.parentSection === 'nav') && selected.score >= 11) {
      recommendation = 'keep';
      recommendationReason = 'This event was inferred from a repeated high-confidence navigation element.';
    } else if (eventName === 'get_started_click') {
      recommendation = 'review';
      recommendationReason = 'Get-started CTAs often vary by business intent, so confirm the event name matches your storefront flow.';
    }

    inferredEvents.push({
      eventName,
      description: selected.description,
      triggerType,
      elementSelector: triggerType === 'custom' ? undefined : selected.selector,
      pageUrlPattern: triggerType === 'custom' || appliesGlobally ? undefined : selected.pageUrlPattern,
      parameters: triggerType === 'custom' ? searchCustomParameters() : selectorClickParameters(),
      priority: selected.priority,
      notes: triggerType === 'custom'
        ? `Auto-inferred from Shopify storefront analysis${selected.label ? ` using "${selected.label}"` : ''}. Triggered by the Shopify custom pixel bridge from \`search_submitted\`.`
        : `Auto-inferred from Shopify storefront analysis${selected.label ? ` using "${selected.label}"` : ''}. Verify the selector before publishing.`,
    });

    reviewItems.push({
      eventName,
      triggerType,
      sourceType: 'storefront_inference',
      sourceReference: selected.label || selected.selector,
      selector: selected.selector,
      pageUrlPattern: appliesGlobally ? undefined : selected.pageUrlPattern,
      sourcePageUrl: selected.pageUrl,
      recommendation,
      recommendationReason,
      rationale:
        eventName === 'view_search_results'
          ? `Detected a visible search form candidate${selected.label ? ` with action "${selected.label}"` : ''} on ${selected.pageUrl}. The published schema will bridge Shopify \`search_submitted\` into GA4 \`view_search_results\`.`
          : `Detected a high-confidence storefront CTA candidate${selected.label ? ` with label "${selected.label}"` : ''} on ${selected.pageUrl}.`,
    });
  }

  return { events: inferredEvents, reviewItems };
}

function shopifyCustomEvent(
  eventName: string,
  description: string,
  priority: 'high' | 'medium' | 'low',
  parameters: GA4Parameter[],
  shopifySourceEvent: string,
): GA4Event {
  return {
    eventName,
    description,
    triggerType: 'custom',
    parameters,
    priority,
    notes: `Triggered by the Shopify custom pixel bridge from \`${shopifySourceEvent}\`.`,
  };
}

function buildShopifyEcommerceEvents(): GA4Event[] {
  return [
    shopifyCustomEvent(
      'view_item',
      'User views a Shopify product detail page.',
      'high',
      ecommerceParameters(),
      'product_viewed',
    ),
    shopifyCustomEvent(
      'view_item_list',
      'User views a Shopify collection or product listing.',
      'medium',
      [
        ...ecommerceParameters(),
        { name: 'item_list_id', value: '{{item_list_id}}', description: 'Collection or list identifier from Shopify' },
        { name: 'item_list_name', value: '{{item_list_name}}', description: 'Collection or list name from Shopify' },
      ],
      'collection_viewed',
    ),
    shopifyCustomEvent(
      'add_to_cart',
      'User adds a product to cart in Shopify.',
      'high',
      ecommerceParameters(),
      'product_added_to_cart',
    ),
    shopifyCustomEvent(
      'remove_from_cart',
      'User removes a product from cart in Shopify.',
      'medium',
      ecommerceParameters(),
      'product_removed_from_cart',
    ),
    shopifyCustomEvent(
      'view_cart',
      'User views the Shopify cart.',
      'high',
      ecommerceParameters(),
      'cart_viewed',
    ),
    shopifyCustomEvent(
      'begin_checkout',
      'User starts Shopify checkout.',
      'high',
      ecommerceParameters(),
      'checkout_started',
    ),
    shopifyCustomEvent(
      'add_shipping_info',
      'User submits shipping information during Shopify checkout.',
      'high',
      [
        ...ecommerceParameters(),
        { name: 'shipping_tier', value: '{{shipping_tier}}', description: 'Selected shipping option from Shopify checkout' },
      ],
      'checkout_address_info_submitted',
    ),
    shopifyCustomEvent(
      'add_payment_info',
      'User submits payment information during Shopify checkout.',
      'high',
      [
        ...ecommerceParameters(),
        { name: 'payment_type', value: '{{payment_type}}', description: 'Payment method label from Shopify checkout' },
      ],
      'payment_info_submitted',
    ),
    shopifyCustomEvent(
      'purchase',
      'User completes a Shopify purchase.',
      'high',
      [
        ...ecommerceParameters([
          { name: 'transaction_id', value: '{{transaction_id}}', description: 'Order or checkout identifier from Shopify' },
          { name: 'shipping', value: '{{shipping}}', description: 'Shipping amount from Shopify checkout' },
          { name: 'tax', value: '{{tax}}', description: 'Tax amount from Shopify checkout' },
          { name: 'coupon', value: '{{coupon}}', description: 'Applied discount code or promotion from Shopify checkout' },
        ]),
      ],
      'checkout_completed',
    ),
  ];
}

function buildBaseReviewItems(): ShopifyBootstrapReviewItem[] {
  return [
    {
      eventName: 'view_item',
      triggerType: 'custom',
      sourceType: 'shopify_standard_event',
      sourceReference: 'product_viewed',
      recommendation: 'keep',
      recommendationReason: 'This is a baseline Shopify ecommerce event and should usually remain in place.',
      rationale: 'Baseline Shopify ecommerce event mapped from the Shopify standard event `product_viewed`.',
    },
    {
      eventName: 'view_item_list',
      triggerType: 'custom',
      sourceType: 'shopify_standard_event',
      sourceReference: 'collection_viewed',
      recommendation: 'keep',
      recommendationReason: 'This is a baseline Shopify ecommerce event and should usually remain in place.',
      rationale: 'Baseline Shopify ecommerce event mapped from the Shopify standard event `collection_viewed`.',
    },
    {
      eventName: 'add_to_cart',
      triggerType: 'custom',
      sourceType: 'shopify_standard_event',
      sourceReference: 'product_added_to_cart',
      recommendation: 'keep',
      recommendationReason: 'This is a baseline Shopify ecommerce event and should usually remain in place.',
      rationale: 'Baseline Shopify ecommerce event mapped from the Shopify standard event `product_added_to_cart`.',
    },
    {
      eventName: 'remove_from_cart',
      triggerType: 'custom',
      sourceType: 'shopify_standard_event',
      sourceReference: 'product_removed_from_cart',
      recommendation: 'keep',
      recommendationReason: 'This is a baseline Shopify ecommerce event and should usually remain in place.',
      rationale: 'Baseline Shopify ecommerce event mapped from the Shopify standard event `product_removed_from_cart`.',
    },
    {
      eventName: 'view_cart',
      triggerType: 'custom',
      sourceType: 'shopify_standard_event',
      sourceReference: 'cart_viewed',
      recommendation: 'keep',
      recommendationReason: 'This is a baseline Shopify ecommerce event and should usually remain in place.',
      rationale: 'Baseline Shopify ecommerce event mapped from the Shopify standard event `cart_viewed`.',
    },
    {
      eventName: 'begin_checkout',
      triggerType: 'custom',
      sourceType: 'shopify_standard_event',
      sourceReference: 'checkout_started',
      recommendation: 'keep',
      recommendationReason: 'This is a baseline Shopify ecommerce event and should usually remain in place.',
      rationale: 'Baseline Shopify ecommerce event mapped from the Shopify standard event `checkout_started`.',
    },
    {
      eventName: 'add_shipping_info',
      triggerType: 'custom',
      sourceType: 'shopify_standard_event',
      sourceReference: 'checkout_address_info_submitted',
      recommendation: 'keep',
      recommendationReason: 'This is a baseline Shopify ecommerce event and should usually remain in place.',
      rationale: 'Baseline Shopify ecommerce event mapped from the Shopify standard event `checkout_address_info_submitted`.',
    },
    {
      eventName: 'add_payment_info',
      triggerType: 'custom',
      sourceType: 'shopify_standard_event',
      sourceReference: 'payment_info_submitted',
      recommendation: 'keep',
      recommendationReason: 'This is a baseline Shopify ecommerce event and should usually remain in place.',
      rationale: 'Baseline Shopify ecommerce event mapped from the Shopify standard event `payment_info_submitted`.',
    },
    {
      eventName: 'purchase',
      triggerType: 'custom',
      sourceType: 'shopify_standard_event',
      sourceReference: 'checkout_completed',
      recommendation: 'keep',
      recommendationReason: 'This is a baseline Shopify ecommerce event and should usually remain in place.',
      rationale: 'Baseline Shopify ecommerce event mapped from the Shopify standard event `checkout_completed`.',
    },
  ];
}

function renderBootstrapReviewMarkdown(siteUrl: string, reviewItems: ShopifyBootstrapReviewItem[]): string {
  const inferred = reviewItems.filter(item => item.sourceType === 'storefront_inference');
  const baseline = reviewItems.filter(item => item.sourceType === 'shopify_standard_event');
  const keepItems = reviewItems.filter(item => item.recommendation === 'keep');
  const reviewOnlyItems = reviewItems.filter(item => item.recommendation === 'review');
  const removeItems = reviewItems.filter(item => item.recommendation === 'remove');

  const lines = [
    '# Shopify Bootstrap Review',
    '',
    `**Site:** ${siteUrl}`,
    `**Generated:** ${new Date().toISOString()}`,
    '',
    '## Review Checklist',
    '',
    `- [ ] Keep (${keepItems.length}): ${keepItems.map(item => `\`${item.eventName}\``).join(', ') || 'none'}`,
    `- [ ] Review (${reviewOnlyItems.length}): ${reviewOnlyItems.map(item => `\`${item.eventName}\``).join(', ') || 'none'}`,
    `- [ ] Remove (${removeItems.length}): ${removeItems.map(item => `\`${item.eventName}\``).join(', ') || 'none'}`,
    '',
    '## Baseline Ecommerce Events',
    '',
    '| Event | Trigger | Shopify Source | Recommendation | Why Included |',
    '|---|---|---|---|---|',
    ...baseline.map(item =>
      `| \`${item.eventName}\` | \`${item.triggerType}\` | \`${item.sourceReference}\` | ${recommendationLabel(item.recommendation)} | ${item.rationale} ${item.recommendationReason} |`,
    ),
    '',
  ];

  if (inferred.length > 0) {
    lines.push('## Inferred Storefront Events');
    lines.push('');
    lines.push('| Event | Trigger | Selector | Scope | Source Page | Recommendation | Why Included |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const item of inferred) {
      lines.push(
        `| \`${item.eventName}\` | \`${item.triggerType}\` | \`${item.selector || ''}\` | ${item.pageUrlPattern ? `\`${item.pageUrlPattern}\`` : '_all pages_'} | ${item.sourcePageUrl || ''} | ${recommendationLabel(item.recommendation)} | ${item.rationale} ${item.recommendationReason} |`,
      );
    }
    lines.push('');
  } else {
    lines.push('## Inferred Storefront Events');
    lines.push('');
    lines.push('No high-confidence storefront CTA or search events were inferred from the analyzed Shopify pages.');
    lines.push('');
  }

  lines.push('## Notes');
  lines.push('');
  lines.push('- Baseline ecommerce events come from Shopify standard events and are expected in most Shopify storefronts.');
  lines.push('- Inferred storefront events are based on actual analyzed selectors and should still be reviewed with `validate-schema --check-selectors`.');
  lines.push('- `Remove` usually means the inferred selector is too generic and should not be trusted without manual adjustment.');

  return lines.join('\n');
}

export function buildShopifyBootstrapArtifacts(analysis: SiteAnalysis): ShopifyBootstrapArtifacts {
  const baseEvents = buildShopifyEcommerceEvents();
  const baseReviewItems = buildBaseReviewItems();
  const inferred = inferStorefrontSelectorEvents(analysis);
  const schema: EventSchema = {
    siteUrl: analysis.rootUrl,
    generatedAt: new Date().toISOString(),
    events: [...baseEvents, ...inferred.events],
  };
  const reviewItems = [...baseReviewItems, ...inferred.reviewItems];

  return {
    schema,
    reviewItems,
    reviewMarkdown: renderBootstrapReviewMarkdown(analysis.rootUrl, reviewItems),
  };
}

export function buildShopifySchemaTemplate(siteUrl: string): EventSchema;
export function buildShopifySchemaTemplate(analysis: SiteAnalysis): EventSchema;
export function buildShopifySchemaTemplate(input: string | SiteAnalysis): EventSchema {
  if (typeof input === 'string') {
    return {
      siteUrl: input,
      generatedAt: new Date().toISOString(),
      events: buildShopifyEcommerceEvents(),
    };
  }

  return buildShopifyBootstrapArtifacts(input).schema;
}
