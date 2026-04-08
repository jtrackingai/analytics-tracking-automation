import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'event-tracking');

const {
  buildManualTrackingHealthReport,
  buildTrackingHealthReport,
  hasBlockingTrackingHealth,
  writeTrackingHealthHistory,
} = require(path.join(repoRoot, 'dist', 'reporter', 'tracking-health.js'));
const {
  TRACKING_HEALTH_REPORT_FILE,
  writeTrackingHealthReportMarkdown,
} = require(path.join(repoRoot, 'dist', 'reporter', 'tracking-health-report.js'));
const {
  RUN_CONTEXT_FILE,
  resolveOutputRootForArtifact,
  upsertRunContext,
} = require(path.join(repoRoot, 'dist', 'workflow', 'run-index.js'));
const { refreshWorkflowState } = require(path.join(repoRoot, 'dist', 'workflow', 'state.js'));
const { getPageGroupsHash } = require(path.join(repoRoot, 'dist', 'crawler', 'page-analyzer.js'));

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'event-tracking-workflow-enhancements-'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runCli(args) {
  const result = spawnSync(cliPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
  });

  return {
    ...result,
    combinedOutput: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function makePageGroup() {
  return {
    name: 'home_pages',
    displayName: 'Home Pages',
    description: 'Landing and home-like pages',
    contentType: 'marketing',
    urls: ['https://example.com/'],
    urlPattern: '^/$',
    representativeHtml: '<main><button>Start</button></main>',
  };
}

function makeSiteAnalysis() {
  return {
    rootUrl: 'https://example.com',
    rootDomain: 'example.com',
    platform: {
      type: 'generic',
      confidence: 'low',
      signals: [],
    },
    pages: [],
    pageGroups: [makePageGroup()],
    discoveredUrls: ['https://example.com/'],
    skippedUrls: [],
    crawlWarnings: [],
    dataLayerEvents: [],
    gtmPublicIds: [],
  };
}

function makeConfirmedSiteAnalysis() {
  const analysis = makeSiteAnalysis();
  analysis.pageGroupsReview = {
    status: 'confirmed',
    confirmedAt: '2026-04-08T00:00:00.000Z',
    confirmedHash: getPageGroupsHash(analysis.pageGroups),
  };
  return analysis;
}

function makeEvent(eventName = 'signup_click', overrides = {}) {
  return {
    eventName,
    description: `Tracks ${eventName}`,
    triggerType: 'click',
    elementSelector: `button.${eventName}`,
    pageUrlPattern: '^/$',
    parameters: [
      {
        name: 'page_location',
        value: '{{Page URL}}',
        description: 'Current page URL',
      },
    ],
    priority: 'high',
    ...overrides,
  };
}

function makeEventSchema(events = [makeEvent()]) {
  return {
    siteUrl: 'https://example.com',
    generatedAt: '2026-04-08T00:00:00.000Z',
    events,
  };
}

function makeLiveGtmAnalysis(overrides = {}) {
  return {
    siteUrl: 'https://example.com',
    analyzedAt: '2026-04-08T00:00:00.000Z',
    detectedContainerIds: ['GTM-TEST123'],
    primaryContainerId: 'GTM-TEST123',
    containers: [
      {
        publicId: 'GTM-TEST123',
        sourceUrl: 'https://www.googletagmanager.com/gtm.js?id=GTM-TEST123',
        analyzedAt: '2026-04-08T00:00:00.000Z',
        resourceVersion: '1',
        measurementIds: ['G-TEST1234'],
        configTagIds: ['10'],
        events: [],
        warnings: [],
      },
    ],
    aggregatedEvents: [
      {
        eventName: 'signup_click',
        containers: ['GTM-TEST123'],
        measurementIds: ['G-TEST1234'],
        parameterNames: ['link_text'],
        triggerTypes: ['click'],
        selectors: ['button.signup'],
        urlPatterns: ['^/$'],
        confidence: 'high',
      },
    ],
    warnings: [],
    ...overrides,
  };
}

function makeTrackingHealthReport(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-04-08T00:01:00.000Z',
    siteUrl: 'https://example.com',
    gtmContainerId: 'GTM-TEST123',
    mode: 'automated',
    score: 92,
    grade: 'good',
    rawFiringRate: 100,
    adjustedFiringRate: 100,
    totalSchemaEvents: 2,
    totalExpected: 2,
    totalFired: 2,
    totalFailed: 0,
    redundantAutoEventsSkipped: 0,
    actionableFailures: 0,
    expectedManualFailures: 0,
    highPriorityFailures: 0,
    selectorMismatches: 0,
    configErrors: 0,
    unexpectedFiredCount: 0,
    unexpectedEventNames: [],
    blockers: [],
    recommendations: [],
    eventStatus: [
      { eventName: 'signup_click', fired: true, priority: 'high' },
      { eventName: 'pricing_click', fired: true, priority: 'medium' },
    ],
    ...overrides,
  };
}

