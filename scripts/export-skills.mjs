#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getBundleOutputPath,
  getSkillBundles,
  loadSourceSkillManifest,
  normalizeSkillContent,
} from './skill-bundles.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundleRoot = path.join(repoRoot, 'dist', 'skill-bundles');

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

function exportBundle(bundle) {
  const outputPath = path.join(repoRoot, getBundleOutputPath(bundle));
  ensureDir(outputPath);

  writeFile(path.join(outputPath, 'SKILL.md'), normalizeSkillContent(bundle, readText(bundle.skillFile)));
  copyFile(bundle.metadataFile, path.join(outputPath, 'agents', 'openai.yaml'));

  (bundle.copiedDirectories || []).forEach(copyEntry => {
    copyDirectory(copyEntry.source, path.join(outputPath, copyEntry.target));
  });

  return {
    name: bundle.name,
    kind: bundle.kind,
    sourceSkillFile: bundle.skillFile,
    outputPath: path.relative(repoRoot, outputPath),
  };
}

fs.rmSync(bundleRoot, { recursive: true, force: true });
ensureDir(bundleRoot);

const sourceManifest = loadSourceSkillManifest(repoRoot);
const bundles = getSkillBundles(sourceManifest);
const manifest = {
  generatedAt: new Date().toISOString(),
  sourceManifest: 'skills/manifest.json',
  bundles: bundles.map(exportBundle),
};

writeFile(path.join(bundleRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Exported ${manifest.bundles.length} skill bundles to ${path.relative(repoRoot, bundleRoot)}`);
