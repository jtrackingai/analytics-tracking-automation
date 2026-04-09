import requirements from './scenario-requirements.json';
import { WorkflowScenario } from './state';

export type ScenarioArtifactCheckKey =
  | 'siteAnalysis'
  | 'liveGtmAnalysis'
  | 'eventSchema'
  | 'gtmConfig'
  | 'gtmContext'
  | 'trackingHealth';

export type ScenarioRequirements = Record<WorkflowScenario, ScenarioArtifactCheckKey[]>;

function toKeyArray(values: unknown): ScenarioArtifactCheckKey[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is ScenarioArtifactCheckKey =>
    value === 'siteAnalysis'
    || value === 'liveGtmAnalysis'
    || value === 'eventSchema'
    || value === 'gtmConfig'
    || value === 'gtmContext'
    || value === 'trackingHealth',
  );
}

function buildRequirements(): ScenarioRequirements {
  const source = requirements as Partial<Record<WorkflowScenario, unknown>>;
  return {
    legacy: toKeyArray(source.legacy),
    new_setup: toKeyArray(source.new_setup),
    tracking_update: toKeyArray(source.tracking_update),
    upkeep: toKeyArray(source.upkeep),
    tracking_health_audit: toKeyArray(source.tracking_health_audit),
  };
}

const SCENARIO_REQUIREMENTS = buildRequirements();

export function getRequiredArtifactsForScenario(scenario: WorkflowScenario): ScenarioArtifactCheckKey[] {
  return SCENARIO_REQUIREMENTS[scenario];
}

