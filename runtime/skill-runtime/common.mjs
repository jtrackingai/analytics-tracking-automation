import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_FAMILY_NAME = 'event-tracking-skill';
const DEFAULT_REPOSITORY = 'jtrackingai/event-tracking-skill';
const DEFAULT_VERSION_URL = 'https://raw.githubusercontent.com/jtrackingai/event-tracking-skill/main/VERSION';
const DEFAULT_TARBALL_URL = 'https://codeload.github.com/jtrackingai/event-tracking-skill/tar.gz/refs/heads/main';

function buildTaggedTarballUrl(repository, version) {
  return `https://codeload.github.com/${repository}/tar.gz/refs/tags/v${version}`;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readTextIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return fs.readFileSync(filePath, 'utf8');
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) {
    return null;
  }

  return match.slice(1).map(part => Number.parseInt(part, 10));
}

function compareVersions(left, right) {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);

  if (!leftParts || !rightParts) {
    return left.localeCompare(right);
  }

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }

  return 0;
}

function getCodexHome() {
  if (process.env.CODEX_HOME?.trim()) {
    return path.resolve(process.env.CODEX_HOME);
  }

  return path.join(os.homedir(), '.codex');
}

function getBundleDir(metaUrl) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), '..', '..');
}

function getRuntimePaths(bundleDir) {
  return {
    bundleDir,
    skillFile: path.join(bundleDir, 'SKILL.md'),
    versionFile: path.join(bundleDir, 'VERSION'),
    bundleMetadataFile: path.join(bundleDir, 'bundle.json'),
    installMetadataFile: path.join(bundleDir, '.event-tracking-install.json'),
    updateStateFile: path.join(bundleDir, '.event-tracking-update-state.json'),
  };
}

function parseFrontmatterValue(markdown, key) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return null;
  }

  const closingIndex = normalized.indexOf('\n---\n', 4);
  if (closingIndex === -1) {
    return null;
  }

  const frontmatter = normalized.slice(4, closingIndex);
  for (const line of frontmatter.split('\n')) {
    if (!line.startsWith(`${key}:`)) {
      continue;
    }
    return line.slice(`${key}:`.length).trim();
  }

  return null;
}

function deriveBundleMetadata(paths, bundleDir) {
  const skillContent = readTextIfExists(paths.skillFile) || '';
  const version = (readTextIfExists(paths.versionFile) || '').trim() || '0.0.0';
  const bundleName = parseFrontmatterValue(skillContent, 'name') || path.basename(bundleDir);

  return {
    name: bundleName,
    kind: bundleName === DEFAULT_FAMILY_NAME ? 'umbrella' : 'phase',
    familyName: DEFAULT_FAMILY_NAME,
    repository: DEFAULT_REPOSITORY,
    familyVersion: version,
    updateSource: {
      provider: 'github-tarball',
      versionUrl: DEFAULT_VERSION_URL,
      tarballUrl: DEFAULT_TARBALL_URL,
    },
  };
}

function loadInstallContext(metaUrl) {
  const bundleDir = getBundleDir(metaUrl);
  const paths = getRuntimePaths(bundleDir);
  const bundleMetadata = readJsonIfExists(paths.bundleMetadataFile) || deriveBundleMetadata(paths, bundleDir);
  const installMetadata = readJsonIfExists(paths.installMetadataFile);

  return {
    bundleDir,
    paths,
    bundleMetadata,
    installMetadata,
  };
}

function resolveUpdateSource(bundleMetadata, installMetadata) {
  const source = {
    provider: 'github-tarball',
    repository: bundleMetadata.repository || DEFAULT_REPOSITORY,
    versionUrl: process.env.EVENT_TRACKING_UPDATE_VERSION_URL
      || installMetadata?.updateSource?.versionUrl
      || bundleMetadata.updateSource?.versionUrl
      || DEFAULT_VERSION_URL,
    tarballUrl: process.env.EVENT_TRACKING_UPDATE_TARBALL_URL
      || installMetadata?.updateSource?.tarballUrl
      || bundleMetadata.updateSource?.tarballUrl
      || DEFAULT_TARBALL_URL,
    tarballSha256: process.env.EVENT_TRACKING_UPDATE_TARBALL_SHA256
      || installMetadata?.updateSource?.tarballSha256
      || bundleMetadata.updateSource?.tarballSha256
      || null,
  };

  return source;
}

function validateUpdateUrl(url, label) {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') {
    return;
  }

  if (parsed.protocol === 'file:' && process.env.EVENT_TRACKING_ALLOW_FILE_UPDATE_SOURCE === '1') {
    return;
  }

  if (parsed.protocol === 'file:') {
    throw new Error(`Refusing ${label} URL with file: protocol unless EVENT_TRACKING_ALLOW_FILE_UPDATE_SOURCE=1.`);
  }

  throw new Error(`Unsupported ${label} URL protocol: ${parsed.protocol}. Only https is allowed for updater sources.`);
}