test('generate-spec writes tracking-plan-comparison.md when live GTM baseline is available', t => {
  const artifactDir = makeTempDir();
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));

  const schemaFile = path.join(artifactDir, 'event-schema.json');
  writeJson(schemaFile, makeEventSchema([
    makeEvent('signup_click', {
      parameters: [
        { name: 'page_location', value: '{{Page URL}}', description: 'Current page URL' },
        { name: 'page_title', value: '{{Page Title}}', description: 'Current page title' },
        { name: 'link_text', value: '{{Click Text}}', description: 'Clicked text' },
      ],
    }),
    makeEvent('pricing_click', { priority: 'medium' }),
  ]));
  writeJson(path.join(artifactDir, 'live-gtm-analysis.json'), makeLiveGtmAnalysis({
    warnings: ['Some trigger conditions were inferred from public GTM runtime data.'],
  }));

  const result = runCli(['generate-spec', schemaFile]);
  assert.equal(result.status, 0, result.combinedOutput);
  assert.match(result.combinedOutput, /Comparison report:/);

  const comparisonFile = path.join(artifactDir, 'tracking-plan-comparison.md');
  assert.ok(fs.existsSync(comparisonFile), 'comparison report should be generated');

  const comparison = fs.readFileSync(comparisonFile, 'utf8');
  assert.match(comparison, /# Tracking Plan Comparison Report/);
  assert.match(comparison, /\| Existing tracking problem \| Optimization in new plan \| Expected benefit \|/);
  assert.match(comparison, /\| Event \| Existing live payload params \| New plan payload params \| Optimization \| Benefit \| Legacy issue \|/);
  assert.match(comparison, /Live event payload lacked consistent page context fields\./);
  assert.match(comparison, /Some trigger conditions were inferred from public GTM runtime data\./);

  const workflowState = readJson(path.join(artifactDir, 'workflow-state.json'));
  assert.equal(workflowState.artifacts.trackingPlanComparison, true);
});

test('status --json and runs --json expose a run index for resumed workflows', t => {
  const outputRoot = makeTempDir();
  const artifactDir = path.join(outputRoot, 'example_com');
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));

  const analysisFile = path.join(artifactDir, 'site-analysis.json');
  writeJson(analysisFile, makeSiteAnalysis());

  const confirmResult = runCli(['confirm-page-groups', analysisFile, '--yes']);
  assert.equal(confirmResult.status, 0, confirmResult.combinedOutput);

  const statusResult = runCli(['status', analysisFile, '--json']);
  assert.equal(statusResult.status, 0, statusResult.combinedOutput);
  const workflowState = JSON.parse(statusResult.stdout);
  assert.equal(workflowState.currentCheckpoint, 'group_approved');
  assert.equal(workflowState.artifactDir, artifactDir);
  assert.equal(workflowState.artifacts.siteAnalysis, true);

  const indexFile = path.join(outputRoot, '.event-tracking-runs.jsonl');
  assert.ok(fs.existsSync(indexFile), 'run index should be written next to artifact directories');
  assert.ok(fs.existsSync(path.join(artifactDir, RUN_CONTEXT_FILE)), 'run context should be stored in the artifact directory');
  const indexedRuns = fs.readFileSync(indexFile, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(indexedRuns[0].artifactDir, artifactDir);
  assert.equal(indexedRuns[0].currentCheckpoint, 'group_approved');

  const runsResult = runCli(['runs', outputRoot, '--json']);
  assert.equal(runsResult.status, 0, runsResult.combinedOutput);
  const runsPayload = JSON.parse(runsResult.stdout);
  assert.equal(runsPayload.outputRoot, outputRoot);
  assert.equal(runsPayload.runs[0].artifactDir, artifactDir);
});

