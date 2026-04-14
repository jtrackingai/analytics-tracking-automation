import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;

function runNode(args, options = {}) {
  const result = spawnSync('node', args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
  });

  if (result.status !== 0) {
    throw new Error([
      `Command failed: node ${args.join(' ')}`,
      result.stdout?.trim() ? `stdout: ${result.stdout.trim()}` : '',
      result.stderr?.trim() ? `stderr: ${result.stderr.trim()}` : '',
    ].filter(Boolean).join('\n'));
  }

  return result;
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function installCopiedBundle(targetDir, skillName = 'tracking-schema') {
  runNode(['scripts/export-skills.mjs']);
  runNode([
    'scripts/install-skills.mjs',
    '--skip-export',
    '--target-dir',
    targetDir,
    '--skill',
    skillName,
  ]);
}

function installPortableRootSkill(targetDir) {
  const bundleDir = path.join(targetDir, 'event-tracking-skill');
  copyRepoWithoutBuildOutputs(bundleDir);
  return bundleDir;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function bumpPatch(version) {
  const parts = version.trim().split('.');
  if (parts.length !== 3) {
    throw new Error(`Unsupported version format: ${version}`);
  }

  const [major, minor, patch] = parts.map(part => Number.parseInt(part, 10));
  if ([major, minor, patch].some(Number.isNaN)) {
    throw new Error(`Unsupported version format: ${version}`);
  }

  return `${major}.${minor}.${patch + 1}`;
}

function toFileUrl(filePath) {
  return new URL(`file://${filePath}`);
}

function copyRepoWithoutBuildOutputs(targetDir) {
  fs.cpSync(repoRoot, targetDir, {
    recursive: true,
    filter(sourcePath) {
      const relativePath = path.relative(repoRoot, sourcePath);
      if (!relativePath) {
        return true;
      }

      const topLevel = relativePath.split(path.sep)[0];
      return !['.git', 'dist', 'node_modules'].includes(topLevel);
    },
  });
}

function createTarball(sourceDir, tarballFile) {
  const parentDir = path.dirname(sourceDir);
  const folderName = path.basename(sourceDir);
  const result = spawnSync('tar', ['-czf', tarballFile, '-C', parentDir, folderName], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `Failed to create tarball ${tarballFile}`);
  }
}