function resolvePinnedTarballUrl(source, latestVersion) {
  if (
    source.provider === 'github-tarball'
    && source.tarballUrl === DEFAULT_TARBALL_URL
    && parseSemver(latestVersion)
  ) {
    return buildTaggedTarballUrl(source.repository || DEFAULT_REPOSITORY, latestVersion.trim());
  }

  return source.tarballUrl;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function verifyFileSha256(filePath, expectedSha256, label = path.basename(filePath)) {
  if (!expectedSha256) {
    return;
  }

  const actualSha256 = sha256File(filePath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`SHA256 mismatch for ${label}. Expected ${expectedSha256}, got ${actualSha256}.`);
  }
}

function isRepoLocalDevelopmentBundle(bundleDir) {
  if (fs.existsSync(path.join(bundleDir, '.git'))) {
    return true;
  }

  const parentDir = path.basename(path.dirname(bundleDir));
  const grandparentDir = path.basename(path.dirname(path.dirname(bundleDir)));
  return parentDir === 'skill-bundles' && grandparentDir === 'dist';
}

function isLinkedBundle(bundleDir) {
  try {
    if (fs.lstatSync(bundleDir).isSymbolicLink()) {
      return true;
    }
  } catch {
    return false;
  }

  try {
    return fs.realpathSync(bundleDir) !== bundleDir;
  } catch {
    return false;
  }
}

function discoverPortableSelectedBundles(targetDir, bundleMetadata) {
  const selectedBundles = new Set([bundleMetadata.name]);
  if (!fs.existsSync(targetDir)) {
    return [...selectedBundles];
  }

  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const siblingMetadata = readJsonIfExists(path.join(targetDir, entry.name, 'bundle.json'));
    if (!siblingMetadata) {
      continue;
    }

    if ((siblingMetadata.familyName || DEFAULT_FAMILY_NAME) !== (bundleMetadata.familyName || DEFAULT_FAMILY_NAME)) {
      continue;
    }

    const siblingRepository = siblingMetadata.repository || DEFAULT_REPOSITORY;
    const bundleRepository = bundleMetadata.repository || DEFAULT_REPOSITORY;
    if (siblingRepository !== bundleRepository) {
      continue;
    }

    selectedBundles.add(siblingMetadata.name || entry.name);
  }

  return [...selectedBundles].sort();
}

function resolveInstallState(context) {
  const installedVersion = context.installMetadata?.installedVersion || context.bundleMetadata.familyVersion;

  if (context.installMetadata) {
    const autoUpdateEnabled = !!context.installMetadata.autoUpdateEnabled;
    return {
      autoUpdateEnabled,
      bundleName: context.bundleMetadata.name,
      installMode: context.installMetadata.installMode || (autoUpdateEnabled ? 'copy' : 'unknown'),
      installedVersion,
      reason: autoUpdateEnabled
        ? null
        : `Auto-update is disabled for install mode "${context.installMetadata.installMode || 'unknown'}".`,
      selectedBundles: context.installMetadata.selectedBundles || [context.bundleMetadata.name],
      targetDir: context.installMetadata.targetDir || path.dirname(context.bundleDir),
    };
  }

  if (isLinkedBundle(context.bundleDir) || isRepoLocalDevelopmentBundle(context.bundleDir)) {
    return {
      autoUpdateEnabled: false,
      bundleName: context.bundleMetadata.name,
      installMode: 'link',
      installedVersion,
      reason: 'Auto-update is disabled for linked or repo-local development bundles.',
      selectedBundles: [context.bundleMetadata.name],
      targetDir: path.dirname(context.bundleDir),
    };
  }

  const targetDir = path.dirname(context.bundleDir);
  return {
    autoUpdateEnabled: true,
    bundleName: context.bundleMetadata.name,
    installMode: 'portable',
    installedVersion,
    reason: null,
    selectedBundles: discoverPortableSelectedBundles(targetDir, context.bundleMetadata),
    targetDir,
  };
}

function shouldUseCache(state, installedVersion, force, ttlMs) {
  if (force || !state || state.installedVersion !== installedVersion) {
    return false;
  }

  if (typeof state.checkedAt !== 'string') {
    return false;
  }

  const checkedAt = Date.parse(state.checkedAt);
  if (Number.isNaN(checkedAt)) {
    return false;
  }

  return (Date.now() - checkedAt) < ttlMs;
}

function requestUrl(url, timeoutMs, redirectCount = 0) {
  if (redirectCount > 5) {
    return Promise.reject(new Error(`Too many redirects while fetching ${url}`));
  }

  const parsed = new URL(url);
  if (parsed.protocol === 'file:') {
    return Promise.resolve(fs.readFileSync(parsed, 'utf8'));
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Promise.reject(new Error(`Unsupported URL protocol: ${parsed.protocol}`));
  }

  const client = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(parsed, res => {
      const statusCode = res.statusCode ?? 0;
      const location = res.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location) {
        res.resume();
        resolve(requestUrl(new URL(location, parsed).toString(), timeoutMs, redirectCount + 1));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${statusCode} while fetching ${url}`));
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out after ${timeoutMs}ms while fetching ${url}`)));
    req.on('error', reject);
  });
}

