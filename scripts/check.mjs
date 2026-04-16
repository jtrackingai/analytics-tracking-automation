#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  EXPORT_PROFILE_CLAWHUB,
  EXPORT_PROFILE_PORTABLE,
  SOURCE_SKILL_MANIFEST,
  getPhaseSkillBundles,
  getSkillBundles,
  getExportBundleRoot,
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

function captureStep(label, command, args, options = {}) {
  console.log(`==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf8',
    ...options,
  });

  if (result.status !== 0) {
    const stdout = result.stdout?.trim();
    const stderr = result.stderr?.trim();
    console.error(`Check failed: ${label}`);
    if (stdout) console.error(stdout);
    if (stderr) console.error(stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout || '';
}

function assertFileDoesNotContain(relativePath, pattern, message) {
  const fullPath = path.join(repoRoot, relativePath);
  const content = fs.readFileSync(fullPath, 'utf8');
  if (content.includes(pattern)) {
    console.error(`Check failed: ${relativePath} still contains ${JSON.stringify(pattern)}. ${message}`);
    process.exit(1);
  }
}

function assertFileContains(relativePath, pattern, message) {
  const fullPath = path.join(repoRoot, relativePath);
  const content = fs.readFileSync(fullPath, 'utf8');
  if (!content.includes(pattern)) {
    console.error(`Check failed: ${relativePath} is missing ${JSON.stringify(pattern)}. ${message}`);
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

function assertFileMissing(relativePath, message) {
  const fullPath = path.join(repoRoot, relativePath);
  if (fs.existsSync(fullPath)) {
    console.error(`Check failed: unexpected ${relativePath}. ${message}`);
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

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function listMarkdownFiles(relativeDir) {
  return fs.readdirSync(path.join(repoRoot, relativeDir), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => path.join(relativeDir, entry.name));
}

function parseCliCommandNames(helpOutput) {
  const commandNames = new Set();

  for (const line of helpOutput.split('\n')) {
    const match = /^\s{2}([a-z][a-z0-9-]*)\b/.exec(line);
    if (!match) {
      continue;
    }

    commandNames.add(match[1]);
  }

  return commandNames;
}

function assertDocumentedCommandsExist(relativePaths, commandNames) {
  const commandPattern = /(?:\.\/)?event-tracking\s+([a-z][a-z0-9-]*)\b/g;

  for (const relativePath of relativePaths) {
    const content = readText(relativePath).replace(/<!--[\s\S]*?-->/g, '');
    const commandSnippets = [
      ...[...content.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(match => match[1]),
      ...[...content.matchAll(/`([^`\n]+)`/g)].map(match => match[1]).filter(snippet => snippet.includes('event-tracking')),
    ];

    for (const snippet of commandSnippets) {
      for (const match of snippet.matchAll(commandPattern)) {
        const commandName = match[1];
        if (commandNames.has(commandName)) {
          continue;
        }

        console.error(`Check failed: ${relativePath} references unknown event-tracking command "${commandName}". Keep skill/docs command examples aligned with the CLI.`);
        process.exit(1);
      }
    }
  }
}

