import requirements from './mode-requirements.json';
import { WorkflowMode } from './state';

export type WorkflowArtifactCheckKey =
  | 'siteAnalysis'
  | 'liveGtmAnalysis'
  | 'eventSchema'
  | 'gtmConfig'
  | 'gtmContext'
  | 'trackingHealth';

export type ModeRequirements = Record<WorkflowMode, WorkflowArtifactCheckKey[]>;

function toKeyArray(values: unknown): WorkflowArtifactCheckKey[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is WorkflowArtifactCheckKey =>
    value === 'siteAnalysis'
    || value === 'liveGtmAnalysis'
    || value === 'eventSchema'
    || value === 'gtmConfig'
    || value === 'gtmContext'
    || value === 'trackingHealth',
  );
}

function buildRequirements(): ModeRequirements {
  const source = requirements as Partial<Record<WorkflowMode, unknown>>;
  return {
    legacy: toKeyArray(source.legacy),
    new_setup: toKeyArray(source.new_setup),
    tracking_update: toKeyArray(source.tracking_update),
    upkeep: toKeyArray(source.upkeep),
    tracking_health_audit: toKeyArray(source.tracking_health_audit),
  };
}

const MODE_REQUIREMENTS = buildRequirements();

export function getRequiredArtifactsForMode(mode: WorkflowMode): WorkflowArtifactCheckKey[] {
  return MODE_REQUIREMENTS[mode];
}
