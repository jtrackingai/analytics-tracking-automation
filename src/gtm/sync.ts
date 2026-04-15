import { GTMClient } from './client';
import { GTMContainerExport, GTMParameter, JTRACKING_PREFIX, stripManagedPrefix } from '../generator/gtm-config';
import { tagmanager_v2 } from 'googleapis';

export interface SyncResult {
  accountId: string;
  containerId: string;
  workspaceId: string;
  tagsCreated: number;
  tagsUpdated: number;
  tagsDeleted: number;
  triggersCreated: number;
  triggersUpdated: number;
  triggersDeleted: number;
  variablesCreated: number;
  variablesUpdated: number;
  variablesDeleted: number;
  errors: string[];
}

// Naming conventions used by this tool.
// Current entities are identified by the [JTracking] prefix.
// Legacy entities are matched once for migration and then renamed in-place.
const MANAGED_NAME_PREFIX = JTRACKING_PREFIX;
const LEGACY_MANAGED_TAG_PREFIX = 'GA4 - ';
const LEGACY_MANAGED_TRIGGER_PREFIX = 'Trigger - ';
const MANAGED_TAG_NOTE = 'managed-by-analytics-tracking-automation:tag';
const MANAGED_TRIGGER_NOTE = 'managed-by-analytics-tracking-automation:trigger';
const MANAGED_VARIABLE_NOTE = 'managed-by-analytics-tracking-automation';

type IdMap = Map<string, string>;

function isCurrentManagedName(name: string | undefined): boolean {
  return !!name && name.startsWith(MANAGED_NAME_PREFIX);
}

function isManagedTag(tag: tagmanager_v2.Schema$Tag | undefined): boolean {
  const name = tag?.name || '';
  return isCurrentManagedName(name) || tag?.notes === MANAGED_TAG_NOTE;
}

function isManagedTrigger(trigger: tagmanager_v2.Schema$Trigger | undefined): boolean {
  const name = trigger?.name || '';
  return isCurrentManagedName(name) || trigger?.notes === MANAGED_TRIGGER_NOTE;
}

function isLegacyManagedTag(tag: tagmanager_v2.Schema$Tag | undefined): boolean {
  const name = tag?.name || '';
  return !isManagedTag(tag) && name.startsWith(LEGACY_MANAGED_TAG_PREFIX);
}

function isLegacyManagedTrigger(trigger: tagmanager_v2.Schema$Trigger | undefined): boolean {
  const name = trigger?.name || '';
  return !isManagedTrigger(trigger) && name.startsWith(LEGACY_MANAGED_TRIGGER_PREFIX);
}

function isManagedVariable(variable: tagmanager_v2.Schema$Variable | undefined): boolean {
  const name = variable?.name || '';
  return isCurrentManagedName(name) || variable?.notes === MANAGED_VARIABLE_NOTE;
}

function findManagedTag(
  desiredName: string,
  existingTagByName: Map<string, tagmanager_v2.Schema$Tag>,
): tagmanager_v2.Schema$Tag | undefined {
  const exact = existingTagByName.get(desiredName);
  if (exact) return exact;
  const legacy = existingTagByName.get(stripManagedPrefix(desiredName));
  return isLegacyManagedTag(legacy) ? legacy : undefined;
}

function findManagedTrigger(
  desiredName: string,
  existingTriggerByName: Map<string, tagmanager_v2.Schema$Trigger>,
): tagmanager_v2.Schema$Trigger | undefined {
  const exact = existingTriggerByName.get(desiredName);
  if (exact) return exact;
  const legacy = existingTriggerByName.get(stripManagedPrefix(desiredName));
  return isLegacyManagedTrigger(legacy) ? legacy : undefined;
}

function findManagedVariable(
  desiredName: string,
  existingVarByName: Map<string, tagmanager_v2.Schema$Variable>,
): tagmanager_v2.Schema$Variable | undefined {
  const exact = existingVarByName.get(desiredName);
  if (exact) return exact;
  const legacy = existingVarByName.get(stripManagedPrefix(desiredName));
  return isManagedVariable(legacy) ? legacy : undefined;
}

function convertParameter(
  param: GTMParameter,
  triggerIdMap: IdMap
): tagmanager_v2.Schema$Parameter {
  const p: tagmanager_v2.Schema$Parameter = {
    type: param.type,
    key: param.key,
    value: param.value,
  };

  if (param.list) {
    p.list = param.list.map(item => convertParameter(item, triggerIdMap));
  }
  if (param.map) {
    p.map = param.map.map(item => convertParameter(item, triggerIdMap));
  }

  return p;
}

