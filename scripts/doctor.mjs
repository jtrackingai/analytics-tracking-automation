#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const requiredNodeMajor = 18;
const checks = [];

function addCheck(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] || '0', 10);
addCheck(
  'Node.js',
  nodeMajor >= requiredNodeMajor,
  `found ${process.version}; require >= v${requiredNodeMajor}`,
);

addCheck(
  'Built CLI',
  fileExists('dist/cli.js'),
  fileExists('dist/cli.js') ? 'dist/cli.js present' : 'run `npm run build`',
);

addCheck(
  'Repo-local wrapper',
  fileExists('event-tracking'),
  fileExists('event-tracking') ? './event-tracking present' : 'missing ./event-tracking wrapper',
);

let playwrightOk = false;
let playwrightDetail = 'playwright package is unavailable';
try {
  const { chromium } = await import('playwright');
  const executablePath = chromium.executablePath();
  playwrightOk = !!executablePath && fs.existsSync(executablePath);
  playwrightDetail = playwrightOk
    ? `Chromium installed at ${executablePath}`
    : 'run `npx playwright install chromium` or reinstall dependencies';
} catch (error) {
  playwrightDetail = `playwright import failed: ${error.message}`;
}
addCheck('Playwright Chromium', playwrightOk, playwrightDetail);

const failed = checks.filter(check => !check.ok);

console.log('Event Tracking Skill Doctor');
console.log('');
for (const check of checks) {
  const status = check.ok ? 'OK ' : 'FAIL';
  console.log(`[${status}] ${check.name}: ${check.detail}`);
}

if (failed.length > 0) {
  console.log('');
  console.log('Doctor found issues.');
  process.exit(1);
}

console.log('');
console.log('Doctor checks passed.');
