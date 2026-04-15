#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

export const SOURCE_SKILL_MANIFEST = 'skills/manifest.json';
export const SKILL_FAMILY_NAME = 'analytics-tracking-automation';
export const SKILL_FAMILY_REPOSITORY = 'jtrackingai/analytics-tracking-automation';
export const EXPORT_PROFILE_PORTABLE = 'portable';
export const EXPORT_PROFILE_CLAWHUB = 'clawhub';

const AUTO_UPDATE_BOOTSTRAP_START = '<!-- analytics-tracking-automation auto-update bootstrap:start -->';
const AUTO_UPDATE_BOOTSTRAP_END = '<!-- analytics-tracking-automation auto-update bootstrap:end -->';

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

export function getExportBundleRoot(profile = EXPORT_PROFILE_PORTABLE) {
  return profile === EXPORT_PROFILE_CLAWHUB
    ? path.join('dist', 'clawhub-skill-bundles')
    : path.join('dist', 'skill-bundles');
}

export function getProfileBundleOutputPath(bundle, profile = EXPORT_PROFILE_PORTABLE) {
  return path.join(getExportBundleRoot(profile), bundle.name);
}

export function getCopiedDirectoriesForProfile(bundle, profile = EXPORT_PROFILE_PORTABLE) {
  if (profile === EXPORT_PROFILE_CLAWHUB) {
    return (bundle.copiedDirectories || []).filter(copyEntry => copyEntry.target === 'references');
  }

  return bundle.copiedDirectories || [];
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

export function listExpectedExportedFiles(repoRoot, manifest, options = {}) {
  const profile = options.profile || EXPORT_PROFILE_PORTABLE;
  const exportRoot = getExportBundleRoot(profile);
  const expected = new Set([path.join(exportRoot, 'manifest.json')]);

  getSkillBundles(manifest).forEach(bundle => {
    const bundleRoot = getProfileBundleOutputPath(bundle, profile);
    expected.add(path.join(bundleRoot, 'SKILL.md'));
    expected.add(path.join(bundleRoot, 'VERSION'));
    expected.add(path.join(bundleRoot, 'bundle.json'));
    expected.add(path.join(bundleRoot, 'agents', 'openai.yaml'));

    getCopiedDirectoriesForProfile(bundle, profile).forEach(copyEntry => {
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

function removeAutoUpdateBootstrap(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  const markerPattern = new RegExp(`\\n?${escapeRegExp(AUTO_UPDATE_BOOTSTRAP_START)}[\\s\\S]*?${escapeRegExp(AUTO_UPDATE_BOOTSTRAP_END)}\\n?`, 'g');
  return normalized.replace(markerPattern, '\n').replace(/\n{3,}/g, '\n\n');
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
    `1. Resolve the directory that contains this installed \`SKILL.md\`. Installer-managed copies usually live under the skills directory configured by your agent environment, such as \`$CODEX_HOME/skills/${bundleName}\` or an equivalent runtime-managed path.`,
    '2. Run `node "<bundle-dir>/runtime/skill-runtime/update-check.mjs" --json`.',
    '3. If the result status is `update_available`, immediately run `node "<bundle-dir>/runtime/skill-runtime/self-update.mjs" --apply`.',
    '4. If the update succeeds, read `<bundle-dir>/SKILL.md` again before continuing so you are using the refreshed instructions.',
    '5. If the result status is `disabled`, treat this bundle as a local development link or repo checkout and continue without updating.',
    '6. The updater refreshes this bundle and any sibling analytics-tracking-automation bundles in the same installed skills directory.',
    '',
    `${AUTO_UPDATE_BOOTSTRAP_END}`,
    '',
  ].join('\n');
}

export function normalizeSkillContent(bundle, content, options = {}) {
  const profile = options.profile || EXPORT_PROFILE_PORTABLE;
  const normalizedContent = bundle.kind === 'umbrella'
    ? normalizePublicCommand(content)
    : normalizePublicCommand(content)
      .replaceAll('../../references/', 'references/')
      .replaceAll('../../references/architecture.md', 'references/architecture.md');

  if (profile === EXPORT_PROFILE_CLAWHUB) {
    return removeAutoUpdateBootstrap(normalizedContent);
  }

  const portableBootstrap = buildPortableAutoUpdateBootstrap(bundle.name);

  return replaceOrInjectAutoUpdateBootstrap(normalizedContent, portableBootstrap);
}
