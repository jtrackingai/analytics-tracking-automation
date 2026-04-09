import { EventSchema } from '../generator/event-schema';
import {
  ExistingTrackingBaseline,
  LiveTrackingChange,
  LiveTrackingDelta,
} from '../generator/live-tracking-insights';

function code(value: string): string {
  return `\`${value}\``;
}

function joinCode(values: string[]): string {
  if (values.length === 0) return 'none';
  return values.map(code).join(', ');
}

function toProblemRows(args: {
  observedProblems: string[];
  solvedProblems: string[];
  benefits: string[];
}): string[] {
  const { observedProblems, solvedProblems, benefits } = args;
  const total = Math.max(observedProblems.length, solvedProblems.length, benefits.length);
  if (total === 0) return ['| _none_ | _none_ | _none_ |'];

  const rows: string[] = [];
  for (let idx = 0; idx < total; idx += 1) {
    rows.push(`| ${observedProblems[idx] || '—'} | ${solvedProblems[idx] || '—'} | ${benefits[idx] || '—'} |`);
  }
  return rows;
}

function inferBenefit(change: LiveTrackingChange): string {
  if (change.status === 'new') return 'Adds measurable coverage for a journey previously not tracked in live GTM.';
  if (change.improvements.some(item => item.includes('adds page context'))) {
    return 'Makes GA4 reporting easier to compare across pages with standardized page context.';
  }
  if (change.improvements.some(item => item.includes('adds click context'))) {
    return 'Improves CTA attribution quality with link/button-level context.';
  }
  if (change.improvements.some(item => item.includes('expands reporting context'))) {
    return 'Adds richer dimensions for segmentation and funnel analysis.';
  }
  return 'Keeps naming continuity with the existing live event definition.';
}

function inferLegacyIssue(change: LiveTrackingChange): string {
  if (change.status === 'new') return 'No equivalent live event found; this journey had a coverage gap.';
  if (change.improvements.some(item => item.includes('adds page context'))) {
    return 'Live event payload lacked consistent page context fields.';
  }
  if (change.improvements.some(item => item.includes('adds click context'))) {
    return 'Live event payload lacked CTA-level context.';
  }
  if (change.improvements.some(item => item.includes('expands reporting context'))) {
    return 'Live event payload had limited parameters for analysis.';
  }
  return 'No critical issue detected; kept for reporting continuity.';
}

function formatEventRow(change: LiveTrackingChange): string {
  const oldShape = change.liveParameterNames.length > 0
    ? joinCode(change.liveParameterNames)
    : '_missing_';
  const newShape = change.schemaParameterNames.length > 0
    ? joinCode(change.schemaParameterNames)
    : '_none_';
  const optimization = change.improvements.length > 0
    ? change.improvements.join('; ')
    : 'Reuses existing definition shape';

  return `| ${code(change.eventName)} | ${oldShape} | ${newShape} | ${optimization} | ${inferBenefit(change)} | ${inferLegacyIssue(change)} |`;
}

export function generateTrackingPlanComparisonReport(args: {
  schema: EventSchema;
  baseline: ExistingTrackingBaseline;
  liveDelta: LiveTrackingDelta;
}): string {
  const { schema, baseline, liveDelta } = args;
  const generatedAt = new Date().toISOString();

  const lines: string[] = [
    '# Tracking Plan Comparison Report',
    '',
    `**Site:** ${schema.siteUrl}`,
    `**Generated:** ${new Date(generatedAt).toLocaleString()}`,
    `**Primary comparison container:** ${baseline.primaryContainerId ? code(baseline.primaryContainerId) : 'none'}`,
    `**Compared live containers:** ${joinCode(baseline.comparedContainerIds)}`,
    '',
    '---',
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Existing live events | ${baseline.totalLiveEvents} |`,
    `| New plan events | ${schema.events.length} |`,
    `| Reused events | ${liveDelta.reusedEventCount} |`,
    `| Net-new events | ${liveDelta.newEventCount} |`,
    `| Existing measurement IDs | ${joinCode(baseline.measurementIds)} |`,
    '',
    '---',
    '',
    '## Existing Tracking Problems vs Optimizations',
    '',
    '| Existing tracking problem | Optimization in new plan | Expected benefit |',
    '| --- | --- | --- |',
    ...toProblemRows({
      observedProblems: baseline.observedProblems,
      solvedProblems: liveDelta.problemsSolved,
      benefits: liveDelta.benefits,
    }),
    '',
    '---',
    '',
    '## Event-Level Comparison',
    '',
    '| Event | Existing live payload params | New plan payload params | Optimization | Benefit | Legacy issue |',
    '| --- | --- | --- | --- | --- | --- |',
    ...liveDelta.changes.map(change => formatEventRow(change)),
    '',
  ];

  if (baseline.observedProblems.length > 0) {
    lines.push(
      '## Legacy Baseline Issues',
      '',
      ...baseline.observedProblems.map(problem => `- ${problem}`),
      '',
    );
  }

  if (liveDelta.carryOverWarnings.length > 0) {
    lines.push(
      '## Carry-Over Warnings',
      '',
      ...liveDelta.carryOverWarnings.map(warning => `- ${warning}`),
      '',
    );
  }

  lines.push('_Generated by event-tracking-skill_');
  return lines.join('\n');
}
