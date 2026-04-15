import * as fs from 'fs';
import * as path from 'path';

import { WorkflowMode, WorkflowState, WorkflowSubMode } from './state';

export const RUN_INDEX_FILE = '.event-tracking-runs.jsonl';
export const RUN_CONTEXT_FILE = '.event-tracking-run.json';
const MAX_RUN_INDEX_ENTRIES = 200;

export interface RunContext {
  schemaVersion: 1;
  createdAt: string;
  artifactDir: string;
  outputRoot: string;
  siteUrl?: string;
  activeRunId?: string;
  activeRunStartedAt?: string;
  mode?: WorkflowMode;
  subMode?: WorkflowSubMode;
  inputScope?: string;
}

export interface RunIndexEntry {
  schemaVersion: 1;
  updatedAt: string;
  outputRoot: string;
  artifactDir: string;
  siteUrl?: string;
  platformType?: string;
  currentCheckpoint: WorkflowState['currentCheckpoint'];
  completedCheckpoints: WorkflowState['completedCheckpoints'];
  nextAction: string;
  nextCommand?: string;
  runId: string;
  mode: WorkflowMode;
  subMode: WorkflowSubMode;
}

function getRunIndexFile(outputRoot: string): string {
  return path.join(outputRoot, RUN_INDEX_FILE);
}

function getRunContextFile(artifactDir: string): string {
  return path.join(artifactDir, RUN_CONTEXT_FILE);
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];

  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

function writeJsonl<T>(file: string, entries: T[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
}

function isWithinOutputRoot(artifactDir: string, outputRoot: string): boolean {
  const relative = path.relative(outputRoot, artifactDir);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function readRunContext(artifactDir: string): RunContext | null {
  const resolvedArtifactDir = path.resolve(artifactDir);
  const file = getRunContextFile(resolvedArtifactDir);
  if (!fs.existsSync(file)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RunContext;
    if (parsed.schemaVersion !== 1 || !parsed.outputRoot) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function upsertRunContext(args: {
  artifactDir: string;
  outputRoot?: string;
  siteUrl?: string;
  runId?: string;
  runStartedAt?: string;
  mode?: WorkflowMode;
  subMode?: WorkflowSubMode;
  inputScope?: string;
}): RunContext {
  const artifactDir = path.resolve(args.artifactDir);
  const existing = readRunContext(artifactDir);
  let outputRoot = args.outputRoot?.trim()
    ? path.resolve(args.outputRoot)
    : existing?.outputRoot;

  if (!outputRoot || !isWithinOutputRoot(artifactDir, outputRoot)) {
    outputRoot = path.dirname(artifactDir);
  }

  const context: RunContext = {
    schemaVersion: 1,
    createdAt: existing?.createdAt || new Date().toISOString(),
    artifactDir,
    outputRoot,
    siteUrl: args.siteUrl || existing?.siteUrl,
    activeRunId: args.runId || existing?.activeRunId,
    activeRunStartedAt: args.runStartedAt || existing?.activeRunStartedAt,
    mode: args.mode || existing?.mode,
    subMode: args.subMode || existing?.subMode,
    inputScope: typeof args.inputScope === 'string' ? args.inputScope : existing?.inputScope,
  };

  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(getRunContextFile(artifactDir), `${JSON.stringify(context, null, 2)}\n`);
  return context;
}

export function resolveOutputRootForArtifact(artifactDir: string): string {
  return upsertRunContext({ artifactDir }).outputRoot;
}

export function readRunIndex(outputRoot: string): RunIndexEntry[] {
  const resolvedRoot = path.resolve(outputRoot);
  const indexFile = getRunIndexFile(resolvedRoot);
  return readJsonl<RunIndexEntry>(indexFile)
    .filter(entry => entry.schemaVersion === 1 && !!entry.artifactDir)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function updateRunIndexFromState(state: WorkflowState): RunIndexEntry {
  const artifactDir = path.resolve(state.artifactDir);
  const outputRoot = upsertRunContext({
    artifactDir,
    siteUrl: state.siteUrl,
    runId: state.runId,
    runStartedAt: state.runStartedAt,
    mode: state.mode,
    subMode: state.subMode,
    inputScope: state.inputScope,
  }).outputRoot;
  const indexFile = getRunIndexFile(outputRoot);
  const entry: RunIndexEntry = {
    schemaVersion: 1,
    updatedAt: state.updatedAt,
    outputRoot,
    artifactDir,
    siteUrl: state.siteUrl,
    platformType: state.platformType,
    currentCheckpoint: state.currentCheckpoint,
    completedCheckpoints: state.completedCheckpoints,
    nextAction: state.nextAction,
    nextCommand: state.nextCommand,
    runId: state.runId,
    mode: state.mode,
    subMode: state.subMode,
  };

  const priorEntries = readJsonl<RunIndexEntry>(indexFile)
    .filter(existing => path.resolve(existing.artifactDir || '') !== artifactDir);
  const nextEntries = [entry, ...priorEntries]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_RUN_INDEX_ENTRIES);

  writeJsonl(indexFile, nextEntries);
  return entry;
}
