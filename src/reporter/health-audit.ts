import { SiteAnalysis } from '../crawler/page-analyzer';
import { EventSchema, GA4Event } from '../generator/event-schema';
import { ExistingTrackingBaseline } from '../generator/live-tracking-insights';

export type HealthAuditGapType =
  | 'missing_event'
  | 'missing_parameter'
  | 'weak_naming'
  | 'partial_coverage'
  | 'high_value_page_gap';

export interface HealthAuditGap {
  type: HealthAuditGapType;
  severity: 'high' | 'medium' | 'low';
  detail: string;
  eventName?: string;
  pageUrl?: string;
}

export type HealthAuditPreviewStatus = 'healthy' | 'failure' | 'not_observable';

export interface HealthAuditPreviewItem {
  eventName: string;
  status: HealthAuditPreviewStatus;
  reason: string;
  priority: GA4Event['priority'];
  pageScope: string;
}

export interface HealthAuditSchemaGapSummary {
  gaps: HealthAuditGap[];
  counts: Record<HealthAuditGapType, number>;
  highValuePages: string[];
  uncoveredHighValuePages: string[];
}

export interface HealthAuditPreviewSummary {
  items: HealthAuditPreviewItem[];
  counts: Record<HealthAuditPreviewStatus, number>;
  keyFailures: HealthAuditPreviewItem[];
  keyPageCoverageGaps: string[];
}

