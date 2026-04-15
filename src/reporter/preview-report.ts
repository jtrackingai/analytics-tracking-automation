import { PreviewResult, TagVerificationResult, FailureCategory } from '../gtm/preview';
import * as fs from 'fs';
import * as path from 'path';
import { buildTrackingHealthReport, formatTrackingHealthScore } from './tracking-health';

interface PreviewReportOptions {
  title?: string;
  startedLabel?: string;
  endedLabel?: string;
  manualVerificationLabel?: string;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatDuration(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '_n/a_';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s`;
}

function getStatusEmoji(fired: boolean): string {
  return fired ? '✅' : '❌';
}

function getCategoryLabel(category: FailureCategory | undefined): string {
  switch (category) {
    case 'requires_login':   return '🔐 Requires Login';
    case 'requires_journey': return '🔄 Requires Specific Journey';
    case 'selector_mismatch': return '🎯 Selector Mismatch';
    case 'config_error':     return '❌ Config Error';
    default:                 return '❓ Unknown';
  }
}

function getCategoryNote(category: FailureCategory | undefined): string {
  switch (category) {
    case 'requires_login':
      return '_Manual verification required — cannot be tested without authentication._';
    case 'requires_journey':
      return '_Manual verification required — needs a multi-step user flow (e.g. add to cart, checkout)._';
    case 'selector_mismatch':
      return '_Fixable — update the selector in `event-schema.json`, then re-run `generate-gtm` and `sync`._';
    case 'config_error':
      return '_Investigate — check GTM container setup, measurement ID, and trigger conditions._';
    default:
      return '';
  }
}

function getPriorityLabel(priority: string): string {
  switch (priority) {
    case 'high': return '🔴 High';
    case 'medium': return '🟡 Medium';
    case 'low': return '🟢 Low';
    default: return priority;
  }
}

function formatParameters(params: Record<string, string>): string {
  const relevantParams = Object.entries(params)
    .filter(([k]) => !['v', 'tid', 'cid', 't', 'gtm'].includes(k))
    .slice(0, 10);

  if (relevantParams.length === 0) return '_none_';
  return relevantParams.map(([k, v]) => `\`${k}=${v}\``).join(', ');
}

