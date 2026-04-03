#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

export const SOURCE_SKILL_MANIFEST = 'skills/manifest.json';

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

export function normalizeSkillContent(bundle, content) {
  if (bundle.kind === 'umbrella') {
    return normalizePublicCommand(content);
  }

  return normalizePublicCommand(content)
    .replaceAll('../../references/', 'references/')
    .replaceAll('../../references/architecture.md', 'references/architecture.md');
}