export interface HealthAuditRecommendation {
  shouldEnterNewSetup: boolean;
  reason: string;
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeSelector(value: string): string {
  return value
    .toLowerCase()
    .replace(/:contains\((.*?)\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function selectorMatches(liveSelector: string, pageSelector: string): boolean {
  const left = normalizeSelector(liveSelector);
  const right = normalizeSelector(pageSelector);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function isHighValueUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return /(pricing|plan|product|checkout|cart|contact|demo|signup|register|trial)/.test(lower);
}

function isWeakNaming(eventName: string): boolean {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(eventName)) return true;
  if (eventName === 'event' || eventName === 'click' || eventName === 'submit') return true;
  if (eventName.length < 5) return true;
  return false;
}

function inferPageScope(event: GA4Event): string {
  return event.pageUrlPattern || 'root page only';
}

function eventRequiresManualValidation(event: GA4Event): boolean {
  const joined = `${event.eventName} ${event.elementSelector || ''} ${event.pageUrlPattern || ''}`.toLowerCase();
  return /(login|signin|sign-in|checkout|payment|account|profile|dashboard|captcha)/.test(joined);
}

function hasLiveCoverageForUrl(args: {
  url: string;
  baseline: ExistingTrackingBaseline;
}): boolean {
  const { url, baseline } = args;
  const lower = url.toLowerCase();

  return baseline.events.some(event => {
    if (event.urlPatterns.some(pattern => {
      try {
        return new RegExp(pattern).test(url);
      } catch {
        return lower.includes(pattern.toLowerCase());
      }
    })) {
      return true;
    }

    const named = event.eventName.toLowerCase();
    if (lower.includes('pricing') && /pricing|plan/.test(named)) return true;
    if (lower.includes('product') && /product|item|view_item/.test(named)) return true;
    if (lower.includes('checkout') && /checkout|purchase|begin_checkout/.test(named)) return true;
    if (lower.includes('cart') && /cart|add_to_cart/.test(named)) return true;
    if (lower.includes('contact') && /contact|lead|form_submit/.test(named)) return true;
    return false;
  });
}

export function analyzeHealthAuditSchemaGaps(args: {
  schema: EventSchema;
  baseline: ExistingTrackingBaseline;
  analysis: SiteAnalysis;
}): HealthAuditSchemaGapSummary {
  const gaps: HealthAuditGap[] = [];
  const liveByName = new Map(args.baseline.events.map(event => [event.eventName, event]));

  for (const schemaEvent of args.schema.events) {
    const live = liveByName.get(schemaEvent.eventName);
    if (!live) {
      gaps.push({
        type: 'missing_event',
        severity: schemaEvent.priority === 'high' ? 'high' : 'medium',
        eventName: schemaEvent.eventName,
        detail: `Live tags do not include recommended event \`${schemaEvent.eventName}\`.`,
      });
      continue;
    }

    const schemaParamNames = uniq(schemaEvent.parameters.map(parameter => parameter.name));
    const missingParams = schemaParamNames.filter(name => !live.parameterNames.includes(name));
    for (const parameterName of missingParams) {
      gaps.push({
        type: 'missing_parameter',
        severity: schemaEvent.priority === 'high' ? 'high' : 'medium',
        eventName: schemaEvent.eventName,
        detail: `Live event \`${schemaEvent.eventName}\` is missing parameter \`${parameterName}\`.`,
      });
    }

    if (schemaEvent.elementSelector && live.selectors.length > 0) {
      const hasMatch = live.selectors.some(selector =>
        args.analysis.pages.some(page =>
          page.elements.some(element =>
            selectorMatches(selector, element.selector),
          ),
        ),
      );
      if (!hasMatch) {
        gaps.push({
          type: 'partial_coverage',
          severity: schemaEvent.priority === 'high' ? 'high' : 'medium',
          eventName: schemaEvent.eventName,
          detail: `Live selector hints for \`${schemaEvent.eventName}\` could not be validated against current crawled elements.`,
        });
      }
    }
  }

  for (const liveEvent of args.baseline.events) {
    if (isWeakNaming(liveEvent.eventName)) {
      gaps.push({
        type: 'weak_naming',
        severity: 'medium',
        eventName: liveEvent.eventName,
        detail: `Live event name \`${liveEvent.eventName}\` is weak or non-standard for GA4 naming.`,
      });
    }
  }

  const highValuePages = uniq([args.analysis.rootUrl, ...args.analysis.discoveredUrls])
    .filter(isHighValueUrl)
    .slice(0, 20);
  const uncoveredHighValuePages = highValuePages.filter(url => !hasLiveCoverageForUrl({
    url,
    baseline: args.baseline,
  }));
  for (const pageUrl of uncoveredHighValuePages) {
    gaps.push({
      type: 'high_value_page_gap',
      severity: 'high',
      pageUrl,
      detail: `No reliable live-tag coverage was detected for high-value page \`${pageUrl}\`.`,
    });
  }

  const counts: Record<HealthAuditGapType, number> = {
    missing_event: 0,
    missing_parameter: 0,
    weak_naming: 0,
    partial_coverage: 0,
    high_value_page_gap: 0,
  };
  for (const gap of gaps) {
    counts[gap.type] += 1;
  }

  return {
    gaps,
    counts,
    highValuePages,
    uncoveredHighValuePages,
  };
}

export function analyzeHealthAuditPreview(args: {
  schema: EventSchema;
  baseline: ExistingTrackingBaseline;
  analysis: SiteAnalysis;
}): HealthAuditPreviewSummary {
  const items: HealthAuditPreviewItem[] = [];
  const liveByName = new Map(args.baseline.events.map(event => [event.eventName, event]));

  for (const event of args.schema.events) {
    const live = liveByName.get(event.eventName);
    if (!live) {
      items.push({
        eventName: event.eventName,
        status: event.priority === 'high' ? 'failure' : 'not_observable',
        reason: event.priority === 'high'
          ? 'High-priority recommended event is not live.'
          : 'Recommended event is not live and remains unverified.',
        priority: event.priority,
        pageScope: inferPageScope(event),
      });
      continue;
    }

    if (eventRequiresManualValidation(event)) {
      items.push({
        eventName: event.eventName,
        status: 'not_observable',
        reason: 'Event likely requires a manual/authenticated user journey.',
        priority: event.priority,
        pageScope: inferPageScope(event),
      });
      continue;
    }

    if (event.elementSelector && live.selectors.length > 0) {
      const selectorMatch = live.selectors.some(selector =>
        args.analysis.pages.some(page =>
          page.elements.some(element =>
            selectorMatches(selector, element.selector),
          ),
        ),
      );
      if (!selectorMatch) {
        items.push({
          eventName: event.eventName,
          status: 'failure',
          reason: 'No selector evidence matched current crawled elements.',
          priority: event.priority,
          pageScope: inferPageScope(event),
        });
        continue;
      }
    }

    items.push({
      eventName: event.eventName,
      status: 'healthy',
      reason: 'Live tag exists and validation signals are consistent.',
      priority: event.priority,
      pageScope: inferPageScope(event),
    });
  }

  items.sort((left, right) => left.eventName.localeCompare(right.eventName));
  const counts: Record<HealthAuditPreviewStatus, number> = {
    healthy: 0,
    failure: 0,
    not_observable: 0,
  };
  for (const item of items) {
    counts[item.status] += 1;
  }

  const keyFailures = items.filter(item => item.status === 'failure' && item.priority === 'high');
  const keyPageCoverageGaps = uniq(
    items
      .filter(item => item.status !== 'healthy' && /(pricing|checkout|cart|contact|product)/.test(item.pageScope.toLowerCase()))
      .map(item => item.pageScope),
  );

  return {
    items,
    counts,
    keyFailures,
    keyPageCoverageGaps,
  };
}

export function decideHealthAuditNextStep(args: {
  gapSummary: HealthAuditSchemaGapSummary;
  previewSummary: HealthAuditPreviewSummary;
}): HealthAuditRecommendation {
  const highRiskGapCount =
    args.gapSummary.counts.high_value_page_gap
    + args.gapSummary.counts.missing_event
    + args.gapSummary.counts.partial_coverage;

  if (highRiskGapCount >= 3 || args.previewSummary.keyFailures.length > 0) {
    return {
      shouldEnterNewSetup: true,
      reason: 'High-risk tracking gaps and key event failures indicate a New Setup path is safer than incremental fixes.',
    };
  }

  if (args.gapSummary.gaps.length >= 8) {
    return {
      shouldEnterNewSetup: true,
      reason: 'Overall tracking gaps are broad enough that New Setup is recommended for consistency and maintainability.',
    };
  }

  return {
    shouldEnterNewSetup: false,
    reason: 'Current tracking has manageable gaps; targeted maintenance can proceed without a full New Setup.',
  };
}

export function renderHealthAuditSchemaGapReport(args: {
  schema: EventSchema;
  baseline: ExistingTrackingBaseline;
  gapSummary: HealthAuditSchemaGapSummary;
}): string {
  const lines: string[] = [
    '# Tracking Health Schema Gap Report',
    '',
    `**Site:** ${args.schema.siteUrl}`,
    `**Live events detected:** ${args.baseline.totalLiveEvents}`,
    `**Recommended schema events:** ${args.schema.events.length}`,
    '',
    '## Gap Summary',
    '',
    `- missing_event: ${args.gapSummary.counts.missing_event}`,
    `- missing_parameter: ${args.gapSummary.counts.missing_parameter}`,
    `- weak_naming: ${args.gapSummary.counts.weak_naming}`,
    `- partial_coverage: ${args.gapSummary.counts.partial_coverage}`,
    `- high_value_page_gap: ${args.gapSummary.counts.high_value_page_gap}`,
    '',
    '## High-Value Pages',
    '',
    ...(args.gapSummary.highValuePages.length > 0
      ? args.gapSummary.highValuePages.map(page => `- ${page}`)
      : ['- none detected']),
    '',
    '## Gap Details',
    '',
    '| Type | Severity | Event/Page | Detail |',
    '| --- | --- | --- | --- |',
  ];

  if (args.gapSummary.gaps.length === 0) {
    lines.push('| _none_ | _none_ | _none_ | No schema-vs-live gaps found. |');
  } else {
    for (const gap of args.gapSummary.gaps) {
      lines.push(`| ${gap.type} | ${gap.severity} | ${gap.eventName || gap.pageUrl || '—'} | ${gap.detail} |`);
    }
  }

  lines.push('', '_Generated by analytics-tracking-automation_');
  return lines.join('\n');
}

export function renderHealthAuditPreviewReport(args: {
  previewSummary: HealthAuditPreviewSummary;
}): string {
  const lines: string[] = [
    '# Tracking Health Preview Report',
    '',
    '## Status Summary',
    '',
    `- healthy: ${args.previewSummary.counts.healthy}`,
    `- failure: ${args.previewSummary.counts.failure}`,
    `- not_observable: ${args.previewSummary.counts.not_observable}`,
    '',
    '## Event Validation',
    '',
    '| Event | Status | Priority | Page Scope | Reason |',
    '| --- | --- | --- | --- | --- |',
  ];

  if (args.previewSummary.items.length === 0) {
    lines.push('| _none_ | not_observable | low | — | No preview-observable events were available. |');
  } else {
    for (const item of args.previewSummary.items) {
      lines.push(`| \`${item.eventName}\` | ${item.status} | ${item.priority} | ${item.pageScope} | ${item.reason} |`);
    }
  }

  lines.push(
    '',
    '## Key Failures',
    '',
    ...(args.previewSummary.keyFailures.length > 0
      ? args.previewSummary.keyFailures.map(item => `- \`${item.eventName}\`: ${item.reason}`)
      : ['- none']),
    '',
    '## Key Page Coverage Gaps',
    '',
    ...(args.previewSummary.keyPageCoverageGaps.length > 0
      ? args.previewSummary.keyPageCoverageGaps.map(item => `- ${item}`)
      : ['- none']),
    '',
    '_Generated by analytics-tracking-automation_',
  );

  return lines.join('\n');
}

export function renderHealthAuditRecommendationReport(args: {
  recommendation: HealthAuditRecommendation;
  gapSummary: HealthAuditSchemaGapSummary;
  previewSummary: HealthAuditPreviewSummary;
}): string {
  return [
    '# Tracking Health Audit Next Step Recommendation',
    '',
    `- Enter New Setup: ${args.recommendation.shouldEnterNewSetup ? 'yes' : 'no'}`,
    `- Reason: ${args.recommendation.reason}`,
    `- Gap total: ${args.gapSummary.gaps.length}`,
    `- Key failures: ${args.previewSummary.keyFailures.length}`,
    `- High-value page gaps: ${args.gapSummary.counts.high_value_page_gap}`,
    '',
    '_Generated by analytics-tracking-automation_',
  ].join('\n');
}