test('cli version comes from package.json instead of a hardcoded string', () => {
  const packageJson = readJson(path.join(repoRoot, 'package.json'));
  const versionResult = runCli(['--version']);
  assert.equal(versionResult.status, 0, versionResult.combinedOutput);
  assert.equal(versionResult.stdout.trim(), packageJson.version);
});

test('confirm-schema writes restore snapshots and schema decision audit entries', t => {
  const artifactDir = makeTempDir();
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));

  const schemaFile = path.join(artifactDir, 'event-schema.json');
  writeJson(schemaFile, makeEventSchema());

  const firstConfirm = runCli(['confirm-schema', schemaFile, '--yes']);
  assert.equal(firstConfirm.status, 0, firstConfirm.combinedOutput);

  const firstState = readJson(path.join(artifactDir, 'workflow-state.json'));
  const firstSnapshot = path.join(artifactDir, 'schema-restore', `confirmed-${firstState.schemaReview.confirmedHash}.json`);
  assert.ok(fs.existsSync(firstSnapshot), 'first confirmed schema should be restorable by hash');

  writeJson(schemaFile, makeEventSchema([
    makeEvent('signup_click', { description: 'Tracks edited signup clicks' }),
    makeEvent('pricing_click', { priority: 'medium' }),
  ]));

  const secondConfirm = runCli(['confirm-schema', schemaFile, '--yes']);
  assert.equal(secondConfirm.status, 0, secondConfirm.combinedOutput);

  const auditFile = path.join(artifactDir, 'schema-decisions.jsonl');
  const auditEntries = fs.readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));

  assert.equal(auditEntries.length, 2);
  assert.deepEqual(auditEntries[1].summary.added, ['pricing_click']);
  assert.deepEqual(auditEntries[1].summary.changed, ['signup_click']);
  assert.equal(auditEntries[1].previousConfirmedHash, firstState.schemaReview.confirmedHash);
});

