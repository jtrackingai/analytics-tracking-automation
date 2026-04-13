#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

export const SOURCE_SKILL_MANIFEST = 'skills/manifest.json';
export const SKILL_FAMILY_NAME = 'event-tracking-skill';
export const SKILL_FAMILY_REPOSITORY = 'jtrackingai/event-tracking-skill';

const AUTO_UPDATE_BOOTSTRAP_START = '<!-- event-tracking auto-update bootstrap:start -->';
const AUTO_UPDATE_BOOTSTRAP_END = '<!-- event-tracking auto-update bootstrap:end -->';

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${label}: expected a non-empty string.`);
  }
}

export function loadSourceSkillManifest(repoRoot) {
  const manifestPath = path.join(repoRoot, SOURCE_SKILL_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing ${SOURCE_SKILL_MANIFEST}.`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || !Array.isArray(manifest.bundles) || manifest.bundles.length === 0) {
    throw new Error(`${SOURCE_SKILL_MANIFEST} must contain a non-empty "bundles" array.`);
  }

  manifest.bundles.forEach((bundle, index) => {
    const prefix = `bundles[${index}]`;
    assertNonEmptyString(bundle.name, `${prefix}.name`);
    assertNonEmptyString(bundle.kind, `${prefix}.kind`);
    assertNonEmptyString(bundle.skillFile, `${prefix}.skillFile`);
    assertNonEmptyString(bundle.metadataFile, `${prefix}.metadataFile`);

    if (bundle.kind !== 'umbrella' && bundle.kind !== 'phase') {
      throw new Error(`Invalid ${prefix}.kind: expected "umbrella" or "phase".`);
    }

    if (bundle.copiedDirectories !== undefined) {
      if (!Array.isArray(bundle.copiedDirectories)) {
        throw new Error(`Invalid ${prefix}.copiedDirectories: expected an array.`);
      }

      bundle.copiedDirectories.forEach((entry, entryIndex) => {
        assertNonEmptyString(entry?.source, `${prefix}.copiedDirectories[${entryIndex}].source`);
        assertNonEmptyString(entry?.target, `${prefix}.copiedDirectories[${entryIndex}].target`);
      });
    }

  });

  return manifest;
}

export function getSkillBundles(manifest) {
  return manifest.bundles;
}

export function getPhaseSkillBundles(manifest) {
  return manifest.bundles.filter(bundle => bundle.kind === 'phase');
}

export function getBundleOutputPath(bundle) {
  return path.join('dist', 'skill-bundles', bundle.name);
}

function listFilesRecursive(rootDir) {
  const files = [];

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
      continue;
    }
    files.push(fullPath);
  }

  return files;
}

export function listExpectedExportedFiles(repoRoot, manifest) {
  const expected = new Set(['dist/skill-bundles/manifest.json']);

  getSkillBundles(manifest).forEach(bundle => {
    const bundleRoot = getBundleOutputPath(bundle);
    expected.add(path.join(bundleRoot, 'SKILL.md'));
    expected.add(path.join(bundleRoot, 'VERSION'));
    expected.add(path.join(bundleRoot, 'bundle.json'));
    expected.add(path.join(bundleRoot, 'agents', 'openai.yaml'));

    (bundle.copiedDirectories || []).forEach(copyEntry => {
      const sourceRoot = path.join(repoRoot, copyEntry.source);
      const sourceFiles = listFilesRecursive(sourceRoot);
      sourceFiles.forEach(sourceFile => {
        const relativeFile = path.relative(sourceRoot, sourceFile);
        expected.add(path.join(bundleRoot, copyEntry.target, relativeFile));
      });
    });

  });

  return [...expected];
}

export function normalizePublicCommand(content) {
  return content
    .replaceAll(
      '1. Use the repo-local wrapper `./event-tracking` for CLI commands in this repository. If the wrapper reports that `dist/cli.js` is missing, run `npm run build` first.',
      '1. Use the public command `event-tracking` for CLI commands. If the command is unavailable, install or link the package first.',
    )
    .replaceAll('In this repository, use the repo-root wrapper:', 'Use the public command:')
    .replaceAll('the repo-local wrapper `./event-tracking`', 'the public command `event-tracking`')
    .replaceAll('repo-local wrapper `./event-tracking`', 'public command `event-tracking`')
    .replaceAll('./event-tracking', 'event-tracking');
}

function injectAfterFrontmatter(content, insertedContent) {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return `${insertedContent}${normalized}`;
  }

  const closingIndex = normalized.indexOf('\n---\n', 4);
  if (closingIndex === -1) {
    return `${insertedContent}${normalized}`;
  }

  const insertAt = closingIndex + '\n---\n'.length;
  return `${normalized.slice(0, insertAt)}\n${insertedContent}${normalized.slice(insertAt)}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceOrInjectAutoUpdateBootstrap(content, bootstrap) {
  const normalized = content.replace(/\r\n/g, '\n');
  const markerPattern = new RegExp(`${escapeRegExp(AUTO_UPDATE_BOOTSTRAP_START)}[\\s\\S]*?${escapeRegExp(AUTO_UPDATE_BOOTSTRAP_END)}\\n?`);

  if (markerPattern.test(normalized)) {
    return normalized.replace(markerPattern, `${bootstrap}\n`);
  }

  return injectAfterFrontmatter(normalized, bootstrap);
}

function buildPortableAutoUpdateBootstrap(bundleName) {
  return [
    `${AUTO_UPDATE_BOOTSTRAP_START}`,
    '## Auto-Update',
    '',
    'This installed skill bundle can self-check for newer GitHub versions before you continue.',
    'It works for built-in copy installs, exported bundle copies, and `npx skills add ...` installs that include this runtime directory.',
    '',
    'Before doing any task in this bundle:',
    '',
    `1. Resolve the directory that contains this installed \`SKILL.md\`. Installer-managed copies usually live under a skills directory such as \`$CODEX_HOME/skills/${bundleName}\` or \`~/.codex/skills/${bundleName}\`.`,
    '2. Run `node "<bundle-dir>/runtime/skill-runtime/update-check.mjs" --json`.',
    '3. If the result status is `update_available`, immediately run `node "<bundle-dir>/runtime/skill-runtime/self-update.mjs" --apply`.',
    '4. If the update succeeds, read `<bundle-dir>/SKILL.md` again before continuing so you are using the refreshed instructions.',
    '5. If the result status is `disabled`, treat this bundle as a local development link or repo checkout and continue without updating.',
    '6. The updater refreshes this bundle and any sibling event-tracking bundles in the same installed skills directory.',
    '',
    `${AUTO_UPDATE_BOOTSTRAP_END}`,
    '',
  ].join('\n');
}

export function normalizeSkillContent(bundle, content) {
  const portableBootstrap = buildPortableAutoUpdateBootstrap(bundle.name);

  if (bundle.kind === 'umbrella') {
    return replaceOrInjectAutoUpdateBootstrap(normalizePublicCommand(content), portableBootstrap);
  }

  return replaceOrInjectAutoUpdateBootstrap(
    normalizePublicCommand(content)
      .replaceAll('../../references/', 'references/')
      .replaceAll('../../references/architecture.md', 'references/architecture.md'),
    portableBootstrap,
  );
}