function parseOutputContractArtifacts() {
  const artifacts = new Set();
  const content = readText('references/output-contract.md');
  const tableCellPattern = /\|\s*`([^`]+)`\s*\|/g;

  for (const match of content.matchAll(tableCellPattern)) {
    artifacts.add(match[1]);
  }

  return artifacts;
}

function extractRequiredArtifacts(relativePath) {
  const content = readText(relativePath);
  const artifacts = new Set();
  const artifactPattern = /`<artifact-dir>\/([^`]+)`/g;

  for (const match of content.matchAll(artifactPattern)) {
    const artifactPath = match[1].trim();
    const topLevelName = artifactPath.split('/')[0] + (artifactPath.endsWith('/') ? '/' : '');
    artifacts.add(topLevelName);
  }

  return artifacts;
}

function assertPhaseArtifactsAreDocumented(relativePaths) {
  const documentedArtifacts = parseOutputContractArtifacts();

  for (const relativePath of relativePaths) {
    for (const artifactName of extractRequiredArtifacts(relativePath)) {
      if (documentedArtifacts.has(artifactName)) {
        continue;
      }

      console.error(`Check failed: ${relativePath} references artifact "${artifactName}" that is missing from references/output-contract.md.`);
      process.exit(1);
    }
  }
}

function assertMarkdownLinksResolve(relativePaths) {
  const markdownLinkPattern = /(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

  for (const relativePath of relativePaths) {
    const content = readText(relativePath);
    for (const match of content.matchAll(markdownLinkPattern)) {
      const rawTarget = match[1];
      if (
        rawTarget.startsWith('http://')
        || rawTarget.startsWith('https://')
        || rawTarget.startsWith('mailto:')
        || rawTarget.startsWith('#')
      ) {
        continue;
      }

      const targetPath = rawTarget.split('#')[0];
      if (!targetPath) {
        continue;
      }

      const resolvedPath = path.resolve(repoRoot, path.dirname(relativePath), decodeURIComponent(targetPath));
      if (fs.existsSync(resolvedPath)) {
        continue;
      }

      console.error(`Check failed: ${relativePath} has a broken Markdown link to ${rawTarget}.`);
      process.exit(1);
    }
  }
}

function assertJsonField(relativePath, key, predicate, message) {
  const value = readJson(relativePath);
  if (!predicate(value[key], value)) {
    console.error(`Check failed: ${relativePath} has unexpected ${key}. ${message}`);
    process.exit(1);
  }
}

const sourceManifest = loadSourceSkillManifest(repoRoot);
const allBundles = getSkillBundles(sourceManifest);
const phaseSkillFiles = getPhaseSkillBundles(sourceManifest).map(bundle => bundle.skillFile);
const agentMetadataFiles = allBundles.map(bundle => bundle.metadataFile);
const exportedBundleFiles = listExpectedExportedFiles(repoRoot, sourceManifest, { profile: EXPORT_PROFILE_PORTABLE });
const clawhubExportedBundleFiles = listExpectedExportedFiles(repoRoot, sourceManifest, { profile: EXPORT_PROFILE_CLAWHUB });
const contractMarkdownFiles = [
  'SKILL.md',
  'README.md',
  'ARCHITECTURE.md',
  'DEVELOPING.md',
  'CONTRIBUTING.md',
  ...listMarkdownFiles('docs'),
  ...listMarkdownFiles('references'),
  ...phaseSkillFiles,
];

const tempInstallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-tracking-automation-install-'));
const tempSingleSkillInstallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-tracking-automation-single-install-'));
const tempFullInstallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-tracking-automation-full-install-'));
const tempLinkInstallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-tracking-automation-link-install-'));

runStep('Build CLI', 'npm', ['run', 'build']);
runStep('Run automated tests', 'npm', ['run', 'test:built']);
runStep('Run doctor', 'node', ['scripts/doctor.mjs']);
runStep('Verify contract-generated skill docs are in sync', 'node', ['scripts/sync-skill-docs.mjs', '--check']);
runStep('Smoke-test repo-local CLI', './event-tracking', ['--help'], {
  env: { ...process.env, EVENT_TRACKING_PUBLIC_CMD: './event-tracking' },
});
const cliCommandNames = parseCliCommandNames(captureStep('Capture CLI command surface', './event-tracking', ['--help'], {
  env: { ...process.env, EVENT_TRACKING_PUBLIC_CMD: './event-tracking' },
}));
runStep('Export self-contained skill bundles', 'node', ['scripts/export-skills.mjs']);
runStep('Export ClawHub publish bundles', 'node', ['scripts/export-skills.mjs', '--profile', EXPORT_PROFILE_CLAWHUB]);
runStep('Install the default umbrella skill bundle into a temp skills directory', 'node', ['scripts/install-skills.mjs', '--skip-export', '--target-dir', tempInstallDir]);
runStep('Install an explicit phase skill bundle into a temp skills directory', 'node', ['scripts/install-skills.mjs', '--skip-export', '--target-dir', tempSingleSkillInstallDir, '--skill', 'tracking-schema']);
runStep('Install the full skill family into a temp skills directory', 'node', ['scripts/install-skills.mjs', '--skip-export', '--target-dir', tempFullInstallDir, '--with-phases']);
runStep('Link the default umbrella skill bundle into a temp skills directory', 'node', ['scripts/install-skills.mjs', '--skip-export', '--target-dir', tempLinkInstallDir, '--mode', 'link']);

assertFileExists(SOURCE_SKILL_MANIFEST, 'Keep a canonical source manifest for the shipped skill family.');
assertFileExists('VERSION', 'Keep a canonical skill-family version file for installed bundle update checks.');
assertFileExists('ARCHITECTURE.md', 'Keep a dedicated system-design document in the repo root.');
assertFileExists('DEVELOPING.md', 'Keep a dedicated maintainer guide in the repo root.');
assertFileExists('docs/README.install.md', 'Keep a shared agent-install guide for portable skill installation.');
assertFileExists('docs/skills.md', 'Keep a dedicated skill map when the repo exposes a skill family.');
assertFileExists('skills/contract.json', 'Keep a structured skill-family contract so routing and phase boundaries have a machine-checkable source of truth.');
assertFileExists('references/architecture.md', 'Keep an install-facing architecture reference in source so exported bundles can ship it unchanged.');
assertFileExists('references/skill-map.md', 'Keep an install-facing skill-map reference in source so exported bundles can ship it unchanged.');
assertFileExists('tests/workflow-state.test.mjs', 'Keep a standalone automated test suite for workflow-state and gate behavior.');
assertFileExists('tests/skill-family.test.mjs', 'Keep automated coverage for the skill-family routing and packaging contract.');
assertFileExists('tests/skill-contract.test.mjs', 'Keep automated coverage for the structured skill contract and routing eval fixtures.');
assertFileExists('tests/fixtures/skill-routing-evals.json', 'Keep realistic routing eval fixtures for the umbrella skill intake contract.');
assertFileExists('tests/fixtures/skill-stop-rule-evals.json', 'Keep realistic stop-rule eval fixtures for command guardrails and approval gates.');
assertFileExists('tests/fixtures/skill-intake-evals.json', 'Keep realistic intake-policy eval fixtures for clarification and conflict handling.');
assertFileExists('tests/fixtures/skill-closeout-evals.json', 'Keep realistic closeout-shape eval fixtures for answer-first phase summaries.');
assertFileExists('tests/workflow-enhancements.test.mjs', 'Keep automated coverage for run indexing, schema audit, and tracking health additions.');
phaseSkillFiles.forEach(relativePath => {
  assertFileExists(relativePath, 'Phase skills should exist and remain explicitly tracked.');
});
agentMetadataFiles.forEach(relativePath => {
  assertFileExists(relativePath, 'Skill UI metadata should exist for each shipped skill.');
});
exportedBundleFiles.forEach(relativePath => {
  assertFileExists(relativePath, 'Self-contained skill bundles should export the installable skill surface.');
});
clawhubExportedBundleFiles.forEach(relativePath => {
  assertFileExists(relativePath, 'ClawHub exports should keep an installable slim publish surface.');
});
if (readText('VERSION').trim() !== readJson('package.json').version) {
  console.error('Check failed: VERSION must match package.json version.');
  process.exit(1);
}
assertDocumentedCommandsExist(contractMarkdownFiles, cliCommandNames);
assertPhaseArtifactsAreDocumented(phaseSkillFiles);
assertMarkdownLinksResolve(contractMarkdownFiles);
assertFileDoesNotContain('README.md', 'node dist/cli.js', 'Use the public wrapper or installed command name instead.');
assertFileDoesNotContain('SKILL.md', 'node dist/cli.js', 'Use the public wrapper or installed command name instead.');
assertFileDoesNotContain('references/output-contract.md', 'node dist/cli.js', 'Use the public wrapper or installed command name instead.');
assertFileDoesNotContain('references/event-schema-guide.md', 'node dist/cli.js', 'Reference guides should use the public wrapper.');
assertFileDoesNotContain('references/page-grouping-guide.md', 'node dist/cli.js', 'Reference guides should use the public wrapper.');
assertFileDoesNotContain('references/gtm-troubleshooting.md', 'node dist/cli.js', 'Reference guides should use the public wrapper.');
assertFileDoesNotContain('references/preview-report.md', 'https://www.jtracking.ai', 'Keep the default preview QA report template product-neutral.');
assertFileDoesNotContain('references/preview-report.md', 'JTracking Can Continue To Provide', 'Keep the default preview QA report template product-neutral.');
assertFileDoesNotContain('SKILL.md', 'https://www.jtracking.ai', 'Keep product marketing out of the core workflow contract.');
assertFileDoesNotContain('SKILL.md', 'JTracking', 'Keep product marketing out of the core workflow contract.');
assertFileDoesNotContain('SKILL.md', '## Phase Contracts', 'Keep the root skill at router scope; phase detail belongs in phase skills.');
assertFileContains('SKILL.md', 'compatibility:', 'Root skill frontmatter should declare runtime compatibility and capability notes.');
assertFileDoesNotContain('SKILL.md', '~/.codex/skills', 'Root skill guidance should avoid explicit hidden home-directory paths.');
assertFileDoesNotContain('docs/README.install.md', '~/.codex/skills', 'Install docs should avoid explicit hidden home-directory paths in user-facing guidance.');
assertFileDoesNotContain('README.md', './event-tracking mode <artifact-dir>', 'Keep the public README conversation-first; detailed CLI examples belong in maintainer docs.');
assertFileDoesNotContain('README.md', './event-tracking sync <artifact-dir>/gtm-config.json --dry-run', 'Keep the public README conversation-first; detailed CLI examples belong in maintainer docs.');
assertFileDoesNotContain('README.md', './event-tracking analyze-live-gtm <artifact-dir>/site-analysis.json --gtm-id GTM-XXXXXXX[,GTM-YYYYYYY]', 'Keep the public README conversation-first; detailed CLI examples belong in maintainer docs.');
assertFileDoesNotContain('README.md', './event-tracking preview <artifact-dir>/event-schema.json --context-file <artifact-dir>/gtm-context.json --baseline <previous-tracking-health.json>', 'Keep the public README conversation-first; detailed CLI examples belong in maintainer docs.');
assertFileDoesNotContain('README.md', './event-tracking auth-clear --context-file <artifact-dir>/gtm-context.json', 'Keep the public README conversation-first; detailed CLI examples belong in maintainer docs.');
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
assertFileExists(
  path.join(path.relative(repoRoot, tempInstallDir), 'analytics-tracking-automation', 'SKILL.md'),
  'Default installs should keep the install surface minimal by installing the umbrella skill.',
);
assertFileMissing(
  path.join(path.relative(repoRoot, tempInstallDir), 'tracking-schema', 'SKILL.md'),
  'Default installs should not silently include phase skills.',
);
assertFileExists(
  path.join(path.relative(repoRoot, tempSingleSkillInstallDir), 'tracking-schema', '.analytics-tracking-automation-install.json'),
  'Explicit single-skill installs should inject per-bundle auto-update metadata.',
);
assertJsonField(
  path.join(path.relative(repoRoot, tempSingleSkillInstallDir), 'tracking-schema', '.analytics-tracking-automation-install.json'),
  'autoUpdateEnabled',
  value => value === true,
  'Explicit single-skill installs should enable installed auto-update metadata.',
);
assertFileExists(
  path.join(path.relative(repoRoot, tempSingleSkillInstallDir), 'tracking-schema', 'runtime', 'skill-runtime', 'update-check.mjs'),
  'Explicit single-skill installs should ship the runtime update-check script.',
);
const installedSkillContent = fs.readFileSync(
  path.join(tempSingleSkillInstallDir, 'tracking-schema', 'SKILL.md'),
  'utf8',
);
if (!installedSkillContent.includes('## Installed Auto-Update')) {
  console.error('Check failed: copy-mode installed bundles should inject the Installed Auto-Update bootstrap.');
  process.exit(1);
}
const exportedSkillContent = fs.readFileSync(
  path.join(repoRoot, 'dist', 'skill-bundles', 'tracking-schema', 'SKILL.md'),
  'utf8',
);
const exportedRootSkillContent = fs.readFileSync(
  path.join(repoRoot, 'dist', 'skill-bundles', 'analytics-tracking-automation', 'SKILL.md'),
  'utf8',
);
const clawhubExportedRootSkillContent = fs.readFileSync(
  path.join(repoRoot, getExportBundleRoot(EXPORT_PROFILE_CLAWHUB), 'analytics-tracking-automation', 'SKILL.md'),
  'utf8',
);
const clawhubExportedRootBundleMetadata = readJson(
  path.join(getExportBundleRoot(EXPORT_PROFILE_CLAWHUB), 'analytics-tracking-automation', 'bundle.json'),
);
if (!exportedSkillContent.includes('## Auto-Update')) {
  console.error('Check failed: exported bundles should ship the portable Auto-Update bootstrap.');
  process.exit(1);
}
if (!exportedRootSkillContent.includes('compatibility:')) {
  console.error('Check failed: the exported root bundle should preserve compatibility frontmatter from the source skill.');
  process.exit(1);
}
if (exportedSkillContent.includes('## Installed Auto-Update')) {
  console.error('Check failed: exported bundles should keep the portable bootstrap, not the installed-only bootstrap.');
  process.exit(1);
}
if (exportedSkillContent.includes('~/.codex/skills')) {
  console.error('Check failed: exported bundles should avoid explicit hidden home-directory paths in the portable bootstrap.');
  process.exit(1);
}
assertResolvesTo(
  path.join(path.relative(repoRoot, tempLinkInstallDir), 'analytics-tracking-automation'),
  path.join(repoRoot, 'dist', 'skill-bundles', 'analytics-tracking-automation'),
  'Link-mode installs should resolve back to the exported bundle path.',
);
const linkedSkillContent = fs.readFileSync(
  path.join(tempLinkInstallDir, 'analytics-tracking-automation', 'SKILL.md'),
  'utf8',
);
if (linkedSkillContent.includes('## Installed Auto-Update')) {
  console.error('Check failed: link-mode installs should not inject the Installed Auto-Update bootstrap.');
  process.exit(1);
}
if (!linkedSkillContent.includes('## Auto-Update')) {
  console.error('Check failed: link-mode installs should still expose the portable Auto-Update bootstrap from the exported bundle.');
  process.exit(1);
}
if (clawhubExportedRootSkillContent.includes('## Auto-Update')) {
  console.error('Check failed: ClawHub exports should strip the Auto-Update bootstrap.');
  process.exit(1);
}
if ('updateSource' in clawhubExportedRootBundleMetadata) {
  console.error('Check failed: ClawHub bundle metadata should not advertise updater sources.');
  process.exit(1);
}
assertFileMissing(
  path.join(getExportBundleRoot(EXPORT_PROFILE_CLAWHUB), 'analytics-tracking-automation', 'runtime', 'skill-runtime', 'update-check.mjs'),
  'ClawHub exports should not ship the updater runtime.',
);
assertFileExists(
  path.join(getExportBundleRoot(EXPORT_PROFILE_CLAWHUB), 'analytics-tracking-automation', 'runtime', 'cli-runtime', 'run-cli.mjs'),
  'ClawHub exports should ship the bundled CLI bootstrap.',
);
assertFileExists(
  path.join(getExportBundleRoot(EXPORT_PROFILE_CLAWHUB), 'analytics-tracking-automation', 'runtime', 'cli-package', 'dist', 'cli.js'),
  'ClawHub exports should ship the compiled bundled CLI runtime.',
);
[
  'analytics-tracking-automation/references/architecture.md',
  'analytics-tracking-automation/references/skill-map.md',
].forEach(relativePath => {
  assertFileExists(path.join(path.relative(repoRoot, tempInstallDir), relativePath), 'Installed umbrella bundles should keep their reference files.');
});
allBundles.forEach(bundle => {
  const relativePath = path.join(bundle.name, 'SKILL.md');
  assertFileExists(path.join(path.relative(repoRoot, tempFullInstallDir), relativePath), 'Full-family installs should land every bundle in the requested target directory.');
});
[
  'tracking-schema/references/architecture.md',
  'tracking-shopify/references/architecture.md',
].forEach(relativePath => {
  assertFileExists(path.join(path.relative(repoRoot, tempFullInstallDir), relativePath), 'Full-family installs should keep shared reference files for phase bundles.');
});

fs.rmSync(tempInstallDir, { recursive: true, force: true });
fs.rmSync(tempSingleSkillInstallDir, { recursive: true, force: true });
fs.rmSync(tempFullInstallDir, { recursive: true, force: true });
fs.rmSync(tempLinkInstallDir, { recursive: true, force: true });

console.log('==> Check completed successfully');
