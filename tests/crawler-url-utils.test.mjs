import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  isBusinessCriticalUrl,
  isSameDomain,
  prioritizeBusinessCriticalUrls,
} = require(path.join(repoRoot, 'dist', 'crawler', 'url-utils.js'));

test('crawler treats same registered-domain app subdomains as in scope', () => {
  assert.equal(isSameDomain('https://app.notta.ai/login', 'notta.ai'), true);
  assert.equal(isSameDomain('https://support.notta.ai/hc/en-us', 'notta.ai'), true);
  assert.equal(isSameDomain('https://example.net/login', 'notta.ai'), false);
});

test('crawler prioritizes business-critical subdomain and auth URLs before broad marketing pages', () => {
  const urls = [
    'https://www.notta.ai/en/blog/ai-sales-playbook',
    'https://www.notta.ai/en/features/ai-transcription',
    'https://app.notta.ai/login?language=en&from=official',
    'https://www.notta.ai/en/customers/acme-success-story',
    'https://www.notta.ai/en/pricing',
    'https://support.notta.ai/hc/en-us',
  ];

  assert.equal(isBusinessCriticalUrl('https://app.notta.ai/login?language=en&from=official', 'notta.ai'), true);
  assert.equal(isBusinessCriticalUrl('https://www.notta.ai/en/pricing', 'notta.ai'), true);
  assert.equal(isBusinessCriticalUrl('https://support.notta.ai/hc/en-us', 'notta.ai'), false);

  assert.deepEqual(
    prioritizeBusinessCriticalUrls(urls, 'notta.ai').slice(0, 2),
    [
      'https://app.notta.ai/login?language=en&from=official',
      'https://www.notta.ai/en/pricing',
    ],
  );
});
