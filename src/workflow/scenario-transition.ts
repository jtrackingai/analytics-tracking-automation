import * as fs from 'fs';
import * as path from 'path';

import { WorkflowScenario, WorkflowSubScenario } from './state';

export const SCENARIO_TRANSITIONS_FILE = 'scenario-transitions.jsonl';

export interface ScenarioTransitionEntry {
  schemaVersion: 1;
  transitionedAt: string;
  artifactDir: string;
  fromScenario: WorkflowScenario;
  fromSubScenario: WorkflowSubScenario;
  fromRunId: string;
  toScenario: WorkflowScenario;
  toSubScenario: WorkflowSubScenario;
  toRunId: string;
  reason?: string;
}

export function appendScenarioTransition(args: {
  artifactDir: string;
  fromScenario: WorkflowScenario;
  fromSubScenario: WorkflowSubScenario;
  fromRunId: string;
  toScenario: WorkflowScenario;
  toSubScenario: WorkflowSubScenario;
  toRunId: string;
  reason?: string;
}): { file: string; entry: ScenarioTransitionEntry } {
  const artifactDir = path.resolve(args.artifactDir);
  const file = path.join(artifactDir, SCENARIO_TRANSITIONS_FILE);
  const entry: ScenarioTransitionEntry = {
    schemaVersion: 1,
    transitionedAt: new Date().toISOString(),
    artifactDir,
    fromScenario: args.fromScenario,
    fromSubScenario: args.fromSubScenario,
    fromRunId: args.fromRunId,
    toScenario: args.toScenario,
    toSubScenario: args.toSubScenario,
    toRunId: args.toRunId,
    reason: args.reason,
  };

  fs.mkdirSync(artifactDir, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return { file, entry };
}