export function generatePreviewReport(result: PreviewResult, outputPath?: string, opts: PreviewReportOptions = {}): string {
  const trackingHealth = buildTrackingHealthReport(result);
  const totalSchemaEvents = typeof result.totalSchemaEvents === 'number' ? result.totalSchemaEvents : result.totalExpected;
  const redundantAutoEventsSkipped =
    typeof result.redundantAutoEventsSkipped === 'number'
      ? result.redundantAutoEventsSkipped
      : Math.max(0, totalSchemaEvents - result.totalExpected);
  const unexpectedFiredEvents = result.unexpectedFiredEvents || [];
  const unexpectedEventNames = Array.from(new Set(unexpectedFiredEvents.map(event => event.eventName))).sort();
  const firingRate = result.totalExpected > 0
    ? Math.round((result.totalFired / result.totalExpected) * 100)
    : 0;

  const firedResults = result.results.filter(r => r.fired);
  const failedResults = result.results.filter(r => !r.fired);
  const highPriorityFailed = failedResults.filter(r => r.event.priority === 'high');

  // Separate "expected failures" (login/journey) from actionable failures
  const actionableFailures = failedResults.filter(
    r => r.failureCategory === 'selector_mismatch' || r.failureCategory === 'config_error'
  );
  const expectedFailures = failedResults.filter(
    r => r.failureCategory === 'requires_login' || r.failureCategory === 'requires_journey'
  );
  const adjustedFiringRate = result.totalExpected > 0
    ? Math.round(((result.totalFired + expectedFailures.length) / result.totalExpected) * 100)
    : 0;

  const lines: string[] = [
    `# ${opts.title || 'GTM Preview Report'}`,
    ``,
    `**Site:** ${result.siteUrl}`,
    `**Container:** ${result.gtmContainerId}`,
    `**${opts.startedLabel || 'Preview Started'}:** ${formatDateTime(result.previewStartedAt)}`,
    `**${opts.endedLabel || 'Preview Ended'}:** ${formatDateTime(result.previewEndedAt)}`,
    ``,
    `---`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total Schema Events | ${totalSchemaEvents} |`,
    `| Events Verified In Preview | ${result.totalExpected} |`,
    `| Redundant Auto Events Skipped | ${redundantAutoEventsSkipped} |`,
    `| Events Fired ✅ | ${result.totalFired} |`,
    `| Actionable Failures ❌ | ${actionableFailures.length} |`,
    `| Expected Failures (login/journey) ⏭️ | ${expectedFailures.length} |`,
    `| Unexpected Events Fired ℹ️ | ${unexpectedEventNames.length} |`,
    `| Raw Firing Rate | ${firingRate}% |`,
    `| Adjusted Rate (excl. login/journey) | ${adjustedFiringRate}% |`,
    `| High Priority Failures | ${highPriorityFailed.length} |`,
    `| Tracking Health Score | ${formatTrackingHealthScore(trackingHealth.score)} (${trackingHealth.grade}) |`,
    `| Preview Total Duration | ${formatDuration(result.timing?.totalMs)} |`,
    `| Quick Preview Setup | ${formatDuration(result.timing?.quickPreviewMs)} |`,
    `| Preview Env Fetch | ${formatDuration(result.timing?.previewEnvironmentMs)} |`,
    `| Browser Verification | ${formatDuration(result.timing?.browserVerificationMs)} |`,
    ``,
  ];

  // Health indicator based on adjusted rate
  if (adjustedFiringRate >= 80) {
    lines.push(`> ✅ **Good**: Most verifiable events are firing correctly (adjusted ${adjustedFiringRate}%).`);
    if (expectedFailures.length > 0) {
      lines.push(`> ℹ️  ${expectedFailures.length} event(s) require login or specific journeys — verify manually.`);
    }
  } else if (adjustedFiringRate >= 50) {
    lines.push(`> ⚠️ **Warning**: Only ${adjustedFiringRate}% of verifiable events fired. Review actionable failures below.`);
  } else {
    lines.push(`> ❌ **Critical**: Only ${adjustedFiringRate}% of verifiable events fired. Check GTM container setup and measurement ID.`);
  }

  if (unexpectedEventNames.length > 0) {
    lines.push(`> ℹ️  Unexpected events detected outside the approved schema: ${unexpectedEventNames.map(name => `\`${name}\``).join(', ')}.`);
  }

  lines.push('', '---', '');

  // Failed events grouped by category
  if (failedResults.length > 0) {
    lines.push(`## ❌ Events Not Fired (${failedResults.length})`);
    lines.push('');
    lines.push('> Failures are grouped by category. **Selector Mismatch** and **Config Error** are actionable.');
    lines.push('> **Requires Login / Journey** events cannot be tested by automation — verify manually in GTM Tag Assistant.');
    lines.push('');

    const categories: Array<{ key: FailureCategory; label: string }> = [
      { key: 'config_error',      label: '❌ Config Error — Fix Required' },
      { key: 'selector_mismatch', label: '🎯 Selector Mismatch — Fix Required' },
      { key: 'requires_login',    label: '🔐 Requires Login — Manual Verification' },
      { key: 'requires_journey',  label: '🔄 Requires Specific Journey — Manual Verification' },
    ];

    for (const { key, label } of categories) {
      const group = failedResults.filter(r => r.failureCategory === key);
      if (group.length === 0) continue;

      lines.push(`### ${label} (${group.length})`);
      lines.push('');
      lines.push(getCategoryNote(key));
      lines.push('');

      const sorted = [...group].sort((a, b) => {
        const order = { high: 0, medium: 1, low: 2 };
        return (order[a.event.priority as keyof typeof order] ?? 1) - (order[b.event.priority as keyof typeof order] ?? 1);
      });

      for (const r of sorted) {
        lines.push(`#### ${getStatusEmoji(r.fired)} \`${r.event.eventName}\``);
        lines.push('');
        lines.push(`- **Priority:** ${getPriorityLabel(r.event.priority)}`);
        lines.push(`- **Trigger Type:** ${r.event.triggerType}`);
        lines.push(`- **Description:** ${r.event.description}`);
        if (r.event.elementSelector) {
          lines.push(`- **Element Selector:** \`${r.event.elementSelector}\``);
        }
        if (r.event.pageUrlPattern) {
          lines.push(`- **Page Pattern:** \`${r.event.pageUrlPattern}\``);
        }
        lines.push(`- **Reason:** ${r.failureReason}`);
        if (r.event.notes) {
          lines.push(`- **Notes:** ${r.event.notes}`);
        }
        lines.push('');
      }
    }

    lines.push('---', '');
  }

  // Successfully fired events
  if (firedResults.length > 0) {
    lines.push(`## ✅ Events Fired Successfully (${firedResults.length})`);
    lines.push('');

    for (const r of firedResults) {
      lines.push(`### ✅ \`${r.event.eventName}\` (fired ${r.firedCount}x)`);
      lines.push('');
      lines.push(`- **Priority:** ${getPriorityLabel(r.event.priority)}`);
      lines.push(`- **Trigger Type:** ${r.event.triggerType}`);
      lines.push(`- **Description:** ${r.event.description}`);

      if (r.firedEvents.length > 0) {
        const sample = r.firedEvents[0];
        lines.push(`- **Sample Parameters:** ${formatParameters(sample.parameters)}`);
        lines.push(`- **Page:** ${sample.url}`);
      }
      lines.push('');
    }

    lines.push('---', '');
  }

  if (unexpectedFiredEvents.length > 0) {
    lines.push(`## ℹ️ Unexpected Events Fired (${unexpectedEventNames.length})`);
    lines.push('');
    lines.push('> These events fired during preview but are not defined in the current schema. Review them for duplicate tracking, legacy GTM tags, or unrelated container activity.');
    lines.push('');

    for (const eventName of unexpectedEventNames) {
      const group = unexpectedFiredEvents.filter(event => event.eventName === eventName);
      const sample = group[0];
      lines.push(`### \`${eventName}\` (${group.length} hit${group.length > 1 ? 's' : ''})`);
      lines.push('');
      lines.push(`- **Sample Page:** ${sample?.url || '_unknown_'}`);
      lines.push(`- **Sample Parameters:** ${sample ? formatParameters(sample.parameters) : '_none_'}`);
      lines.push('');
    }

    lines.push('---', '');
  }

  // Recommendations
  lines.push('## 3. Recommendations');
  lines.push('');
  lines.push('### 3.1 Recommended Next Actions');
  lines.push('');

  if (highPriorityFailed.length > 0) {
    lines.push(`1. **Fix high priority failures first:** ${highPriorityFailed.map(r => `\`${r.event.eventName}\``).join(', ')}`);
    lines.push('');
  }

  if (failedResults.some(r => r.event.triggerType === 'click')) {
    lines.push('2. **Click triggers:** Verify CSS selectors match actual rendered elements. Use browser DevTools to test selectors.');
    lines.push('');
  }

  if (failedResults.some(r => r.event.triggerType === 'form_submit')) {
    lines.push('3. **Form submit triggers:** Forms with validation or CAPTCHA cannot be submitted by automation. Manual testing required.');
    lines.push('');
  }

  if (firingRate < 100) {
    lines.push(`4. **Manual verification:** ${opts.manualVerificationLabel || 'After fixing issues, re-run preview or manually verify in GTM Tag Assistant.'}`);
    lines.push('');
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`_Report generated by event-tracking-skill at ${formatDateTime(result.previewEndedAt)}_`);

  const report = lines.join('\n');

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, report, 'utf-8');
  }

  return report;
}
