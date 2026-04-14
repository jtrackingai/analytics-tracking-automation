#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkForUpdates,
  downloadFile,
  ensureDir,
  loadInstallContext,
  resolveInstallState,
  runCommand,
  verifyFileSha256,
} from './common.mjs';

function printHelp() {
  console.log(`Usage: node self-update.mjs --apply [options]

Download the latest event-tracking skill family source, export skill bundles,
and reinstall the selected event-tracking bundles into the original skills directory.

Options:
  --apply       Perform the update
  --force       Run even if the last update check is cached
  -h, --help    Show this help message
`);
}

function extractTarball(archiveFile, targetDir) {
  ensureDir(targetDir);
  runCommand('tar', ['-xzf', archiveFile, '-C', targetDir], { stdio: 'pipe' });

  const entries = fs.readdirSync(targetDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
  if (entries.length !== 1) {
    throw new Error(`Expected one extracted top-level directory, found ${entries.length}.`);
  }

  return path.join(targetDir, entries[0].name);
}

async function main() {
  const args = process.argv.slice(2);
  let apply = false;
  let force = false;

  for (const arg of args) {
    if (arg === '--apply') {
      apply = true;
      continue;
    }

    if (arg === '--force') {
      force = true;
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      printHelp();
      return;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!apply) {
    throw new Error('Refusing to update without --apply.');
  }

  const updateState = await checkForUpdates(import.meta.url, { force });
  if (updateState.status === 'disabled') {
    console.log(updateState.reason);
    return;
  }

  if (updateState.status === 'error') {
    throw new Error(`Cannot update because the version check failed: ${updateState.reason}`);
  }

  if (updateState.status !== 'update_available') {
    console.log(`Already up to date at ${updateState.installedVersion}.`);
    return;
  }

  const context = loadInstallContext(import.meta.url);
  const installState = resolveInstallState(context);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'event-tracking-skill-update-'));
  const archiveFile = path.join(tempRoot, 'source.tar.gz');

  try {
    await downloadFile(updateState.updateSource.tarballUrl, archiveFile, 30 * 1000);
    verifyFileSha256(archiveFile, updateState.updateSource.tarballSha256, 'update tarball');
    const extractedRepo = extractTarball(archiveFile, path.join(tempRoot, 'repo'));

    runCommand('node', ['scripts/export-skills.mjs'], {
      cwd: extractedRepo,
      stdio: 'inherit',
      env: process.env,
    });

    const installArgs = [
      'scripts/install-skills.mjs',
      '--skip-export',
      '--target-dir',
      installState.targetDir,
      '--mode',
      'copy',
    ];

    for (const skillName of installState.selectedBundles || [context.bundleMetadata.name]) {
      installArgs.push('--skill', skillName);
    }

    runCommand('node', installArgs, {
      cwd: extractedRepo,
      stdio: 'inherit',
      env: process.env,
    });

    console.log(`Updated event-tracking skill family to ${updateState.latestVersion}.`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
