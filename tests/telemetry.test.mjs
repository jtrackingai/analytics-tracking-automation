import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  buildTelemetryPayload,
  sanitizeTelemetryParams,
  getTelemetryConsentMessage,
  getTelemetryConsentStatus,
  ensureTelemetryConsentGate,
  captureSkillInit,
} = require(path.join(repoRoot, 'dist', 'telemetry.js'));

test('telemetry payload uses GA4 Measurement Protocol shape', () => {
  const payload = buildTelemetryPayload('client-123', 'site_analyzed', {
    command_name: 'analyze',
    status: 'success',
    duration_ms: 42,
    page_count: 3,
  });

  assert.equal(payload.client_id, 'client-123');
  assert.equal(payload.events.length, 1);
  assert.equal(payload.events[0].name, 'site_analyzed');
  assert.equal(payload.events[0].params.command_name, 'analyze');
  assert.equal(payload.events[0].params.surface, 'cli');
  assert.equal(payload.events[0].params.engagement_time_msec, 1);
});

test('startup telemetry event is supported for command invocation tracking', () => {
  const payload = buildTelemetryPayload('session-123', 'init_skill', {
    command_name: 'run-new-setup',
  });

  assert.equal(payload.client_id, 'session-123');
  assert.equal(payload.events.length, 1);
  assert.equal(payload.events[0].name, 'init_skill');
  assert.equal(payload.events[0].params.command_name, 'run-new-setup');
  assert.equal(payload.events[0].params.surface, 'cli');
});

test('startup telemetry prefers persisted client id when config exists', async () => {
  const originalConfig = process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE;
  const originalFetch = global.fetch;
  const configFile = path.join(repoRoot, 'tmp', 'init-skill-telemetry.json');
  const capturedBodies = [];

  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({
    telemetryEnabled: false,
    clientId: 'persisted-client-123',
    decidedAt: '2026-04-28T00:00:00.000Z',
  }));
  process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE = configFile;
  global.fetch = async (_url, options) => {
    capturedBodies.push(JSON.parse(String(options.body)));
    return {
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };

  await captureSkillInit('run-new-setup');

  assert.equal(capturedBodies.length, 1);
  assert.equal(capturedBodies[0].client_id, 'persisted-client-123');
  assert.equal(capturedBodies[0].events[0].name, 'init_skill');

  fs.rmSync(configFile, { force: true });
  global.fetch = originalFetch;
  if (originalConfig === undefined) delete process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE;
  else process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE = originalConfig;
});

test('telemetry sanitizer drops sensitive and unknown fields', () => {
  const params = sanitizeTelemetryParams({
    command_name: 'sync',
    status: 'success',
    site_hostname: 'customer.example',
    site_url: 'https://customer.example',
    rootDomain: 'customer.example',
    measurement_id: 'G-SECRET123',
    gtm_public_id: 'GTM-SECRET',
    account_id: '123',
    file_path: '/Users/example/output/site-analysis.json',
    selector: 'button.private',
    error_stack: 'Error: secret',
  });

  assert.equal(params.command_name, 'sync');
  assert.equal(params.status, 'success');
  assert.equal(params.site_hostname, 'customer.example');
  assert.equal(params.site_url, undefined);
  assert.equal(params.rootDomain, undefined);
  assert.equal(params.measurement_id, undefined);
  assert.equal(params.gtm_public_id, undefined);
  assert.equal(params.account_id, undefined);
  assert.equal(params.file_path, undefined);
  assert.equal(params.selector, undefined);
  assert.equal(params.error_stack, undefined);
});

test('telemetry rejects unsupported event names', () => {
  assert.throws(
    () => buildTelemetryPayload('client-123', 'raw_url_seen', {}),
    /Unsupported telemetry event/,
  );
});

test('telemetry consent message keeps friendly purpose and privacy boundaries', () => {
  const message = getTelemetryConsentMessage();

  assert.match(message, /richer anonymous diagnostics beyond the minimal startup signal sent when a command begins/i);
  assert.match(message, /only used for product optimization and reliability/i);
  assert.match(message, /do not include sensitive page content or sensitive business data/i);
  assert.match(message, /If you choose yes, we save that choice in local config and continue with diagnostics enabled for future runs unless you change it/i);
  assert.match(message, /If you choose no, we save that choice in local config and continue the workflow without these richer diagnostics/i);
  assert.match(message, /The minimal startup signal remains enabled either way/i);
  assert.match(message, /do not send full URLs, page paths, query strings, file paths, GTM\/GA IDs, selectors, OAuth data, raw errors, or page content/i);
  assert.match(message, /site hostname and high-level workflow metadata, which may reveal the domain you worked on/i);
  assert.match(message, /You can decline and continue using the tool/i);
  assert.doesNotMatch(message, /environment variable|env override|pre-create telemetry\.json/i);
});

test('telemetry consent is undecided when config file is missing', () => {
  const originalConfig = process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE;
  const missingFile = path.join(repoRoot, 'tmp', 'missing-telemetry.json');

  process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE = missingFile;

  const status = getTelemetryConsentStatus();

  assert.equal(status.status, 'undecided');
  assert.equal(status.source, 'missing_config');
  assert.equal(status.configFile, missingFile);

  if (originalConfig === undefined) delete process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE;
  else process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE = originalConfig;
});

test('telemetry consent status is decided only by telemetry config file contents', () => {
  const originalConfig = process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE;
  const configFile = path.join(repoRoot, 'tmp', 'disabled-telemetry.json');

  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({
    telemetryEnabled: false,
    clientId: 'test-client',
    decidedAt: '2026-04-08T00:00:00.000Z',
  }));
  process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE = configFile;

  const status = getTelemetryConsentStatus();

  assert.equal(status.status, 'disabled');
  assert.equal(status.source, 'config');

  fs.rmSync(configFile, { force: true });
  if (originalConfig === undefined) delete process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE;
  else process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE = originalConfig;
});

test('telemetry consent gate blocks non-interactive runs when config is missing', async () => {
  const originalConfig = process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE;
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStderrIsTTY = process.stderr.isTTY;
  const missingFile = path.join(repoRoot, 'tmp', 'missing-telemetry-gate.json');

  process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE = missingFile;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });

  await assert.rejects(
    ensureTelemetryConsentGate(),
    error => {
      assert.match(error.message, /User consent is required before starting this workflow/);
      assert.match(error.message, /Run this command in an interactive terminal and answer the diagnostics consent prompt/);
      assert.match(error.message, /only used for product optimization and reliability/);
      assert.match(error.message, /If you choose yes, we save that choice in local config and continue with diagnostics enabled for future runs unless you change it/);
      assert.match(error.message, /If you choose no, we save that choice in local config and continue the workflow without these richer diagnostics/);
      assert.match(error.message, /The minimal startup signal remains enabled either way/);
      assert.match(error.message, /site hostname and high-level workflow metadata, which may reveal the domain you worked on/);
      assert.doesNotMatch(error.message, /environment variable|env override|pre-create telemetry\.json/i);
      return true;
    },
  );

  Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinIsTTY, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: originalStderrIsTTY, configurable: true });
  if (originalConfig === undefined) delete process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE;
  else process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE = originalConfig;
});
