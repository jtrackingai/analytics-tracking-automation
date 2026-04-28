import { SiteAnalysis } from '../crawler/page-analyzer';
import { EventSchema } from './event-schema';
import { buildSchemaContext, ReusableInteractionSummary } from './schema-context';
import { LiveGtmAnalysis } from '../gtm/live-parser';
import { buildExistingTrackingBaseline } from './live-tracking-insights';

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function slugForEvent(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function inferPageRegex(url: string): string {
  try {
    const pathname = new URL(url).pathname || '/';
    if (pathname === '/') return '^/$';
    return `^${pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`;
  } catch {
    return '^/$';
  }
}

function isHighValuePath(url: string): boolean {
  return /(pricing|plan|product|checkout|cart|contact|demo|signup|register|trial)/i.test(url);
}

function inferReusableInteractionEventName(interaction: ReusableInteractionSummary): { eventName: string; priority: 'high' | 'medium' } | null {
  const candidates = [
    ...interaction.textSamples,
    ...interaction.ariaLabels,
    ...interaction.hrefs,
    ...interaction.selectors,
  ].join(' ').toLowerCase();

  if (/(book demo|request demo|schedule demo)/.test(candidates)) {
    return { eventName: 'demo_request_click', priority: 'high' };
  }
  if (/(sign up|signup|register|create account)/.test(candidates)) {
    return { eventName: 'sign_up_click', priority: 'high' };
  }
  if (/(contact|get in touch|talk to sales|咨询)/.test(candidates)) {
    return { eventName: 'contact_click', priority: 'high' };
  }
  if (/(start trial|free trial|try for free)/.test(candidates)) {
    return { eventName: 'start_trial_click', priority: 'high' };
  }
  if (/(pricing|see plans|view pricing)/.test(candidates)) {
    return { eventName: 'pricing_click', priority: 'medium' };
  }

  const label = interaction.textSamples[0] || interaction.ariaLabels[0];
  if (!label) return null;

  return {
    eventName: `cta_click_${slugForEvent(label)}`,
    priority: interaction.groupCount >= 2 ? 'high' : 'medium',
  };
}

function inferReusableInteractionDescription(interaction: ReusableInteractionSummary, eventName: string): string {
  const label = interaction.textSamples[0] || interaction.ariaLabels[0] || eventName;
  return `Tracks reusable CTA interaction "${label}" across ${interaction.urlCount} page(s) in ${interaction.groupCount} page group(s).`;
}

export function buildHealthAuditRecommendedSchema(args: {
  analysis: SiteAnalysis;
  liveAnalysis: LiveGtmAnalysis;
}): EventSchema {
  const liveBaseline = buildExistingTrackingBaseline(args.liveAnalysis);
  const events: EventSchema['events'] = [];
  const usedNames = new Set<string>();

  const pushEvent = (event: EventSchema['events'][number]) => {
    if (!event.eventName || usedNames.has(event.eventName)) return;
    usedNames.add(event.eventName);
    events.push(event);
  };

  const schemaContext = buildSchemaContext(args.analysis, args.liveAnalysis);

  for (const liveEvent of liveBaseline.events) {
    const triggerType = (liveEvent.triggerTypes.find(type => type !== 'unknown') || 'custom') as EventSchema['events'][number]['triggerType'];
    pushEvent({
      eventName: liveEvent.eventName,
      description: `Carry forward live event ${liveEvent.eventName} from current GTM baseline.`,
      triggerType,
      elementSelector: liveEvent.selectors[0] || undefined,
      pageUrlPattern: liveEvent.urlPatterns[0] || undefined,
      parameters: uniq(liveEvent.parameterNames).slice(0, 8).map(name => ({
        name,
        value:
          name === 'page_location'
            ? '{{Page URL}}'
            : name === 'page_title'
              ? '{{Page Title}}'
              : name === 'page_referrer'
                ? '{{Referrer}}'
                : `{{${name}}}`,
        description: `Parameter ${name} from live baseline alignment.`,
      })),
      priority: /(purchase|checkout|signup|sign_up|lead|contact)/.test(liveEvent.eventName) ? 'high' : 'medium',
    });
  }

  for (const interaction of schemaContext.reusableInteractions) {
    const inferred = inferReusableInteractionEventName(interaction);
    if (!inferred) continue;

    const primarySelector = interaction.selectors[0];
    if (!primarySelector) continue;

    pushEvent({
      eventName: inferred.eventName,
      description: inferReusableInteractionDescription(interaction, inferred.eventName),
      triggerType: 'click',
      elementSelector: primarySelector,
      parameters: [
        { name: 'page_location', value: '{{Page URL}}', description: 'Current page URL' },
        { name: 'page_title', value: '{{Page Title}}', description: 'Current page title' },
        { name: 'link_text', value: '{{Click Text}}', description: 'Clicked CTA text' },
        { name: 'link_url', value: '{{Click URL}}', description: 'Clicked CTA URL' },
      ],
      priority: inferred.priority,
    });
  }

  const ctaKeywords: Array<{ keyword: RegExp; eventName: string; priority: 'high' | 'medium' }> = [
    { keyword: /(sign up|signup|register|create account)/i, eventName: 'sign_up_click', priority: 'high' },
    { keyword: /(contact|get in touch|talk to sales|咨询)/i, eventName: 'contact_click', priority: 'high' },
    { keyword: /(book demo|request demo|schedule demo)/i, eventName: 'demo_request_click', priority: 'high' },
    { keyword: /(start trial|free trial|try for free)/i, eventName: 'start_trial_click', priority: 'high' },
    { keyword: /(pricing|see plans|view pricing)/i, eventName: 'pricing_click', priority: 'medium' },
    { keyword: /(buy now|checkout|add to cart|purchase)/i, eventName: 'begin_checkout_click', priority: 'high' },
  ];

  for (const page of args.analysis.pages.slice(0, 25)) {
    const pageRegex = inferPageRegex(page.url);
    for (const element of page.elements.slice(0, 120)) {
      if (!element.isVisible) continue;
      if (element.type !== 'button' && element.type !== 'link') continue;
      const label = (element.text || element.ariaLabel || '').trim();
      if (!label) continue;

      const matchedKeyword = ctaKeywords.find(item => item.keyword.test(label));
      const eventName = matchedKeyword?.eventName || `cta_click_${slugForEvent(label)}`;
      const priority = matchedKeyword?.priority || (isHighValuePath(page.url) ? 'high' : 'medium');
      pushEvent({
        eventName,
        description: `Tracks CTA interaction "${label}" on ${page.url}.`,
        triggerType: 'click',
        elementSelector: element.selector || undefined,
        pageUrlPattern: pageRegex,
        parameters: [
          { name: 'page_location', value: '{{Page URL}}', description: 'Current page URL' },
          { name: 'page_title', value: '{{Page Title}}', description: 'Current page title' },
          { name: 'link_text', value: '{{Click Text}}', description: 'Clicked CTA text' },
          { name: 'link_url', value: '{{Click URL}}', description: 'Clicked CTA URL' },
        ],
        priority,
      });
      if (events.length >= 40) break;
    }
    if (events.length >= 40) break;
  }

  const highValueUrls = uniq([args.analysis.rootUrl, ...args.analysis.discoveredUrls]).filter(isHighValuePath).slice(0, 12);
  for (const url of highValueUrls) {
    const lower = url.toLowerCase();
    const eventName = lower.includes('pricing')
      ? 'view_pricing_page'
      : lower.includes('product')
        ? 'view_product_page'
        : lower.includes('checkout')
          ? 'view_checkout_page'
          : lower.includes('cart')
            ? 'view_cart_page'
            : lower.includes('contact')
              ? 'view_contact_page'
              : `view_page_${slugForEvent(url)}`;
    pushEvent({
      eventName,
      description: `Tracks page view coverage for high-value page ${url}.`,
      triggerType: 'page_view',
      pageUrlPattern: inferPageRegex(url),
      parameters: [
        { name: 'page_location', value: '{{Page URL}}', description: 'Current page URL' },
        { name: 'page_title', value: '{{Page Title}}', description: 'Current page title' },
        { name: 'page_referrer', value: '{{Referrer}}', description: 'Referrer page URL' },
      ],
      priority: 'high',
    });
  }

  return {
    siteUrl: args.analysis.rootUrl,
    generatedAt: new Date().toISOString(),
    artifactSource: {
      mode: 'health_audit_recommendation',
      reason: 'Tracking Health Audit generated a candidate schema from current crawl signals plus the live GTM baseline.',
      derivedFrom: ['site-analysis.json', 'live-gtm-analysis.json'],
    },
    events: events.slice(0, 60),
  };
}
