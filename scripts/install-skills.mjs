#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function printHelp() {
  console.log(`Usage: node scripts/install-skills.mjs [options]

Install exported event-tracking skill bundles into a Codex skills directory.

Options:
  --target-dir <path>   Install into this directory instead of \$CODEX_HOME/skills or ~/.codex/skills
  --skill <name>        Install only the named skill bundle (repeatable)
  --mode <copy|link>    Copy bundles into the target directory or link them in place
  --skip-export         Reuse the current dist/skill-bundles output instead of regenerating it first
  --dry-run             Print the installation plan without copying files
  -h, --help            Show this help message
`);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    mode: 'copy',
    skills: [],
    skipExport: false,
    targetDir: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--target-dir') {
      index += 1;
      options.targetDir = argv[index] ?? null;
      continue;
    }

    if (arg === '--skill') {
      index += 1;
      const skillName = argv[index] ?? null;
      if (!skillName) {
        console.error('Missing value for --skill');
        process.exit(1);
      }
      options.skills.push(skillName);
      continue;
    }

    if (arg === '--mode') {
      index += 1;
      options.mode = argv[index] ?? '';
      continue;
    }

    if (arg === '--skip-export') {
      options.skipExport = true;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }

    console.error(`Unknown argument: ${arg}`);
    printHelp();
    process.exit(1);
  }

  if (options.targetDir === '') {
    console.error('Missing value for --target-dir');
    process.exit(1);
  }

  if (options.mode !== 'copy' && options.mode !== 'link') {
    console.error(`Invalid value for --mode: ${options.mode || '(missing)'}`);
    console.error('Expected one of: copy, link');
    process.exit(1);
  }

  return options;
}

function runExportIfNeeded(skipExport) {
  if (skipExport) {
    return;
  }

  const result = spawnSync('node', ['scripts/export-skills.mjs'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function resolveTargetDir(targetDir) {
  if (targetDir) {
    return path.resolve(targetDir);
  }

  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'skills');
}

function loadManifest() {
  const manifestPath = path.join(repoRoot, 'dist', 'skill-bundles', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('Missing dist/skill-bundles/manifest.json. Run npm run export:skills first.');
    process.exit(1);
  }

  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function selectBundles(manifest, requestedSkills) {
  if (requestedSkills.length === 0) {
    return manifest.bundles;
  }

  const bundleMap = new Map(manifest.bundles.map(bundle => [bundle.name, bundle]));
  const selected = [];

  for (const skillName of requestedSkills) {
    const bundle = bundleMap.get(skillName);
    if (!bundle) {
      console.error(`Unknown skill bundle: ${skillName}`);
      console.error(`Available bundles: ${manifest.bundles.map(item => item.name).join(', ')}`);
      process.exit(1);
    }
    selected.push(bundle);
  }

  return selected;
}

function createDirectoryLink(sourcePath, targetPath) {
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(sourcePath, targetPath, linkType);
}

function installBundle(targetRoot, bundle, mode, dryRun) {
  const sourcePath = path.join(repoRoot, bundle.outputPath);
  const targetPath = path.join(targetRoot, bundle.name);

  if (!fs.existsSync(sourcePath)) {
    console.error(`Missing exported bundle directory: ${bundle.outputPath}`);
    process.exit(1);
  }

  const actionLabel = mode === 'link' ? 'link' : 'install';
  console.log(`${dryRun ? '[dry-run]' : `[${actionLabel}]`} ${bundle.name} -> ${targetPath}`);

  if (dryRun) {
    return;
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  fs.rmSync(targetPath, { recursive: true, force: true });

  if (mode === 'link') {
    createDirectoryLink(sourcePath, targetPath);
    return;
  }

  fs.cpSync(sourcePath, targetPath, { recursive: true });
}

const options = parseArgs(process.argv.slice(2));
runExportIfNeeded(options.skipExport);

const manifest = loadManifest();
const bundles = selectBundles(manifest, options.skills);
const targetDir = resolveTargetDir(options.targetDir);

console.log(`Target skills directory: ${targetDir}`);
console.log(`Install mode: ${options.mode}`);

bundles.forEach(bundle => installBundle(targetDir, bundle, options.mode, options.dryRun));

if (options.dryRun) {
  console.log(`Planned ${bundles.length} skill installation(s).`);
} else {
  console.log(`${options.mode === 'link' ? 'Linked' : 'Installed'} ${bundles.length} skill bundle(s) into ${targetDir}`);
}
