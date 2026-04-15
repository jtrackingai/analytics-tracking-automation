#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPORT_PROFILE_CLAWHUB,
  EXPORT_PROFILE_PORTABLE,
  getCopiedDirectoriesForProfile,
  getProfileBundleOutputPath,
  getExportBundleRoot,
  getSkillBundles,
  loadSourceSkillManifest,
  normalizeSkillContent,
  SKILL_FAMILY_NAME,
  SKILL_FAMILY_REPOSITORY,
} from './skill-bundles.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function writeFile(targetPath, content) {
  ensureDir(path.dirname(targetPath));
  fs.writeFileSync(targetPath, content);
}

function copyFile(relativeSourcePath, targetPath) {
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(path.join(repoRoot, relativeSourcePath), targetPath);
}

function copyDirectory(relativeSourcePath, targetPath) {
  const sourcePath = path.join(repoRoot, relativeSourcePath);
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    const sourceEntryPath = path.join(sourcePath, entry.name);
    const targetEntryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(path.relative(repoRoot, sourceEntryPath), targetEntryPath);
      continue;
    }
    ensureDir(path.dirname(targetEntryPath));
    fs.copyFileSync(sourceEntryPath, targetEntryPath);
  }
}

function readText(relativeSourcePath) {
  return fs.readFileSync(path.join(repoRoot, relativeSourcePath), 'utf8');
}

function readVersion() {
  return readText('VERSION').trim();
}

function parseArgs(argv) {
  const options = {
    profile: EXPORT_PROFILE_PORTABLE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--profile') {
      index += 1;
      options.profile = argv[index] ?? '';
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (![EXPORT_PROFILE_PORTABLE, EXPORT_PROFILE_CLAWHUB].includes(options.profile)) {
    throw new Error(`Invalid --profile value: ${options.profile || '(missing)'}`);
  }

  return options;
}

function buildBundleMetadata(bundle, familyVersion, profile) {
  const metadata = {
    name: bundle.name,
    kind: bundle.kind,
    familyName: SKILL_FAMILY_NAME,
    repository: SKILL_FAMILY_REPOSITORY,
    familyVersion,
  };

  if (profile === EXPORT_PROFILE_CLAWHUB) {
    return metadata;
  }

  return {
    ...metadata,
    updateSource: {
      provider: 'github-tarball',
      versionUrl: process.env.EVENT_TRACKING_UPDATE_VERSION_URL || 'https://raw.githubusercontent.com/jtrackingai/analytics-tracking-automation/main/VERSION',
      tarballUrl: process.env.EVENT_TRACKING_UPDATE_TARBALL_URL || 'https://codeload.github.com/jtrackingai/analytics-tracking-automation/tar.gz/refs/heads/main',
    },
  };
}

function exportBundle(bundle, profile) {
  const outputPath = path.join(repoRoot, getProfileBundleOutputPath(bundle, profile));
  ensureDir(outputPath);
  const familyVersion = readVersion();

  writeFile(path.join(outputPath, 'SKILL.md'), normalizeSkillContent(bundle, readText(bundle.skillFile), { profile }));
  writeFile(path.join(outputPath, 'VERSION'), `${familyVersion}\n`);
  writeFile(path.join(outputPath, 'bundle.json'), JSON.stringify(buildBundleMetadata(bundle, familyVersion, profile), null, 2) + '\n');
  copyFile(bundle.metadataFile, path.join(outputPath, 'agents', 'openai.yaml'));

  getCopiedDirectoriesForProfile(bundle, profile).forEach(copyEntry => {
    copyDirectory(copyEntry.source, path.join(outputPath, copyEntry.target));
  });

  return {
    name: bundle.name,
    kind: bundle.kind,
    sourceSkillFile: bundle.skillFile,
    outputPath: path.relative(repoRoot, outputPath),
  };
}

const options = parseArgs(process.argv.slice(2));
const bundleRoot = path.join(repoRoot, getExportBundleRoot(options.profile));

fs.rmSync(bundleRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
ensureDir(bundleRoot);

const sourceManifest = loadSourceSkillManifest(repoRoot);
const bundles = getSkillBundles(sourceManifest);
const manifest = {
  generatedAt: new Date().toISOString(),
  profile: options.profile,
  sourceManifest: 'skills/manifest.json',
  bundles: bundles.map(bundle => exportBundle(bundle, options.profile)),
};

writeFile(path.join(bundleRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Exported ${manifest.bundles.length} ${options.profile} skill bundles to ${path.relative(repoRoot, bundleRoot)}`);
