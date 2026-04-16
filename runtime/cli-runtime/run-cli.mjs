#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const bundleDir = path.resolve(runtimeDir, '..', '..');
const cliPackageDir = path.join(bundleDir, 'runtime', 'cli-package');
const cliEntry = path.join(cliPackageDir, 'dist', 'cli.js');
const cliPackageJson = path.join(cliPackageDir, 'package.json');
const installStateFile = path.join(cliPackageDir, '.analytics-tracking-automation-cli-install.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return readJson(filePath);
}

function quoteShellArg(value) {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }

  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function getBundledCommand() {
  return `node ${quoteShellArg(path.join(bundleDir, 'runtime', 'cli-runtime', 'run-cli.mjs'))}`;
}

function getMissingDependencies(packageJson) {
  const dependencyNames = Object.keys(packageJson.dependencies || {});
  return dependencyNames.filter(name => !fs.existsSync(path.join(cliPackageDir, 'node_modules', name)));
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: options.stdio || 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function ensureBundledCliInstalled() {
  if (!fs.existsSync(cliEntry) || !fs.existsSync(cliPackageJson)) {
    throw new Error(
      'Missing bundled event-tracking CLI files. Re-export or reinstall this skill bundle before running commands.',
    );
  }

  const packageJson = readJson(cliPackageJson);
  const installState = readJsonIfExists(installStateFile);
  const missingDependencies = getMissingDependencies(packageJson);
  const needsInstall = missingDependencies.length > 0 || installState?.version !== packageJson.version;

  if (!needsInstall) {
    return;
  }

  const reason = missingDependencies.length > 0
    ? `missing production dependencies: ${missingDependencies.join(', ')}`
    : `CLI runtime version changed from ${installState?.version || 'unknown'} to ${packageJson.version}`;

  console.error(`Preparing bundled event-tracking CLI (${reason}).`);
  console.error('Running `npm ci --omit=dev` inside the installed bundle. This may download packages and Playwright Chromium.');

  runCommand('npm', ['ci', '--omit=dev'], { cwd: cliPackageDir });

  fs.writeFileSync(
    installStateFile,
    `${JSON.stringify({
      installedAt: new Date().toISOString(),
      version: packageJson.version || '0.0.0',
    }, null, 2)}\n`,
  );
}

function main() {
  ensureBundledCliInstalled();

  const result = spawnSync(process.execPath, [cliEntry, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      EVENT_TRACKING_BUNDLE_DIR: bundleDir,
      EVENT_TRACKING_BUNDLED_CLI_DIR: cliPackageDir,
      EVENT_TRACKING_PUBLIC_CMD: getBundledCommand(),
    },
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