test('tracking health scores preview results and diffs against a baseline', () => {
  const signupEvent = makeEvent('signup_click');
  const pricingEvent = makeEvent('pricing_click', { priority: 'medium' });
  const result = {
    siteUrl: 'https://example.com',
    previewStartedAt: '2026-04-08T00:00:00.000Z',
    previewEndedAt: '2026-04-08T00:01:00.000Z',
    gtmContainerId: 'GTM-TEST123',
    totalSchemaEvents: 4,
    totalExpected: 2,
    totalFired: 1,
    totalFailed: 1,
    redundantAutoEventsSkipped: 2,
    unexpectedFiredEvents: [
      {
        eventName: 'legacy_signup_click',
        timestamp: 1712534460000,
        url: 'https://example.com/',
        parameters: { en: 'legacy_signup_click' },
        rawPayload: 'en=legacy_signup_click',
      },
    ],
    results: [
      {
        event: signupEvent,
        fired: true,
        firedCount: 1,
        firedEvents: [],
      },
      {
        event: pricingEvent,
        fired: false,
        firedCount: 0,
        firedEvents: [],
        failureReason: 'Selector did not match.',
        failureCategory: 'selector_mismatch',
      },
    ],
  };
  const baseline = {
    schemaVersion: 1,
    generatedAt: '2026-04-07T00:01:00.000Z',
    siteUrl: 'https://example.com',
    gtmContainerId: 'GTM-TEST123',
    mode: 'automated',
    score: 25,
    grade: 'critical',
    rawFiringRate: 50,
    adjustedFiringRate: 50,
    totalSchemaEvents: 2,
    totalExpected: 2,
    totalFired: 1,
    totalFailed: 1,
    redundantAutoEventsSkipped: 0,
    actionableFailures: 1,
    expectedManualFailures: 0,
    highPriorityFailures: 1,
    selectorMismatches: 1,
    configErrors: 0,
    unexpectedFiredCount: 0,
    unexpectedEventNames: [],
    blockers: [],
    recommendations: [],
    eventStatus: [
      { eventName: 'signup_click', fired: false, priority: 'high', failureCategory: 'selector_mismatch' },
      { eventName: 'pricing_click', fired: true, priority: 'medium' },
    ],
  };

  const health = buildTrackingHealthReport(result, baseline, '/tmp/baseline-health.json');

  assert.equal(health.score, 44);
  assert.equal(health.grade, 'critical');
  assert.equal(health.selectorMismatches, 1);
  assert.equal(health.totalSchemaEvents, 4);
  assert.equal(health.redundantAutoEventsSkipped, 2);
  assert.equal(health.unexpectedFiredCount, 1);
  assert.deepEqual(health.unexpectedEventNames, ['legacy_signup_click']);
  assert.deepEqual(health.baseline.fixedEvents, ['signup_click']);
  assert.deepEqual(health.baseline.newFailures, ['pricing_click']);
  assert.equal(health.baseline.scoreDelta, 19);
});

test('manual tracking health uses null score and stays publish-blocking', () => {
  const manualHealth = buildManualTrackingHealthReport({
    siteUrl: 'https://example.com',
    gtmContainerId: 'GTM-TEST123',
    generatedAt: '2026-04-08T00:02:00.000Z',
    reason: 'Manual verification is still required.',
    totalSchemaEvents: 5,
  });

  assert.equal(manualHealth.mode, 'manual_shopify_verification');
  assert.equal(manualHealth.score, null);
  assert.equal(manualHealth.grade, 'manual_required');
  assert.equal(manualHealth.totalSchemaEvents, 5);
  assert.equal(hasBlockingTrackingHealth(manualHealth), true);
});

test('tracking health history writes timestamped snapshots without overwriting the current report', t => {
  const artifactDir = makeTempDir();
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));

  const historyFile = writeTrackingHealthHistory(artifactDir, makeTrackingHealthReport({
    generatedAt: '2026-04-08T00:03:04.000Z',
  }));

  assert.match(historyFile, /tracking-health-history\/2026-04-08T00-03-04\.000Z\.json$/);
  assert.equal(readJson(historyFile).generatedAt, '2026-04-08T00:03:04.000Z');
});

test('tracking health markdown report is generated and workflow state marks it as present', t => {
  const artifactDir = makeTempDir();
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));

  const reportFile = path.join(artifactDir, TRACKING_HEALTH_REPORT_FILE);
  writeTrackingHealthReportMarkdown(reportFile, makeTrackingHealthReport({
    score: 68,
    grade: 'warning',
    blockers: ['1 selector mismatch(es) need schema or GTM trigger updates.'],
    recommendations: ['Fix selector mismatches and rerun preview.'],
    baseline: {
      previousScore: 54,
      scoreDelta: 14,
      fixedEvents: ['signup_click'],
      newFailures: ['pricing_click'],
      changedEvents: [],
    },
  }));

  const markdown = fs.readFileSync(reportFile, 'utf8');
  assert.match(markdown, /# Tracking Health Report/);
  assert.match(markdown, /\| Score \| 68\/100 \|/);
  assert.match(markdown, /## Baseline Comparison/);
  assert.match(markdown, /pricing_click/);

  writeJson(path.join(artifactDir, 'tracking-health.json'), makeTrackingHealthReport({
    score: 68,
    grade: 'warning',
  }));
  const state = refreshWorkflowState(artifactDir);
  assert.equal(state.artifacts.trackingHealthReport, true);
});

