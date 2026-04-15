import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadPreviewModule() {
  execFileSync('npm', ['run', 'build'], {
    cwd: repoRoot,
    stdio: 'pipe',
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
  });

  return require(path.join(repoRoot, 'dist', 'gtm', 'preview.js'));
}

test('preview preflight falls back to commit navigation after a timeout', async () => {
  const preview = loadPreviewModule();
  const previewSource = fs.readFileSync(path.join(repoRoot, 'src', 'gtm', 'preview.ts'), 'utf8');

  assert.match(
    previewSource,
    /Preview preflight timeout on \$\{url\}; retrying with commit fallback\./,
    'Preview preflight should log when it falls back after a timeout.',
  );
  assert.match(
    previewSource,
    /await page\.goto\(url, \{ waitUntil: 'commit', timeout: PREVIEW_PREFLIGHT_FALLBACK_TIMEOUT_MS \}\);/,
    'Preview preflight should retry timed-out pages with commit fallback.',
  );

  const calls = [];
  const fakePage = {
    async goto(url, options) {
      calls.push({ type: 'goto', url, options });
      if (options.waitUntil === 'domcontentloaded') {
        throw new Error('page.goto: Timeout 20000ms exceeded.');
      }
    },
    async waitForTimeout(ms) {
      calls.push({ type: 'waitForTimeout', ms });
    },
    async waitForLoadState(state, options) {
      calls.push({ type: 'waitForLoadState', state, options });
    },
  };

  await preview.__testOnly.navigateForPreviewPreflight(fakePage, 'https://example.com/slow');

  assert.deepEqual(
    calls.map(call => call.type === 'goto' ? [call.type, call.options.waitUntil] : [call.type]),
    [
      ['goto', 'domcontentloaded'],
      ['goto', 'commit'],
      ['waitForLoadState'],
      ['waitForTimeout'],
    ],
    'Preview preflight should retry timed-out navigation with commit fallback and settle waits.',
  );
});

test('preview verification navigation falls back to commit navigation after a timeout', async () => {
  const preview = loadPreviewModule();
  const previewSource = fs.readFileSync(path.join(repoRoot, 'src', 'gtm', 'preview.ts'), 'utf8');

  assert.match(
    previewSource,
    /\$\{args\.phaseLabel\} timeout on \$\{url\}; retrying with commit fallback\./,
    'Preview verification should log when it falls back after a timeout.',
  );

  const calls = [];
  const fakePage = {
    async goto(url, options) {
      calls.push({ type: 'goto', url, options });
      if (options.waitUntil === 'domcontentloaded') {
        throw new Error('page.goto: Timeout 30000ms exceeded.');
      }
    },
    async waitForTimeout(ms) {
      calls.push({ type: 'waitForTimeout', ms });
    },
    async waitForLoadState(state, options) {
      calls.push({ type: 'waitForLoadState', state, options });
    },
  };

  await preview.__testOnly.navigateForPreviewPage(fakePage, 'https://example.com/verify', {
    phaseLabel: 'Preview verification',
    primaryTimeoutMs: 30000,
    fallbackTimeoutMs: 20000,
    settleMs: 4000,
  });

  assert.deepEqual(
    calls.map(call => call.type === 'goto' ? [call.type, call.options.waitUntil] : [call.type]),
    [
      ['goto', 'domcontentloaded'],
      ['goto', 'commit'],
      ['waitForLoadState'],
      ['waitForTimeout'],
    ],
    'Preview verification should retry timed-out navigation with commit fallback and settle waits.',
  );
});

test('inject preview keeps page URL clean and carries preview auth on the script request only', async () => {
  const preview = loadPreviewModule();
  const previewSource = fs.readFileSync(path.join(repoRoot, 'src', 'gtm', 'preview.ts'), 'utf8');

  assert.match(
    previewSource,
    /Inject mode carries preview auth on the GTM script request\./,
    'Inject preview should document why page URLs stay unchanged.',
  );

  const originalUrl = 'https://www.jtracking.ai/pricing?plan=pro';
  const previewParams = 'gtm_preview=env-1126&gtm_auth=test-auth';

  assert.equal(
    preview.__testOnly.mapPreviewPageUrl(originalUrl, true, previewParams),
    originalUrl,
    'Inject preview should not append GTM preview params to the site URL.',
  );

  assert.equal(
    preview.__testOnly.mapPreviewPageUrl(originalUrl, false, previewParams),
    originalUrl,
    'Live preview should keep the original URL untouched.',
  );
});

test('preview click helper can target later visible candidates when the first match is not enough', async () => {
  const preview = loadPreviewModule();

  const clicked = [];
  const fakeCandidates = [
    {
      async isVisible() { return true; },
      async scrollIntoViewIfNeeded() {},
      async click() { clicked.push(0); },
    },
    {
      async isVisible() { return true; },
      async scrollIntoViewIfNeeded() {},
      async click() { clicked.push(1); },
    },
  ];

  const fakePage = {
    locator() {
      return {
        async count() { return fakeCandidates.length; },
        nth(index) { return fakeCandidates[index]; },
      };
    },
  };

  assert.equal(
    await preview.__testOnly.clickVisibleMatchAt(fakePage, 'button.copy', 1),
    true,
    'Preview click helper should be able to click a later visible candidate.',
  );
  assert.deepEqual(clicked, [1], 'Preview click helper should target the requested candidate index.');
});