export interface DryRunPlan {
  variables: { create: string[]; update: string[]; delete: string[] };
  triggers:  { create: string[]; update: string[]; delete: string[] };
  tags:      { create: string[]; update: string[]; delete: string[] };
}

export async function dryRunSync(
  client: GTMClient,
  config: GTMContainerExport,
  accountId: string,
  containerId: string,
  workspaceId: string,
  clean = false
): Promise<DryRunPlan> {
  // Cleanup is always enabled. The --clean flag is retained for backward compatibility.
  void clean;

  const [existingTags, existingTriggers, existingVariables] = await Promise.all([
    client.listTags(accountId, containerId, workspaceId),
    client.listTriggers(accountId, containerId, workspaceId),
    client.listVariables(accountId, containerId, workspaceId),
  ]);

  const existingTagByName = new Map(existingTags.map(t => [t.name!, t]));
  const existingTriggerByName = new Map(existingTriggers.map(t => [t.name!, t]));
  const existingVarByName = new Map(existingVariables.map(v => [v.name!, v]));

  const { variable: desiredVars, trigger: desiredTriggers, tag: desiredTags } = config.containerVersion;

  const plan: DryRunPlan = {
    variables: { create: [], update: [], delete: [] },
    triggers:  { create: [], update: [], delete: [] },
    tags:      { create: [], update: [], delete: [] },
  };
  const matchedVarNames = new Set<string>();
  const matchedTriggerNames = new Set<string>();
  const matchedTagNames = new Set<string>();

  for (const v of desiredVars) {
    const existing = findManagedVariable(v.name, existingVarByName);
    (existing ? plan.variables.update : plan.variables.create).push(v.name);
    if (existing?.name) matchedVarNames.add(existing.name);
  }
  for (const t of desiredTriggers) {
    const existing = findManagedTrigger(t.name, existingTriggerByName);
    (existing ? plan.triggers.update : plan.triggers.create).push(t.name);
    if (existing?.name) matchedTriggerNames.add(existing.name);
  }
  for (const t of desiredTags) {
    const existing = findManagedTag(t.name, existingTagByName);
    (existing ? plan.tags.update : plan.tags.create).push(t.name);
    if (existing?.name) matchedTagNames.add(existing.name);
  }

  const desiredVarNames = new Set(desiredVars.map(v => v.name));
  const desiredTriggerNames = new Set(desiredTriggers.map(t => t.name));
  const desiredTagNames = new Set(desiredTags.map(t => t.name));

  for (const v of existingVariables) {
    const name = v.name!;
    if (
      isManagedVariable(v) &&
      !desiredVarNames.has(name) &&
      !matchedVarNames.has(name)
    ) {
      plan.variables.delete.push(name);
    }
  }
  for (const t of existingTriggers) {
    const name = t.name!;
    if (
      isManagedTrigger(t) &&
      !desiredTriggerNames.has(name) &&
      !matchedTriggerNames.has(name)
    ) {
      plan.triggers.delete.push(name);
    }
  }
  for (const t of existingTags) {
    const name = t.name!;
    if (
      isManagedTag(t) &&
      !desiredTagNames.has(name) &&
      !matchedTagNames.has(name)
    ) {
      plan.tags.delete.push(name);
    }
  }

  return plan;
}

