import * as fs from 'fs';
import * as path from 'path';

import { RunContext, readRunContext, upsertRunContext } from './run-index';
import { WorkflowMode, WorkflowSubMode } from './state';

export const VERSIONS_DIR = 'versions';
export const RUN_MANIFEST_FILE = 'run-manifest.json';

export interface RunManifestFileRecord {
  path: string;
  snapshottedAt: string;
  sizeBytes: number;
  stage?: string;
}

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  mode: WorkflowMode;
  subMode: WorkflowSubMode;
  runStartedAt: string;
  updatedAt: string;
  artifactDir: string;
  siteUrl?: string;
  inputScope?: string;
  files: RunManifestFileRecord[];
}

function sanitizeTimestamp(value: string): string {
  return value.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function createRunId(now = new Date()): string {
  return `${sanitizeTimestamp(now.toISOString())}-${randomSuffix()}`;
}

function resolveManifestFile(artifactDir: string, runId: string): string {
  return path.join(path.resolve(artifactDir), VERSIONS_DIR, runId, RUN_MANIFEST_FILE);
}

function readManifest(file: string): RunManifest | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RunManifest;
  } catch {
    return null;
  }
}

function writeManifest(file: string, manifest: RunManifest): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function updateManifest(args: {
  artifactDir: string;
  runContext: RunContext;
  fileRecord?: RunManifestFileRecord;
}): string {
  const artifactDir = path.resolve(args.artifactDir);
  const runId = args.runContext.activeRunId;
  const runStartedAt = args.runContext.activeRunStartedAt;
  if (!runId || !runStartedAt) {
    throw new Error('Active run context is missing run ID metadata.');
  }

  const manifestFile = resolveManifestFile(artifactDir, runId);
  const existing = readManifest(manifestFile);
  const files = existing?.files || [];
  if (args.fileRecord) {
    const withoutCurrent = files.filter(record => record.path !== args.fileRecord!.path);
    withoutCurrent.push(args.fileRecord);
    withoutCurrent.sort((left, right) => left.path.localeCompare(right.path));
    files.splice(0, files.length, ...withoutCurrent);
  }

  const manifest: RunManifest = {
    schemaVersion: 1,
    runId,
    mode: args.runContext.mode || 'legacy',
    subMode: args.runContext.subMode || 'none',
    runStartedAt,
    updatedAt: new Date().toISOString(),
    artifactDir,
    siteUrl: args.runContext.siteUrl,
    inputScope: args.runContext.inputScope,
    files,
  };
  writeManifest(manifestFile, manifest);
  return manifestFile;
}

export function ensureActiveRunContext(args: {
  artifactDir: string;
  outputRoot?: string;
  siteUrl?: string;
  mode?: WorkflowMode;
  subMode?: WorkflowSubMode;
  inputScope?: string;
  forceNewRun?: boolean;
}): RunContext {
  const artifactDir = path.resolve(args.artifactDir);
  const existing = readRunContext(artifactDir);
  const shouldCreateNewRun = !!args.forceNewRun || !existing?.activeRunId || !existing?.activeRunStartedAt;
  const runStartedAt = shouldCreateNewRun
    ? new Date().toISOString()
    : (existing?.activeRunStartedAt as string);
  const runId = shouldCreateNewRun
    ? createRunId(new Date(runStartedAt))
    : (existing?.activeRunId as string);

  const context = upsertRunContext({
    artifactDir,
    outputRoot: args.outputRoot,
    siteUrl: args.siteUrl,
    mode: args.mode,
    subMode: args.subMode,
    runId,
    runStartedAt,
    inputScope: args.inputScope,
  });

  updateManifest({
    artifactDir,
    runContext: context,
  });

  return context;
}

export function snapshotArtifactFile(args: {
  artifactDir: string;
  file: string;
  stage?: string;
}): string | null {
  const artifactDir = path.resolve(args.artifactDir);
  const sourceFile = path.resolve(args.file);
  if (!fs.existsSync(sourceFile)) return null;
  if (!fs.statSync(sourceFile).isFile()) return null;

  const relativePath = path.relative(artifactDir, sourceFile);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;

  const runContext = ensureActiveRunContext({ artifactDir });
  if (!runContext.activeRunId) return null;

  const targetFile = path.join(artifactDir, VERSIONS_DIR, runContext.activeRunId, relativePath);
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.copyFileSync(sourceFile, targetFile);

  const stats = fs.statSync(sourceFile);
  updateManifest({
    artifactDir,
    runContext,
    fileRecord: {
      path: relativePath,
      snapshottedAt: new Date().toISOString(),
      sizeBytes: stats.size,
      stage: args.stage,
    },
  });

  return targetFile;
}