test('copy install injects auto-update bootstrap and metadata', () => {
  const targetDir = makeTempDir('event-tracking-auto-update-install-');

  installCopiedBundle(targetDir);

  const bundleDir = path.join(targetDir, 'tracking-schema');
  const metadata = readJson(path.join(bundleDir, '.event-tracking-install.json'));
  const skillContent = fs.readFileSync(path.join(bundleDir, 'SKILL.md'), 'utf8');

  assert.equal(metadata.autoUpdateEnabled, true);
  assert.equal(metadata.installMode, 'copy');
  assert.deepEqual(metadata.selectedBundles, ['tracking-schema']);
  assert.match(skillContent, /## Installed Auto-Update/);
  assert.match(skillContent, /update-check\.mjs" --json/);
});

test('portable root installs can check for updates without install metadata', () => {
  const targetDir = makeTempDir('event-tracking-portable-root-check-');
  const bundleDir = installPortableRootSkill(targetDir);
  const versionFile = path.join(makeTempDir('event-tracking-version-source-'), 'VERSION');
  fs.writeFileSync(versionFile, '9.9.9\n');

  const skillContent = fs.readFileSync(path.join(bundleDir, 'SKILL.md'), 'utf8');
  assert.match(skillContent, /## Auto-Update/);
  assert.equal(fs.existsSync(path.join(bundleDir, '.event-tracking-install.json')), false);

  const result = runNode(
    [path.join(bundleDir, 'runtime', 'skill-runtime', 'update-check.mjs'), '--json', '--force'],
    {
      env: {
        EVENT_TRACKING_ALLOW_FILE_UPDATE_SOURCE: '1',
        EVENT_TRACKING_UPDATE_VERSION_URL: toFileUrl(versionFile).toString(),
      },
    },
  );

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'update_available');
  assert.equal(payload.installMode, 'portable');
  assert.equal(payload.latestVersion, '9.9.9');
  assert.deepEqual(payload.selectedBundles, ['event-tracking-skill']);
  assert.match(payload.updateCommand, /self-update\.mjs"\s+--apply|self-update\.mjs\s+--apply/);
});

test('update-check reports update_available when remote VERSION is newer', () => {
  const targetDir = makeTempDir('event-tracking-auto-update-check-');
  installCopiedBundle(targetDir);

  const bundleDir = path.join(targetDir, 'tracking-schema');
  const versionFile = path.join(makeTempDir('event-tracking-version-source-'), 'VERSION');
  fs.writeFileSync(versionFile, '9.9.9\n');

  const result = runNode(
    [path.join(bundleDir, 'runtime', 'skill-runtime', 'update-check.mjs'), '--json', '--force'],
    {
      env: {
        EVENT_TRACKING_ALLOW_FILE_UPDATE_SOURCE: '1',
        EVENT_TRACKING_UPDATE_VERSION_URL: toFileUrl(versionFile).toString(),
      },
    },
  );

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'update_available');
  assert.equal(payload.latestVersion, '9.9.9');
  assert.match(payload.updateCommand, /self-update\.mjs"\s+--apply|self-update\.mjs\s+--apply/);
});

test('self-update reinstalls selected bundles from a newer local tarball source', () => {
  const targetDir = makeTempDir('event-tracking-self-update-target-');
  installCopiedBundle(targetDir);
  const remoteVersion = bumpPatch(repoVersion);

  const remoteRepoDir = path.join(makeTempDir('event-tracking-remote-repo-'), 'event-tracking-skill');
  copyRepoWithoutBuildOutputs(remoteRepoDir);
  fs.writeFileSync(path.join(remoteRepoDir, 'VERSION'), `${remoteVersion}\n`);
  fs.writeFileSync(
    path.join(remoteRepoDir, 'skills', 'tracking-schema', 'SKILL.md'),
    fs.readFileSync(path.join(remoteRepoDir, 'skills', 'tracking-schema', 'SKILL.md'), 'utf8')
      .replace('# Tracking Schema', '# Tracking Schema\n\nUpdated marker: runtime-self-update-test'),
  );

  const tarballFile = path.join(makeTempDir('event-tracking-remote-tarball-'), 'event-tracking-skill.tar.gz');
  createTarball(remoteRepoDir, tarballFile);

  const bundleDir = path.join(targetDir, 'tracking-schema');
  runNode(
    [path.join(bundleDir, 'runtime', 'skill-runtime', 'self-update.mjs'), '--apply', '--force'],
    {
      env: {
        EVENT_TRACKING_ALLOW_FILE_UPDATE_SOURCE: '1',
        EVENT_TRACKING_UPDATE_VERSION_URL: toFileUrl(path.join(remoteRepoDir, 'VERSION')).toString(),
        EVENT_TRACKING_UPDATE_TARBALL_URL: toFileUrl(tarballFile).toString(),
      },
    },
  );

  const updatedMetadata = readJson(path.join(bundleDir, '.event-tracking-install.json'));
  const updatedSkill = fs.readFileSync(path.join(bundleDir, 'SKILL.md'), 'utf8');

  assert.equal(updatedMetadata.installedVersion, remoteVersion);
  assert.match(updatedSkill, /runtime-self-update-test/);
});

test('portable root self-update migrates into installer-managed copy layout', () => {
  const targetDir = makeTempDir('event-tracking-portable-root-update-target-');
  const bundleDir = installPortableRootSkill(targetDir);
  const remoteVersion = bumpPatch(repoVersion);

  const remoteRepoDir = path.join(makeTempDir('event-tracking-remote-root-repo-'), 'event-tracking-skill');
  copyRepoWithoutBuildOutputs(remoteRepoDir);
  fs.writeFileSync(path.join(remoteRepoDir, 'VERSION'), `${remoteVersion}\n`);
  fs.writeFileSync(
    path.join(remoteRepoDir, 'SKILL.md'),
    fs.readFileSync(path.join(remoteRepoDir, 'SKILL.md'), 'utf8')
      .replace('# Event Tracking Skill', '# Event Tracking Skill\n\nUpdated marker: portable-root-self-update-test'),
  );

  const tarballFile = path.join(makeTempDir('event-tracking-remote-root-tarball-'), 'event-tracking-skill.tar.gz');
  createTarball(remoteRepoDir, tarballFile);

  runNode(
    [path.join(bundleDir, 'runtime', 'skill-runtime', 'self-update.mjs'), '--apply', '--force'],
    {
      env: {
        EVENT_TRACKING_ALLOW_FILE_UPDATE_SOURCE: '1',
        EVENT_TRACKING_UPDATE_VERSION_URL: toFileUrl(path.join(remoteRepoDir, 'VERSION')).toString(),
        EVENT_TRACKING_UPDATE_TARBALL_URL: toFileUrl(tarballFile).toString(),
      },
    },
  );

  const updatedMetadata = readJson(path.join(bundleDir, '.event-tracking-install.json'));
  const updatedSkill = fs.readFileSync(path.join(bundleDir, 'SKILL.md'), 'utf8');

  assert.equal(updatedMetadata.installedVersion, remoteVersion);
  assert.equal(updatedMetadata.installMode, 'copy');
  assert.match(updatedSkill, /portable-root-self-update-test/);
  assert.match(updatedSkill, /## Installed Auto-Update/);
});

test('update-check refuses file-based update sources unless explicitly allowed', () => {
  const targetDir = makeTempDir('event-tracking-auto-update-file-source-blocked-');
  installCopiedBundle(targetDir);

  const bundleDir = path.join(targetDir, 'tracking-schema');
  const versionFile = path.join(makeTempDir('event-tracking-version-source-'), 'VERSION');
  fs.writeFileSync(versionFile, '9.9.9\n');

  const result = runNode(
    [path.join(bundleDir, 'runtime', 'skill-runtime', 'update-check.mjs'), '--json', '--force'],
    {
      env: {
        EVENT_TRACKING_UPDATE_VERSION_URL: toFileUrl(versionFile).toString(),
      },
    },
  );

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'error');
  assert.match(payload.reason || '', /EVENT_TRACKING_ALLOW_FILE_UPDATE_SOURCE=1/);
});

test('update-check pins the default github tarball source to the fetched version tag', () => {
  const targetDir = makeTempDir('event-tracking-auto-update-tag-pin-');
  installCopiedBundle(targetDir);

  const bundleDir = path.join(targetDir, 'tracking-schema');
  const versionFile = path.join(makeTempDir('event-tracking-version-source-'), 'VERSION');
  fs.writeFileSync(versionFile, '9.9.9\n');

  const result = runNode(
    [path.join(bundleDir, 'runtime', 'skill-runtime', 'update-check.mjs'), '--json', '--force'],
    {
      env: {
        EVENT_TRACKING_ALLOW_FILE_UPDATE_SOURCE: '1',
        EVENT_TRACKING_UPDATE_VERSION_URL: toFileUrl(versionFile).toString(),
      },
    },
  );

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.latestVersion, '9.9.9');
  assert.equal(payload.updateSource.tarballUrl, 'https://codeload.github.com/jtrackingai/event-tracking-skill/tar.gz/refs/tags/v9.9.9');
});

test('self-update verifies tarball sha256 when provided', () => {
  const targetDir = makeTempDir('event-tracking-self-update-sha256-');
  installCopiedBundle(targetDir);
  const remoteVersion = bumpPatch(repoVersion);

  const remoteRepoDir = path.join(makeTempDir('event-tracking-remote-repo-sha-'), 'event-tracking-skill');
  copyRepoWithoutBuildOutputs(remoteRepoDir);
  fs.writeFileSync(path.join(remoteRepoDir, 'VERSION'), `${remoteVersion}\n`);

  const tarballFile = path.join(makeTempDir('event-tracking-remote-tarball-sha-'), 'event-tracking-skill.tar.gz');
  createTarball(remoteRepoDir, tarballFile);

  const bundleDir = path.join(targetDir, 'tracking-schema');
  const result = spawnSync(
    'node',
    [path.join(bundleDir, 'runtime', 'skill-runtime', 'self-update.mjs'), '--apply', '--force'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT_TRACKING_ALLOW_FILE_UPDATE_SOURCE: '1',
        EVENT_TRACKING_UPDATE_VERSION_URL: toFileUrl(path.join(remoteRepoDir, 'VERSION')).toString(),
        EVENT_TRACKING_UPDATE_TARBALL_URL: toFileUrl(tarballFile).toString(),
        EVENT_TRACKING_UPDATE_TARBALL_SHA256: 'deadbeef',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout || ''}${result.stderr || ''}`, /SHA256 mismatch/);
});
