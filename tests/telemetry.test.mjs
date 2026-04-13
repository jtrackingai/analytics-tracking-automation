import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  buildTelemetryPayload,
  sanitizeTelemetryParams,
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