function downloadFile(url, outputFile, timeoutMs, redirectCount = 0) {
  const parsed = new URL(url);
  if (parsed.protocol === 'file:') {
    ensureDir(path.dirname(outputFile));
    fs.copyFileSync(parsed, outputFile);
    return;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  if (redirectCount > 5) {
    throw new Error(`Too many redirects while downloading ${url}`);
  }

  const client = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.get(parsed, res => {
      const statusCode = res.statusCode ?? 0;
      const location = res.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location) {
        res.resume();
        resolve(downloadFile(new URL(location, parsed).toString(), outputFile, timeoutMs, redirectCount + 1));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${statusCode} while downloading ${url}`));
        return;
      }

      ensureDir(path.dirname(outputFile));
      const file = fs.createWriteStream(outputFile);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve());
      });
      file.on('error', error => reject(error));
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out after ${timeoutMs}ms while downloading ${url}`)));
    req.on('error', reject);
  });
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: options.stdio ?? 'pipe',
    env: options.env ?? process.env,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error([
      `Command failed: ${command} ${args.join(' ')}`,
      stdout ? `stdout: ${stdout}` : '',
      stderr ? `stderr: ${stderr}` : '',
    ].filter(Boolean).join('\n'));
  }

  return result;
}

async function checkForUpdates(metaUrl, options = {}) {
  const context = loadInstallContext(metaUrl);
  const installState = resolveInstallState(context);
  const installedVersion = installState.installedVersion;
  const ttlMs = Number.parseInt(
    options.ttlMs
      ?? process.env.EVENT_TRACKING_UPDATE_CACHE_TTL_MS
      ?? `${DEFAULT_CACHE_TTL_MS}`,
    10,
  );
  const effectiveTtlMs = Number.isFinite(ttlMs) ? ttlMs : DEFAULT_CACHE_TTL_MS;
  const force = !!options.force;
  const autoUpdateEnabled = installState.autoUpdateEnabled;
  const source = resolveUpdateSource(context.bundleMetadata, context.installMetadata);
  const previousState = readJsonIfExists(context.paths.updateStateFile);

  if (!autoUpdateEnabled) {
    return {
      status: 'disabled',
      autoUpdateEnabled,
      bundleName: context.bundleMetadata.name,
      installMode: installState.installMode,
      installedVersion,
      checkedAt: new Date().toISOString(),
      reason: installState.reason,
      selectedBundles: installState.selectedBundles,
      targetDir: installState.targetDir,
      updateCommand: null,
    };
  }

  if (shouldUseCache(previousState, installedVersion, force, effectiveTtlMs)) {
    return previousState;
  }

  try {
    validateUpdateUrl(source.versionUrl, 'version');
    const latestVersion = (await requestUrl(source.versionUrl, DEFAULT_TIMEOUT_MS)).trim();
    const pinnedTarballUrl = resolvePinnedTarballUrl(source, latestVersion);
    validateUpdateUrl(pinnedTarballUrl, 'tarball');
    const checkedAt = new Date().toISOString();
    const updateAvailable = compareVersions(installedVersion, latestVersion) < 0;
    const result = {
      status: updateAvailable ? 'update_available' : 'up_to_date',
      autoUpdateEnabled,
      bundleName: context.bundleMetadata.name,
      installMode: installState.installMode,
      installedVersion,
      latestVersion,
      checkedAt,
      selectedBundles: installState.selectedBundles,
      updateCommand: `node ${JSON.stringify(path.join(context.bundleDir, 'runtime', 'skill-runtime', 'self-update.mjs'))} --apply`,
      targetDir: installState.targetDir,
      updateSource: {
        ...source,
        tarballUrl: pinnedTarballUrl,
      },
    };
    writeJson(context.paths.updateStateFile, result);
    return result;
  } catch (error) {
    const result = {
      status: 'error',
      autoUpdateEnabled,
      bundleName: context.bundleMetadata.name,
      installMode: installState.installMode,
      installedVersion,
      checkedAt: new Date().toISOString(),
      reason: (error instanceof Error ? error.message : String(error)),
      selectedBundles: installState.selectedBundles,
      targetDir: installState.targetDir,
      updateCommand: null,
      updateSource: source,
    };
    writeJson(context.paths.updateStateFile, result);
    return result;
  }
}

export {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  compareVersions,
  downloadFile,
  ensureDir,
  DEFAULT_FAMILY_NAME,
  DEFAULT_REPOSITORY,
  getBundleDir,
  getCodexHome,
  getRuntimePaths,
  loadInstallContext,
  readJsonIfExists,
  resolveInstallState,
  requestUrl,
  resolveUpdateSource,
  resolvePinnedTarballUrl,
  runCommand,
  sha256File,
  shouldUseCache,
  verifyFileSha256,
  writeJson,
  checkForUpdates,
};
