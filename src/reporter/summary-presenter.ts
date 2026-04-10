import { PageGroup, SiteAnalysis } from '../crawler/page-analyzer';
import { EventSchema, GA4Event, GA4Parameter } from '../generator/event-schema';
import {
  ExistingTrackingBaseline,
  LiveTrackingDelta,
} from '../generator/live-tracking-insights';
import { PreviewResult } from '../gtm/preview';
import {
  HealthAuditPreviewSummary,
  HealthAuditRecommendation,
  HealthAuditSchemaGapSummary,
} from './health-audit';
import { SchemaDiffResult } from './schema-diff';
import {
  UpkeepNextStepRecommendation,
  UpkeepPreviewAssessment,
  UpkeepPreviewStatus,
} from './upkeep-preview';
import { TrackingHealthReport } from './tracking-health';

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

function code(value: string): string {
  return `\`${value}\``;
}

function toSentenceCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function humanizePattern(pattern?: string): string {
  if (!pattern) return 'All pages';
  if (pattern === '^/$') return 'Home page';
  return pattern;
}

function summarizeBusinessPurpose(event: GA4Event): string {
  const description = event.description.trim();
  if (description) {
    return description.replace(/^Tracks\s+/i, '').replace(/\.$/, '');
  }

  return `${event.triggerType} interaction for ${event.eventName}`;
}

function inferAddOrChangeReason(event: GA4Event, liveDelta: LiveTrackingDelta | null): string {
  const change = liveDelta?.changes.find(item => item.eventName === event.eventName);
  if (!change) return 'Defines this event explicitly in the reviewed tracking plan.';
  if (change.status === 'new') {
    return change.improvements[0]
      ? toSentenceCase(change.improvements[0])
      : 'Adds coverage for a journey that is not reliably tracked live today.';
  }
  if (change.improvements.length > 0) {
    return `Keep the existing event name but upgrade it because ${change.improvements.join('; ')}.`;
  }
  return 'Keep the existing event name for reporting continuity.';
}

function renderTable(headers: string[], rows: string[][]): string[] {
  const lines = [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];

  if (rows.length === 0) {
    lines.push(`| ${headers.map((_, index) => (index === 0 ? '_none_' : '—')).join(' | ')} |`);
    return lines;
  }

  for (const row of rows) {
    lines.push(`| ${row.map(cell => escapeCell(cell)).join(' | ')} |`);
  }
  return lines;
}

function renderList(label: string, values: string[], emptyLabel = 'none'): string[] {
  return [
    `${label}: ${values.length > 0 ? values.map(code).join(', ') : emptyLabel}`,
  ];
}

function renderEventNames(events: GA4Event[]): string {
  return events.length > 0 ? events.map(event => code(event.eventName)).join(', ') : 'none';
}

function getEventMap(schema: EventSchema): Map<string, GA4Event> {
  return new Map(schema.events.map(event => [event.eventName, event]));
}