export async function syncConfigToWorkspace(
  client: GTMClient,
  config: GTMContainerExport,
  accountId: string,
  containerId: string,
  workspaceId: string,
  clean = false
): Promise<SyncResult> {
  const result: SyncResult = {
    accountId, containerId, workspaceId,
    tagsCreated: 0, tagsUpdated: 0, tagsDeleted: 0,
    triggersCreated: 0, triggersUpdated: 0, triggersDeleted: 0,
    variablesCreated: 0, variablesUpdated: 0, variablesDeleted: 0,
    errors: [],
  };

  // ── Step 0: Enable required built-in variables ─────────────────────────────

  const builtIns = config.requiredBuiltInVariables ?? [
    'CLICK_ELEMENT', 'CLICK_CLASSES', 'CLICK_ID', 'CLICK_TARGET',
    'CLICK_URL', 'CLICK_TEXT', 'FORM_ELEMENT', 'FORM_CLASSES',
    'FORM_ID', 'FORM_TARGET', 'FORM_URL', 'FORM_TEXT',
    'PAGE_URL', 'PAGE_HOSTNAME', 'PAGE_PATH',
  ];

  if (builtIns.length > 0) {
    console.log('  Enabling built-in GTM variables...');
    await client.enableBuiltInVariables(accountId, containerId, workspaceId, builtIns);
  }

  // ── Step 1: Read existing workspace state ──────────────────────────────────

  console.log('  Reading existing workspace entities...');
  const [existingTags, existingTriggers, existingVariables] = await Promise.all([
    client.listTags(accountId, containerId, workspaceId),
    client.listTriggers(accountId, containerId, workspaceId),
    client.listVariables(accountId, containerId, workspaceId),
  ]);

  const existingTagByName = new Map(existingTags.map(t => [t.name!, t]));
  const existingTriggerByName = new Map(existingTriggers.map(t => [t.name!, t]));
  const existingVarByName = new Map(existingVariables.map(v => [v.name!, v]));

  const triggerIdMap: IdMap = new Map();
  const tagIdMap: IdMap = new Map();

  const { variable: desiredVars, trigger: desiredTriggers, tag: desiredTags } = config.containerVersion;

  // ── Step 2: Sync variables (create or update) ──────────────────────────────

  const desiredVarNames = new Set(desiredVars.map(v => v.name));
  const matchedVarNames = new Set<string>();

  console.log(`  Syncing ${desiredVars.length} variables...`);
  for (const variable of desiredVars) {
    const existing = findManagedVariable(variable.name, existingVarByName);
    if (existing?.name) matchedVarNames.add(existing.name);
    try {
      const varBody = {
        name: variable.name,
        type: variable.type,
        parameter: variable.parameter?.map(p => convertParameter(p, triggerIdMap)),
        notes: MANAGED_VARIABLE_NOTE,
      };
      if (existing?.variableId) {
        await client.updateVariable(accountId, containerId, workspaceId, existing.variableId, varBody);
        result.variablesUpdated++;
      } else {
        await client.createVariable(accountId, containerId, workspaceId, varBody);
        result.variablesCreated++;
      }
    } catch (err) {
      const msg = `Variable "${variable.name}": ${(err as Error).message}`;
      result.errors.push(msg);
      console.warn(`  ⚠️  ${msg}`);
    }
  }

  // Delete stale managed variables every sync.
  // Current managed variables are prefixed; legacy ones are recognized via the notes marker.
  for (const [name, existing] of existingVarByName) {
    if (
      !desiredVarNames.has(name) &&
      !matchedVarNames.has(name) &&
      existing.variableId &&
      isManagedVariable(existing)
    ) {
      try {
        await client.deleteVariable(accountId, containerId, workspaceId, existing.variableId);
        result.variablesDeleted++;
      } catch { /* ignore deletion failures */ }
    }
  }

  // ── Step 3: Sync triggers (create or update) ───────────────────────────────

  const desiredTriggerNames = new Set(desiredTriggers.map(t => t.name));
  const matchedTriggerNames = new Set<string>();

  console.log(`  Syncing ${desiredTriggers.length} triggers...`);
  for (const trigger of desiredTriggers) {
    const existing = findManagedTrigger(trigger.name, existingTriggerByName);
    if (existing?.name) matchedTriggerNames.add(existing.name);
    try {
      const triggerBody = {
        name: trigger.name,
        type: trigger.type,
        filter: trigger.filter as tagmanager_v2.Schema$Condition[],
        customEventFilter: trigger.customEventFilter as tagmanager_v2.Schema$Condition[],
        parameter: trigger.parameter?.map(p => convertParameter(p, triggerIdMap)),
        notes: MANAGED_TRIGGER_NOTE,
      };

      if (existing?.triggerId) {
        await client.updateTrigger(accountId, containerId, workspaceId, existing.triggerId, triggerBody);
        triggerIdMap.set(trigger.triggerId, existing.triggerId);
        result.triggersUpdated++;
      } else {
        const created = await client.createTrigger(accountId, containerId, workspaceId, triggerBody);
        triggerIdMap.set(trigger.triggerId, created.triggerId!);
        result.triggersCreated++;
      }
    } catch (err) {
      const msg = `Trigger "${trigger.name}": ${(err as Error).message}`;
      result.errors.push(msg);
      console.warn(`  ⚠️  ${msg}`);
    }
  }

  // Delete stale managed triggers every sync.
  for (const [name, existing] of existingTriggerByName) {
    if (
      !desiredTriggerNames.has(name) &&
      !matchedTriggerNames.has(name) &&
      existing.triggerId &&
      isManagedTrigger(existing)
    ) {
      try {
        await client.deleteTrigger(accountId, containerId, workspaceId, existing.triggerId);
        result.triggersDeleted++;
      } catch { /* ignore deletion failures */ }
    }
  }

  // ── Step 4: Sync tags ──────────────────────────────────────────────────────

  // Sync the GA4 Config tag first so the workspace always has its destination setup in place
  const configTag = desiredTags.find(t => t.type === 'gaawc');
  const eventTags = desiredTags.filter(t => t.type !== 'gaawc');
  const desiredTagNames = new Set(desiredTags.map(t => t.name));
  const matchedTagNames = new Set<string>();

  const measurementId = config.eventTrackingMetadata?.ga4MeasurementId
    || configTag?.parameter?.find(p => p.key === 'measurementId')?.value;

  if (configTag) {
    console.log('  Syncing GA4 Configuration tag...');
    const existing = findManagedTag(configTag.name, existingTagByName);
    if (existing?.name) matchedTagNames.add(existing.name);
    try {
      const firingTriggerIds = (configTag.firingTriggerId || [])
        .map(id => triggerIdMap.get(id))
        .filter((id): id is string => !!id);

      const tagBody = {
        name: configTag.name,
        type: configTag.type,
        parameter: configTag.parameter?.map(p => convertParameter(p, triggerIdMap)),
        firingTriggerId: firingTriggerIds,
        tagFiringOption: configTag.tagFiringOption || 'oncePerEvent',
        notes: MANAGED_TAG_NOTE,
      };

      if (existing?.tagId) {
        await client.updateTag(accountId, containerId, workspaceId, existing.tagId, tagBody);
        tagIdMap.set(configTag.tagId, existing.tagId);
        result.tagsUpdated++;
      } else {
        const created = await client.createTag(accountId, containerId, workspaceId, tagBody);
        tagIdMap.set(configTag.tagId, created.tagId!);
        result.tagsCreated++;
      }
    } catch (err) {
      const msg = `GA4 Config tag: ${(err as Error).message}`;
      result.errors.push(msg);
      console.warn(`  ⚠️  ${msg}`);
    }
  }

  // Sync event tags
  console.log(`  Syncing ${eventTags.length} event tags...`);
  for (const tag of eventTags) {
    const existing = findManagedTag(tag.name, existingTagByName);
    if (existing?.name) matchedTagNames.add(existing.name);
    try {
      const firingTriggerIds = (tag.firingTriggerId || [])
        .map(id => triggerIdMap.get(id))
        .filter((id): id is string => !!id);

      if (firingTriggerIds.length === 0 && (tag.firingTriggerId || []).length > 0) {
        const msg = `Skipped tag "${tag.name}": trigger IDs failed to map`;
        result.errors.push(msg);
        console.warn(`  ⚠️  ${msg}`);
        continue;
      }

      // New configs already encode measurementIdOverride directly.
      // Keep this fallback so older generated configs continue to sync cleanly.
      const remappedParams = tag.parameter?.map(p => {
        let normalizedParam = p;
        if (p.key === 'measurementIdOverride' && p.type === 'tagReference') {
          normalizedParam = { type: 'template', key: 'measurementIdOverride', value: measurementId || '' } as GTMParameter;
        } else if (p.type === 'tagReference' && p.value && tagIdMap.has(p.value)) {
          normalizedParam = { ...p, value: tagIdMap.get(p.value)! } as GTMParameter;
        }
        return convertParameter(normalizedParam, triggerIdMap);
      });

      const tagBody = {
        name: tag.name,
        type: tag.type,
        parameter: remappedParams,
        firingTriggerId: firingTriggerIds,
        tagFiringOption: tag.tagFiringOption || 'oncePerEvent',
        notes: MANAGED_TAG_NOTE,
      };

      if (existing?.tagId) {
        await client.updateTag(accountId, containerId, workspaceId, existing.tagId, tagBody);
        result.tagsUpdated++;
      } else {
        await client.createTag(accountId, containerId, workspaceId, tagBody);
        result.tagsCreated++;
      }
    } catch (err) {
      const msg = `Tag "${tag.name}": ${(err as Error).message}`;
      result.errors.push(msg);
      console.warn(`  ⚠️  ${msg}`);
    }
  }

  // Delete stale managed tags every sync.
  for (const [name, existing] of existingTagByName) {
    if (
      !desiredTagNames.has(name) &&
      !matchedTagNames.has(name) &&
      existing.tagId &&
      isManagedTag(existing)
    ) {
      try {
        await client.deleteTag(accountId, containerId, workspaceId, existing.tagId);
        result.tagsDeleted++;
      } catch { /* ignore deletion failures */ }
    }
  }

  return result;
}
