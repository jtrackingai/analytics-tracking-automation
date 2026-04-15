#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_UPDATE_SOURCE = {
  provider: 'github-tarball',
  versionUrl: process.env.EVENT_TRACKING_UPDATE_VERSION_URL || 'https://raw.githubusercontent.com/jtrackingai/analytics-tracking-automation/main/VERSION',
  tarballUrl: process.env.EVENT_TRACKING_UPDATE_TARBALL_URL || 'https://codeload.github.com/jtrackingai/analytics-tracking-automation/tar.gz/refs/heads/main',
};

function printHelp() {
  console.log(`Usage: node scripts/install-skills.mjs [options]

Install exported analytics-tracking-automation skill bundles into an agent skills directory.

This installer requires a local checkout of this repository.
If you do not want a local checkout, use:
  npx skills add jtrackingai/analytics-tracking-automation

Fast paths:
  npm run install:skills
      Install only the umbrella skill into the default target.
  npm run install:skills -- --with-phases
      Install the full skill family (umbrella + phase skills).
  ./setup
      Prepare the repo-local CLI and development environment.
  ./setup --install-skills --with-phases
      Run the full repo setup and install the full skill family.

Options:
  --target-dir <path>   Install into this directory instead of the default agent skills directory
  --skill <name>        Install only the named skill bundle (repeatable)
  --with-phases         Install the full skill family when --skill is not provided
  --mode <copy|link>    Copy bundles into the target directory or link them in place
                        copy installs get installed auto-update metadata; link installs are local-development-only and disable auto-update
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
    withPhases: false,
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

    if (arg === '--with-phases') {
      options.withPhases = true;
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

function getDefaultBundle(manifest) {
  return manifest.bundles.find(bundle => bundle.kind === 'umbrella') ?? manifest.bundles[0];
}

function selectBundles(manifest, requestedSkills, withPhases) {
  if (requestedSkills.length === 0) {
    return withPhases ? manifest.bundles : [getDefaultBundle(manifest)];
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

function quoteMarkdownPath(targetPath) {
  return targetPath.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function injectAfterFrontmatter(content, insertedContent) {
  if (!content.startsWith('---\n')) {
    return `${insertedContent}${content}`;
  }

  const closingIndex = content.indexOf('\n---\n', 4);
  if (closingIndex === -1) {
    return `${insertedContent}${content}`;
  }

  const insertAt = closingIndex + '\n---\n'.length;
  return `${content.slice(0, insertAt)}\n${insertedContent}${content.slice(insertAt)}`;
}

function writeAutoUpdateBootstrap(skillFile, bootstrap) {
  const originalContent = fs.readFileSync(skillFile, 'utf8');
  const markerStart = '<!-- analytics-tracking-automation auto-update bootstrap:start -->';
  const markerEnd = '<!-- analytics-tracking-automation auto-update bootstrap:end -->';
  const markerPattern = new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}\\n?`);
  const nextContent = markerPattern.test(originalContent)
    ? originalContent.replace(markerPattern, `${bootstrap}\n`)
    : injectAfterFrontmatter(originalContent, bootstrap);

  fs.writeFileSync(skillFile, nextContent);
}

function buildInstalledAutoUpdateBootstrap(skillFile, scriptDir, selectedBundles) {
  const checkScript = path.join(scriptDir, 'update-check.mjs');
  const updateScript = path.join(scriptDir, 'self-update.mjs');
  const refreshedSkill = skillFile;
  const selectedLabel = selectedBundles.join(', ');
  return [
    '<!-- analytics-tracking-automation auto-update bootstrap:start -->',
    '## Installed Auto-Update',
    '',
    'This installed skill copy can update itself from GitHub before you continue with the workflow.',
    '',
    'Before doing any task in this installed bundle:',
    '',
    `1. Run \`node "${quoteMarkdownPath(checkScript)}" --json\`.`,
    '2. If the result status is `update_available`, immediately run the update command returned by that check or:',
    `   \`node "${quoteMarkdownPath(updateScript)}" --apply\``,
    `3. If the update succeeds, read [SKILL.md](${refreshedSkill}) again before continuing so you are following the refreshed instructions.`,
    `4. This installed copy updates the same bundle set that was installed together: \`${selectedLabel}\`.`,
    '',
    'If the status is `up_to_date` or `disabled`, continue with the current installed version.',
    '<!-- analytics-tracking-automation auto-update bootstrap:end -->',
  ].join('\n');
}