function getEventGapReasons(eventName: string, gapSummary: HealthAuditSchemaGapSummary): string[] {
  return gapSummary.gaps
    .filter(gap => gap.eventName === eventName)
    .map(gap => gap.detail.replace(/`/g, ''));
}

function getHealthStatusMap(health: TrackingHealthReport | null): Map<string, TrackingHealthReport['eventStatus'][number]> {
  return new Map((health?.eventStatus || []).map(item => [item.eventName, item]));
}

function formatEvidenceLabel(args: {
  eventName: string;
  health: TrackingHealthReport | null;
}): string {
  if (!args.health) return 'none in this audit run';
  const status = getHealthStatusMap(args.health).get(args.eventName);
  if (!status) return 'no matching preview record';
  return status.fired ? 'verified in preview' : `preview run exists, but marked ${status.failureCategory || 'failed'}`;
}

function formatAuditVerdict(args: {
  eventName: string;
  schemaEvent: GA4Event | undefined;
  gapSummary: HealthAuditSchemaGapSummary;
}): { verdict: string; reason: string } {
  if (!args.schemaEvent) {
    return {
      verdict: 'not carried forward',
      reason: 'The candidate plan does not keep this live event in the reviewed schema.',
    };
  }

  const gapReasons = getEventGapReasons(args.eventName, args.gapSummary);
  if (gapReasons.length > 0) {
    return {
      verdict: 'needs repair',
      reason: gapReasons[0],
    };
  }

  return {
    verdict: 'reusable',
    reason: 'The live event can be kept in the new plan without a known schema gap.',
  };
}

function explainEvidenceState(args: {
  health: TrackingHealthReport | null;
  currentSchema: EventSchema;
}): {
  label: string;
  stale: boolean;
  summary: string;
} {
  if (!args.health) {
    return {
      label: 'missing',
      stale: true,
      summary: 'No formal tracking-health verdict is available for the current artifact.',
    };
  }

  const schemaTime = Date.parse(args.currentSchema.generatedAt);
  const healthTime = Date.parse(args.health.generatedAt);
  if (!Number.isNaN(schemaTime) && !Number.isNaN(healthTime) && healthTime < schemaTime) {
    return {
      label: 'stale',
      stale: true,
      summary: 'The latest tracking-health evidence is older than the current schema, so it should be treated as stale.',
    };
  }

  return {
    label: 'current',
    stale: false,
    summary: `Formal tracking-health verdict available (${args.health.grade}, generated ${args.health.generatedAt}).`,
  };
}

function renderUpkeepBucketItems(args: {
  items: UpkeepPreviewAssessment['items'];
  statuses: UpkeepPreviewStatus[];
  health: TrackingHealthReport | null;
  evidenceState: ReturnType<typeof explainEvidenceState>;
}): string {
  const filtered = args.items.filter(item => args.statuses.includes(item.status));
  if (filtered.length === 0) return 'none';

  return filtered.map(item => {
    const evidenceType = (!args.health || args.evidenceState.stale || item.status === 'drift' || item.status === 'not_observable')
      ? 'schema comparison only'
      : 'automation evidence';
    return `${code(item.eventName)} (${evidenceType})`;
  }).join(', ');
}

function collectParameterCoverage(schema: EventSchema): Array<{
  name: string;
  events: GA4Event[];
  parameters: GA4Parameter[];
}> {
  const coverage = new Map<string, { events: GA4Event[]; parameters: GA4Parameter[] }>();

  for (const event of schema.events) {
    for (const parameter of event.parameters) {
      const existing = coverage.get(parameter.name) || { events: [], parameters: [] };
      existing.events.push(event);
      existing.parameters.push(parameter);
      coverage.set(parameter.name, existing);
    }
  }

  return Array.from(coverage.entries())
    .map(([name, value]) => ({ name, ...value }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function deriveCommonPropertyNames(schema: EventSchema): Set<string> {
  if (schema.events.length === 0) return new Set<string>();
  const threshold = Math.ceil(schema.events.length * 0.6);
  return new Set(
    collectParameterCoverage(schema)
      .filter(item => item.events.length >= threshold)
      .map(item => item.name),
  );
}

function summarizeParameterValues(parameters: GA4Parameter[]): string {
  const values = uniq(parameters.map(parameter => parameter.value));
  if (values.length === 0) return '—';
  if (values.length === 1) return values[0];
  return values.join(' / ');
}

function summarizeParameterMeaning(parameters: GA4Parameter[]): string {
  const meanings = uniq(parameters.map(parameter => parameter.description));
  if (meanings.length === 0) return '—';
  if (meanings.length === 1) return meanings[0];
  return meanings.join(' / ');
}

export function renderPageGroupSummary(pageGroups: PageGroup[]): string {
  const lines: string[] = [
    'Page Group Summary',
    '',
    `Grouped ${pageGroups.length} page groups. The grouping is organized by business meaning and content type first, with URL patterns used only as shorthand and shared/global elements split out when needed.`,
    '',
    'Group Table',
    '',
    ...renderTable(
      ['Group name', 'Business meaning / content type', 'URL pattern', 'Page count'],
      pageGroups.map(group => [
        group.displayName || group.name,
        `${group.description} (${group.contentType})`,
        group.urlPattern || 'All pages',
        String(group.urls.length),
      ]),
    ),
  ];

  return lines.join('\n');
}

export function renderTrackingPlanSummary(args: {
  schema: EventSchema;
  baseline?: ExistingTrackingBaseline | null;
  liveDelta?: LiveTrackingDelta | null;
}): string {
  const commonProperties = deriveCommonPropertyNames(args.schema);
  const lines: string[] = [
    'Tracking Plan Summary',
    '',
    `This plan covers ${args.schema.events.length} event(s). Review the event table first, then the shared properties, then the event-specific details.`,
    '',
    'A. Event Table',
    '',
    ...renderTable(
      ['Event name', 'Trigger type', 'Page scope', 'Priority', 'Business purpose'],
      [...args.schema.events]
        .sort((left, right) => left.eventName.localeCompare(right.eventName))
        .map(event => [
          code(event.eventName),
          event.triggerType,
          humanizePattern(event.pageUrlPattern),
          event.priority,
          summarizeBusinessPurpose(event),
        ]),
    ),
    '',
    'B. Common Properties',
    '',
    ...renderTable(
      ['Property', 'Value / source', 'Meaning'],
      collectParameterCoverage(args.schema)
        .filter(item => commonProperties.has(item.name))
        .map(item => [
          code(item.name),
          summarizeParameterValues(item.parameters),
          summarizeParameterMeaning(item.parameters),
        ]),
    ),
    '',
    'C. Event-specific Properties',
    '',
    ...renderTable(
      ['Event name', 'Property', 'Value / source', 'Meaning'],
      [...args.schema.events]
        .sort((left, right) => left.eventName.localeCompare(right.eventName))
        .flatMap(event =>
          event.parameters
            .filter(parameter => !commonProperties.has(parameter.name))
            .map(parameter => [
              code(event.eventName),
              code(parameter.name),
              parameter.value,
              parameter.description,
            ]),
        ),
    ),
  ];

  if (args.liveDelta && args.baseline) {
    const notCarriedForward = args.baseline.events
      .filter(event => !args.schema.events.some(schemaEvent => schemaEvent.eventName === event.eventName))
      .map(event => code(event.eventName));
    lines.push(
      '',
      'Comparison Snapshot',
      '',
      `- Reused and upgraded: ${args.liveDelta.changes.filter(change => change.status === 'reused').map(change => code(change.eventName)).join(', ') || 'none'}`,
      `- Net-new: ${args.liveDelta.changes.filter(change => change.status === 'new').map(change => code(change.eventName)).join(', ') || 'none'}`,
      `- Not carried forward: ${notCarriedForward.join(', ') || 'none'}`,
    );
  }

  return lines.join('\n');
}

export function renderAuditSummary(args: {
  schema: EventSchema;
  analysis: SiteAnalysis;
  baseline: ExistingTrackingBaseline;
  liveDelta: LiveTrackingDelta;
  gapSummary: HealthAuditSchemaGapSummary;
  previewSummary: HealthAuditPreviewSummary;
  recommendation: HealthAuditRecommendation;
  health: TrackingHealthReport | null;
  previewResult?: PreviewResult | null;
}): string {
  const schemaEventMap = getEventMap(args.schema);
  const liveEventNames = args.baseline.events.map(event => event.eventName);
  const notCarriedForward = args.baseline.events
    .filter(event => !schemaEventMap.has(event.eventName))
    .map(event => ({
      eventName: event.eventName,
      reason: formatAuditVerdict({
        eventName: event.eventName,
        schemaEvent: schemaEventMap.get(event.eventName),
        gapSummary: args.gapSummary,
      }).reason,
    }));
  const comparisonRows = [...args.schema.events]
    .sort((left, right) => left.eventName.localeCompare(right.eventName))
    .map(event => [
      code(event.eventName),
      humanizePattern(event.pageUrlPattern),
      summarizeBusinessPurpose(event),
      inferAddOrChangeReason(event, args.liveDelta),
    ]);

  const answer = args.recommendation.shouldEnterNewSetup
    ? 'Answer: the live setup has enough high-risk gaps that a rebuild path is safer than patching individual tags.'
    : 'Answer: the live setup looks repairable, so a targeted tracking upgrade path is reasonable before any rebuild decision.';
  const previewEvidenceLine = args.health
    ? `Preview-verified automation evidence exists for ${args.health.eventStatus.length} event(s) from a formal preview run.`
    : 'Current audit run has no formal preview-verified automation evidence; this summary is based on live runtime inspection plus schema-gap analysis.';

  const lines: string[] = [
    'Tracking Health Audit Summary',
    '',
    answer,
    '',
    'A. Legacy / live tracking summary',
    '',
    ...renderList('Runtime-detected live definitions', liveEventNames),
    previewEvidenceLine,
    '',
    ...renderTable(
      ['Legacy event', 'Live GTM detected', 'Preview automation evidence', 'Current judgment', 'Why'],
      args.baseline.events.map(event => {
        const verdict = formatAuditVerdict({
          eventName: event.eventName,
          schemaEvent: schemaEventMap.get(event.eventName),
          gapSummary: args.gapSummary,
        });
        return [
          code(event.eventName),
          'yes',
          formatEvidenceLabel({ eventName: event.eventName, health: args.health }),
          verdict.verdict,
          verdict.reason,
        ];
      }),
    ),
    '',
    'B. New vs old tracking comparison',
    '',
    ...renderTable(
      ['Event name', 'Page', 'Business goal', 'Why this event should be added'],
      comparisonRows,
    ),
    '',
    `Old events not carried forward: ${notCarriedForward.length > 0 ? notCarriedForward.map(item => `${code(item.eventName)} (${item.reason})`).join(', ') : 'none'}`,
    '',
    'C. Next-step guidance',
    '',
    args.recommendation.shouldEnterNewSetup
      ? '- Recommended path: rebuild tracking (`rebuild tracking`) instead of patching the current live tags one by one.'
      : '- Recommended path: targeted tracking upgrade / repair, meaning update the existing tags and payloads without redesigning the entire setup.',
    `- Why: ${args.recommendation.reason}`,
    '- If you want formal proof that the reviewed events fire correctly, the next stage still needs a real preview verification after GTM config is generated and synced.',
    '- Still needed from you: approval on the candidate event list, the destination GA4 measurement ID / GTM workspace, and any login-only or checkout-only journeys that automation cannot reach.',
  ];

  return lines.join('\n');
}

export function renderUpkeepSummary(args: {
  currentSchema: EventSchema;
  baselineSchema: EventSchema;
  diff: SchemaDiffResult;
  previewAssessment: UpkeepPreviewAssessment;
  nextStep: UpkeepNextStepRecommendation;
  health: TrackingHealthReport | null;
  previewResult?: PreviewResult | null;
}): string {
  const evidenceState = explainEvidenceState({
    health: args.health,
    currentSchema: args.currentSchema,
  });
  const healthyCount = args.previewAssessment.items.filter(item => item.status === 'healthy').length;
  const brokenCount = args.previewAssessment.items.filter(item => item.status === 'failure').length;
  const driftCount = args.previewAssessment.items.filter(item => item.status === 'drift' || item.status === 'not_observable').length;
  const answer = brokenCount > 0 || driftCount > 0 || evidenceState.stale
    ? 'Answer: the current setup needs maintenance review before it can be treated as healthy.'
    : 'Answer: the current setup looks healthy against the latest upkeep evidence.';

  const comparisonRows = [
    ...args.diff.added.map(event => [
      'added',
      code(event.eventName),
      humanizePattern(event.pageUrlPattern),
      summarizeBusinessPurpose(event),
      'New tracking coverage was requested or is now recommended.',
    ]),
    ...args.diff.changed.map(change => [
      'changed',
      code(change.eventName),
      humanizePattern(change.after.pageUrlPattern),
      summarizeBusinessPurpose(change.after),
      'The recommended definition changed, so existing tagging or reporting may need repair.',
    ]),
    ...args.diff.removed.map(event => [
      'removed',
      code(event.eventName),
      humanizePattern(event.pageUrlPattern),
      summarizeBusinessPurpose(event),
      'This event is no longer part of the maintained schema and may need retirement from live GTM.',
    ]),
  ];

  const nextStepLine = args.nextStep.trackingUpdateRequired
    ? '- Recommended path: continue with tracking upgrade / repair, meaning keep the current implementation but fix drift, broken events, or scoped schema changes.'
    : '- Recommended path: no schema upgrade is required right now, but evidence should stay fresh.';
  const commandReason = !args.health
    ? 'Run preview next because there is no formal tracking-health verdict for the current artifact yet.'
    : evidenceState.stale
      ? 'Run preview next because the available tracking-health evidence is older than the current schema.'
      : (brokenCount > 0 || driftCount > 0)
        ? 'Run preview again after repairs because the current upkeep evidence shows broken or drifted events.'
        : 'No immediate preview rerun is required unless you want a fresh release check.';

  const lines: string[] = [
    'Upkeep Summary',
    '',
    answer,
    '',
    'A. Current tracking health summary',
    '',
    `- Still healthy events: ${healthyCount}`,
    `- Broken events: ${brokenCount}`,
    `- Drifted / stale evidence events: ${driftCount}`,
    `- Automation evidence: ${evidenceState.summary}`,
  ];

  if (!args.health) {
    lines.push('- Current health verdict: none. Preview evidence is missing, so event status falls back to schema comparison only.');
  } else if (evidenceState.stale) {
    lines.push('- Current health verdict: present but stale. The preview evidence may reflect an older schema.');
  } else {
    lines.push(`- Current health verdict: ${args.health.grade} (${args.health.score === null ? 'manual' : `${args.health.score}/100`}).`);
  }

  lines.push(
    `- Still healthy events: ${renderUpkeepBucketItems({ items: args.previewAssessment.items, statuses: ['healthy'], health: args.health, evidenceState })}`,
    `- Broken events: ${renderUpkeepBucketItems({ items: args.previewAssessment.items, statuses: ['failure'], health: args.health, evidenceState })}`,
    `- Drifted / stale evidence events: ${renderUpkeepBucketItems({ items: args.previewAssessment.items, statuses: ['drift', 'not_observable'], health: args.health, evidenceState })}`,
    '',
    'B. Current vs baseline comparison',
    '',
    ...renderTable(
      ['Change type', 'Event name', 'Page', 'Business goal', 'Maintenance reason'],
      comparisonRows,
    ),
  );

  if (comparisonRows.length === 0) {
    lines.push('', '- No schema changes were found, but verification evidence can still be missing or stale, so a re-check may still be warranted.');
  }

  lines.push(
    '',
    'C. Next-step guidance',
    '',
    nextStepLine,
    `- Why: ${args.nextStep.reason}`,
    `- Next run to consider: ${commandReason}`,
    '- Still needed from you: approval on any event additions/removals, access or test accounts for protected journeys, and permission to update or re-verify the active GTM workspace.',
  );

  return lines.join('\n');
}
