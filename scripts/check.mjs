#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  SOURCE_SKILL_MANIFEST,
  getPhaseSkillBundles,
  getSkillBundles,
  listExpectedExportedFiles,
  loadSourceSkillManifest,
} from './skill-bundles.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function runStep(label, command, args, options = {}) {
  console.log(`==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function assertFileDoesNotContain(relativePath, pattern, message) {
  const fullPath = path.join(repoRoot, relativePath);
  const content = fs.readFileSync(fullPath, 'utf8');
  if (content.includes(pattern)) {
    console.error(`Check failed: ${relativePath} still contains ${JSON.stringify(pattern)}. ${message}`);
    process.exit(1);
  }
}

function assertFileExists(relativePath, message) {
  const fullPath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    console.error(`Check failed: missing ${relativePath}. ${message}`);
    process.exit(1);
  }
}

function assertMaxLineCount(relativePath, maxLines, message) {
  const fullPath = path.join(repoRoot, relativePath);
  const lineCount = fs.readFileSync(fullPath, 'utf8').split('\n').length;
  if (lineCount > maxLines) {
    console.error(`Check failed: ${relativePath} has ${lineCount} lines (max ${maxLines}). ${message}`);
    process.exit(1);
  }
}

function assertResolvesTo(relativePath, expectedTargetPath, message) {
  const fullPath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    console.error(`Check failed: missing ${relativePath}. ${message}`);
    process.exit(1);
  }

  const actualResolved = fs.realpathSync(fullPath);
  const expectedResolved = fs.realpathSync(expectedTargetPath);
  if (actualResolved !== expectedResolved) {
    console.error(`Check failed: ${relativePath} resolves to ${actualResolved}, expected ${expectedResolved}. ${message}`);
    process.exit(1);
  }
}

const sourceManifest = loadSourceSkillManifest(repoRoot);
const allBundles = getSkillBundles(sourceManifest);
const phaseSkillFiles = getPhaseSkillBundles(sourceManifest).map(bundle => bundle.skillFile);
const agentMetadataFiles = allBundles.map(bundle => bundle.metadataFile);
const exportedBundleFiles = listExpectedExportedFiles(repoRoot, sourceManifest);

const tempInstallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-tracking-skill-install-'));
const tempLinkInstallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-tracking-skill-link-install-'));

runStep('Build CLI', 'npm', ['run', 'build']);
runStep('Run automated tests', 'npm', ['run', 'test:built']);
runStep('Run doctor', 'node', ['scripts/doctor.mjs']);
runStep('Smoke-test repo-local CLI', './event-tracking', ['--help'], {
  env: { ...process.env, EVENT_TRACKING_PUBLIC_CMD: './event-tracking' },
});
runStep('Export self-contained skill bundles', 'node', ['scripts/export-skills.mjs']);
runStep('Install exported skill bundles into a temp skills directory', 'node', ['scripts/install-skills.mjs', '--skip-export', '--target-dir', tempInstallDir]);
runStep('Link exported skill bundles into a temp skills directory', 'node', ['scripts/install-skills.mjs', '--skip-export', '--target-dir', tempLinkInstallDir, '--mode', 'link']);

assertFileExists(SOURCE_SKILL_MANIFEST, 'Keep a canonical source manifest for the shipped skill family.');
assertFileExists('ARCHITECTURE.md', 'Keep a dedicated system-design document in the repo root.');
assertFileExists('DEVELOPING.md', 'Keep a dedicated maintainer guide in the repo root.');
assertFileExists('docs/README.codex.md', 'Keep a Codex-specific install and update guide for the exported skill family.');
assertFileExists('.codex/INSTALL.md', 'Keep a bootstrap install note for Codex users who fetch this repository into a skill environment.');
assertFileExists('docs/skills.md', 'Keep a dedicated skill map when the repo exposes a skill family.');
assertFileExists('references/architecture.md', 'Keep an install-facing architecture reference in source so exported bundles can ship it unchanged.');
assertFileExists('references/skill-map.md', 'Keep an install-facing skill-map reference in source so exported bundles can ship it unchanged.');
assertFileExists('tests/workflow-state.test.mjs', 'Keep a standalone automated test suite for workflow-state and gate behavior.');
assertFileExists('tests/skill-family.test.mjs', 'Keep automated coverage for the skill-family routing and packaging contract.');
phaseSkillFiles.forEach(relativePath => {
  assertFileExists(relativePath, 'Phase skills should exist and remain explicitly tracked.');
});
agentMetadataFiles.forEach(relativePath => {
  assertFileExists(relativePath, 'Skill UI metadata should exist for each shipped skill.');
});
exportedBundleFiles.forEach(relativePath => {
  assertFileExists(relativePath, 'Self-contained skill bundles should export the installable skill surface.');
});
assertFileDoesNotContain('README.md', 'node dist/cli.js', 'Use the public wrapper or installed command name instead.');
assertFileDoesNotContain('SKILL.md', 'node dist/cli.js', 'Use the public wrapper or installed command name instead.');
assertFileDoesNotContain('references/output-contract.md', 'node dist/cli.js', 'Use the public wrapper or installed command name instead.');
assertFileDoesNotContain('references/event-schema-guide.md', 'node dist/cli.js', 'Reference guides should use the public wrapper.');
assertFileDoesNotContain('references/page-grouping-guide.md', 'node dist/cli.js', 'Reference guides should use the public wrapper.');
assertFileDoesNotContain('references/gtm-troubleshooting.md', 'node dist/cli.js', 'Reference guides should use the public wrapper.');
assertFileDoesNotContain('SKILL.md', 'https://www.jtracking.ai', 'Keep product marketing out of the core workflow contract.');
assertFileDoesNotContain('SKILL.md', 'JTracking', 'Keep product marketing out of the core workflow contract.');
assertFileDoesNotContain('SKILL.md', '## Phase Contracts', 'Keep the root skill at router scope; phase detail belongs in phase skills.');
phaseSkillFiles.forEach(relativePath => {
  assertFileDoesNotContain(relativePath, 'node dist/cli.js', 'Phase skills should use the public wrapper.');
  assertFileDoesNotContain(relativePath, 'https://www.jtracking.ai', 'Keep product marketing out of phase skills.');
  assertFileDoesNotContain(relativePath, 'JTracking', 'Keep product marketing out of phase skills.');
});
assertMaxLineCount('SKILL.md', 220, 'Keep the root skill focused on routing and shared workflow contract; move detailed runbook content into phase skills or references.');
phaseSkillFiles.forEach(relativePath => {
  assertMaxLineCount(relativePath, 120, 'Phase skills should stay thin and phase-scoped.');
});
agentMetadataFiles.forEach(relativePath => {
  const content = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  if (!content.includes('display_name:') || !content.includes('short_description:') || !content.includes('default_prompt:')) {
    console.error(`Check failed: ${relativePath} is missing one of display_name, short_description, or default_prompt.`);
    process.exit(1);
  }
});
exportedBundleFiles.forEach(relativePath => {
  if (!relativePath.endsWith('SKILL.md')) {
    return;
  }
  assertFileDoesNotContain(relativePath, './event-tracking', 'Exported bundles should use the public command name.');
});
allBundles.forEach(bundle => {
  const relativePath = path.join(bundle.name, 'SKILL.md');
  assertFileExists(path.join(path.relative(repoRoot, tempInstallDir), relativePath), 'Installed skills should land in the requested target directory.');
});
assertResolvesTo(
  path.join(path.relative(repoRoot, tempLinkInstallDir), 'event-tracking-skill'),
  path.join(repoRoot, 'dist', 'skill-bundles', 'event-tracking-skill'),
  'Link-mode installs should resolve back to the exported bundle path.',
);
[
  'event-tracking-skill/references/architecture.md',
  'event-tracking-skill/references/skill-map.md',
  'tracking-schema/references/architecture.md',
  'tracking-shopify/references/architecture.md',
].forEach(relativePath => {
  assertFileExists(path.join(path.relative(repoRoot, tempInstallDir), relativePath), 'Installed bundles should keep their reference files.');
});

fs.rmSync(tempInstallDir, { recursive: true, force: true });
fs.rmSync(tempLinkInstallDir, { recursive: true, force: true });

console.log('==> Check completed successfully');