function writeInstallMetadata(targetRoot, bundle, selectedBundles, autoUpdateEnabled) {
  const targetPath = path.join(targetRoot, bundle.name);
  const bundleMetadataPath = path.join(targetPath, 'bundle.json');
  const bundleMetadata = JSON.parse(fs.readFileSync(bundleMetadataPath, 'utf8'));
  const installMetadata = {
    schemaVersion: 1,
    bundleName: bundle.name,
    installedAt: new Date().toISOString(),
    installedVersion: bundleMetadata.familyVersion,
    installMode: autoUpdateEnabled ? 'copy' : 'link',
    autoUpdateEnabled,
    targetDir: targetRoot,
    bundleDir: targetPath,
    selectedBundles,
    updateSource: {
      ...DEFAULT_UPDATE_SOURCE,
      ...(bundleMetadata.updateSource || {}),
    },
  };

  fs.writeFileSync(
    path.join(targetPath, '.analytics-tracking-automation-install.json'),
    `${JSON.stringify(installMetadata, null, 2)}\n`,
  );

  if (!autoUpdateEnabled) {
    return;
  }

  writeAutoUpdateBootstrap(
    path.join(targetPath, 'SKILL.md'),
    buildInstalledAutoUpdateBootstrap(
      path.join(targetPath, 'SKILL.md'),
      path.join(targetPath, 'runtime', 'skill-runtime'),
      selectedBundles,
    ),
  );
}

function installBundle(targetRoot, bundle, mode, dryRun, selectedBundles) {
  const sourcePath = path.join(repoRoot, 'dist', 'skill-bundles', bundle.name);
  const targetPath = path.join(targetRoot, bundle.name);

  if (!fs.existsSync(sourcePath)) {
    console.error(`Missing exported bundle directory: dist/skill-bundles/${bundle.name}`);
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
  writeInstallMetadata(targetRoot, bundle, selectedBundles, true);
}

function describeBundleSelection(bundles, options) {
  const selectedNames = bundles.map(bundle => bundle.name);
  console.log(`Selected bundles: ${selectedNames.join(', ')}`);

  if (options.skills.length > 0) {
    console.log('Bundle selection mode: explicit --skill filter');
    return;
  }

  if (options.withPhases) {
    console.log('Bundle selection mode: full skill family');
    return;
  }

  console.log('Bundle selection mode: minimal default (umbrella skill only)');
  console.log('Use --with-phases if you want the full phase-oriented skill family installed together.');
}

function printCompletionNotes(options) {
  if (options.dryRun) {
    return;
  }

  if (options.mode === 'link') {
    console.log('Next step: rerun `npm run export:skills` after editing skill text or metadata.');
    return;
  }

  console.log('Next step: restart the agent session if newly installed skills do not appear immediately.');
}

const options = parseArgs(process.argv.slice(2));
runExportIfNeeded(options.skipExport);

const manifest = loadManifest();
const bundles = selectBundles(manifest, options.skills, options.withPhases);
const targetDir = resolveTargetDir(options.targetDir);

console.log(`Target skills directory: ${targetDir}`);
console.log(`Install mode: ${options.mode}`);
describeBundleSelection(bundles, options);

bundles.forEach(bundle => installBundle(
  targetDir,
  bundle,
  options.mode,
  options.dryRun,
  bundles.map(item => item.name),
));

if (options.dryRun) {
  console.log(`Planned ${bundles.length} skill installation(s).`);
} else {
  console.log(`${options.mode === 'link' ? 'Linked' : 'Installed'} ${bundles.length} skill bundle(s) into ${targetDir}`);
}

printCompletionNotes(options);
