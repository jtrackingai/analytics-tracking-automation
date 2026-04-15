import * as fs from 'fs';
import * as path from 'path';

import { WorkflowMode, WorkflowSubMode } from './state';

export const MODE_TRANSITIONS_FILE = 'mode-transitions.jsonl';

export interface ModeTransitionEntry {
  schemaVersion: 1;
  transitionedAt: string;
  artifactDir: string;
  fromMode: WorkflowMode;
  fromSubMode: WorkflowSubMode;
  fromRunId: string;
  toMode: WorkflowMode;
  toSubMode: WorkflowSubMode;
  toRunId: string;
  reason?: string;
}

export interface AppendModeTransitionArgs {
  artifactDir: string;
  fromMode: WorkflowMode;
  fromSubMode: WorkflowSubMode;
  fromRunId: string;
  toMode: WorkflowMode;
  toSubMode: WorkflowSubMode;
  toRunId: string;
  reason?: string;
}

export function appendModeTransition(args: AppendModeTransitionArgs): { file: string; entry: ModeTransitionEntry } {
  const artifactDir = path.resolve(args.artifactDir);
  const modeFile = path.join(artifactDir, MODE_TRANSITIONS_FILE);
  const entry: ModeTransitionEntry = {
    schemaVersion: 1,
    transitionedAt: new Date().toISOString(),
    artifactDir,
    fromMode: args.fromMode,
    fromSubMode: args.fromSubMode,
    fromRunId: args.fromRunId,
    toMode: args.toMode,
    toSubMode: args.toSubMode,
    toRunId: args.toRunId,
    reason: args.reason,
  };

  fs.mkdirSync(artifactDir, { recursive: true });
  const serialized = `${JSON.stringify(entry)}\n`;
  fs.appendFileSync(modeFile, serialized);
  return { file: modeFile, entry };
}
