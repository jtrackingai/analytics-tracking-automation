import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'event-tracking');

const { refreshWorkflowState } = require(path.join(repoRoot, 'dist', 'workflow', 'state.js'));
const { getPageGroupsHash } = require(path.join(repoRoot, 'dist', 'crawler', 'page-analyzer.js'));

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'event-tracking-skill-test-'));
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

function makeSiteAnalysis({ confirmed = false } = {}) {
  const pageGroups = [makePageGroup()];
  const analysis = {
    rootUrl: 'https://example.com',
    rootDomain: 'example.com',
    platform: {
      type: 'generic',
      confidence: 'low',
      signals: [],
    },
    pages: [],
    pageGroups,
    discoveredUrls: ['https://example.com/'],
    skippedUrls: [],
    crawlWarnings: [],
    dataLayerEvents: [],
  };

  if (confirmed) {
    analysis.pageGroupsReview = {
      status: 'confirmed',
      confirmedAt: '2026-04-03T00:00:00.000Z',
      confirmedHash: getPageGroupsHash(pageGroups),
    };
  }

  return analysis;
}

function makeEventSchema() {
  return {
    siteUrl: 'https://example.com',
    generatedAt: '2026-04-03T00:00:00.000Z',
    events: [
      {
        eventName: 'signup_click',
        description: 'Tracks clicks on the primary signup CTA',
        triggerType: 'click',
        elementSelector: 'button.signup',
        pageUrlPattern: '^/$',
        parameters: [
          {
            name: 'page_location',
            value: '{{Page URL}}',
            description: 'Current page URL',
          },
        ],
        priority: 'high',
      },
    ],
  };
}

test('workflow state recommends schema preparation after confirmed page groups', t => {
  const artifactDir = makeTempDir();
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));

  const analysisFile = path.join(artifactDir, 'site-analysis.json');
  writeJson(analysisFile, makeSiteAnalysis({ confirmed: true }));

  const state = refreshWorkflowState(artifactDir);

  assert.equal(state.currentCheckpoint, 'group_approved');
  assert.deepEqual(state.completedCheckpoints, ['analyzed', 'grouped', 'group_approved']);
  assert.match(state.nextCommand || '', /prepare-schema/);
});

test('confirm-page-groups updates review metadata and status can resume from a file path', t => {
  const artifactDir = makeTempDir();
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));

  const analysisFile = path.join(artifactDir, 'site-analysis.json');
  writeJson(analysisFile, makeSiteAnalysis());

  const confirmResult = runCli(['confirm-page-groups', analysisFile, '--yes']);
  assert.equal(confirmResult.status, 0, confirmResult.combinedOutput);

  const updatedAnalysis = readJson(analysisFile);
  assert.equal(updatedAnalysis.pageGroupsReview.status, 'confirmed');
  assert.equal(updatedAnalysis.pageGroupsReview.confirmedHash, getPageGroupsHash(updatedAnalysis.pageGroups));

  const workflowState = readJson(path.join(artifactDir, 'workflow-state.json'));
  assert.equal(workflowState.currentCheckpoint, 'group_approved');

  const statusResult = runCli(['status', analysisFile]);
  assert.equal(statusResult.status, 0, statusResult.combinedOutput);
  assert.match(statusResult.stdout, /Current checkpoint: group_approved/);
  assert.match(statusResult.stdout, /prepare-schema/);
});

test('prepare-schema refuses unconfirmed page groups', t => {
  const artifactDir = makeTempDir();
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));

  const analysisFile = path.join(artifactDir, 'site-analysis.json');
  writeJson(analysisFile, makeSiteAnalysis());

  const result = runCli(['prepare-schema', analysisFile]);

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /pageGroups are not explicitly confirmed/);
  assert.match(result.combinedOutput, /confirm-page-groups/);
});

test('generate-gtm blocks when schema confirmation becomes stale after edits', t => {
  const artifactDir = makeTempDir();
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));

  const schemaFile = path.join(artifactDir, 'event-schema.json');
  writeJson(schemaFile, makeEventSchema());

  const confirmResult = runCli(['confirm-schema', schemaFile, '--yes']);
  assert.equal(confirmResult.status, 0, confirmResult.combinedOutput);

  const updatedSchema = makeEventSchema();
  updatedSchema.events[0].description = 'Tracks clicks on the edited signup CTA';
  writeJson(schemaFile, updatedSchema);

  const result = runCli(['generate-gtm', schemaFile, '--measurement-id', 'G-TEST1234']);

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /event-schema\.json is not currently confirmed/);
  assert.match(result.combinedOutput, /changed after the last schema confirmation/);
  assert.match(result.combinedOutput, /confirm-schema/);
});

test('generate-gtm can still proceed with --force after a stale confirmation', t => {
  const artifactDir = makeTempDir();
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));

  const schemaFile = path.join(artifactDir, 'event-schema.json');
  writeJson(schemaFile, makeEventSchema());

  const confirmResult = runCli(['confirm-schema', schemaFile, '--yes']);
  assert.equal(confirmResult.status, 0, confirmResult.combinedOutput);

  const updatedSchema = makeEventSchema();
  updatedSchema.events[0].notes = 'Edited after confirmation';
  writeJson(schemaFile, updatedSchema);

  const result = runCli([
    'generate-gtm',
    schemaFile,
    '--measurement-id',
    'G-TEST1234',
    '--force',
  ]);

  assert.equal(result.status, 0, result.combinedOutput);
  assert.ok(fs.existsSync(path.join(artifactDir, 'gtm-config.json')));
});