test('run context preserves explicit output roots and falls back after artifact migration', t => {
  const tempRoot = makeTempDir();
  const oldOutputRoot = path.join(tempRoot, 'old-output');
  const newOutputRoot = path.join(tempRoot, 'new-output');
  const originalArtifactDir = path.join(oldOutputRoot, 'nested', 'example_com');
  const movedArtifactDir = path.join(newOutputRoot, 'example_com');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  upsertRunContext({
    artifactDir: originalArtifactDir,
    outputRoot: oldOutputRoot,
    siteUrl: 'https://example.com',
  });
  assert.equal(resolveOutputRootForArtifact(originalArtifactDir), oldOutputRoot);

  fs.mkdirSync(path.dirname(movedArtifactDir), { recursive: true });
  fs.renameSync(originalArtifactDir, movedArtifactDir);

  assert.equal(resolveOutputRootForArtifact(movedArtifactDir), newOutputRoot);
  assert.equal(readJson(path.join(movedArtifactDir, RUN_CONTEXT_FILE)).outputRoot, newOutputRoot);
});

test('workflow state blocks publish recommendations when tracking health has blockers', t => {
  const artifactDir = makeTempDir();
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));

  writeJson(path.join(artifactDir, 'site-analysis.json'), makeConfirmedSiteAnalysis());
  writeJson(path.join(artifactDir, 'event-schema.json'), makeEventSchema());
  writeJson(path.join(artifactDir, 'gtm-context.json'), {
    accountId: '123',
    containerId: '456',
    workspaceId: '789',
  });
  writeJson(path.join(artifactDir, 'preview-result.json'), {
    siteUrl: 'https://example.com',
    generatedAt: '2026-04-08T00:04:00.000Z',
    totalExpected: 2,
    totalFired: 1,
  });
  fs.writeFileSync(path.join(artifactDir, 'preview-report.md'), '# Preview report\n');
  writeJson(path.join(artifactDir, 'tracking-health.json'), makeTrackingHealthReport({
    score: 48,
    grade: 'critical',
    totalFired: 1,
    totalFailed: 1,
    blockers: ['1 high-priority event did not fire.'],
    eventStatus: [
      { eventName: 'signup_click', fired: false, priority: 'high', failureCategory: 'config_error' },
      { eventName: 'pricing_click', fired: true, priority: 'medium' },
    ],
  }));

  const state = refreshWorkflowState(artifactDir);

  assert.equal(state.verification.healthGrade, 'critical');
  assert.match(state.nextAction, /Resolve tracking-health blockers/);
  assert.match(state.nextCommand || '', /preview/);
});

test('publish command blocks before auth when preview health is missing or blocked', t => {
  const artifactDir = makeTempDir();
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));

  const contextFile = path.join(artifactDir, 'gtm-context.json');
  writeJson(contextFile, {
    accountId: '123',
    containerId: '456',
    workspaceId: '789',
  });

  const missingHealthResult = runCli(['publish', '--context-file', contextFile, '--yes']);
  assert.notEqual(missingHealthResult.status, 0);
  assert.match(missingHealthResult.combinedOutput, /Publish blocked/);
  assert.match(missingHealthResult.combinedOutput, /Run preview before publishing/);

  writeJson(path.join(artifactDir, 'tracking-health.json'), makeTrackingHealthReport({
    score: 38,
    grade: 'critical',
    blockers: ['2 high-priority events did not fire.'],
  }));

  const blockedHealthResult = runCli(['publish', '--context-file', contextFile, '--yes']);
  assert.notEqual(blockedHealthResult.status, 0);
  assert.match(blockedHealthResult.combinedOutput, /2 high-priority events did not fire/);
  assert.doesNotMatch(blockedHealthResult.combinedOutput, /Authenticating with Google/);
});
