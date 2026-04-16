import { EventSchema } from '../generator/event-schema';
import { PreviewResult } from '../gtm/preview';
import { SchemaDiffResult } from './schema-diff';
import { TrackingHealthReport } from './tracking-health';
import { isIgnorableUnexpectedEventName } from '../gtm/preview';

export type UpkeepPreviewStatus = 'healthy' | 'failure' | 'drift' | 'not_observable';

export interface UpkeepPreviewEventAssessment {
  eventName: string;
  status: UpkeepPreviewStatus;
  reason: string;
}

export interface UpkeepPreviewAssessment {
  counts: Record<UpkeepPreviewStatus, number>;
  items: UpkeepPreviewEventAssessment[];
  summaryLines: string[];
}

export interface UpkeepNextStepRecommendation {
  trackingUpdateRequired: boolean;
  recommendationType: 'new_requests' | 'legacy_maintenance' | 'both' | 'none';
  reason: string;
}

function indexDiff(diff: SchemaDiffResult): {
  added: Set<string>;
  changed: Set<string>;
  removed: Set<string>;
} {
  return {
    added: new Set(diff.added.map(event => event.eventName)),
    changed: new Set(diff.changed.map(item => item.eventName)),
    removed: new Set(diff.removed.map(event => event.eventName)),
  };
}

function buildCounts(items: UpkeepPreviewEventAssessment[]): Record<UpkeepPreviewStatus, number> {
  return items.reduce<Record<UpkeepPreviewStatus, number>>((acc, item) => {
    acc[item.status] += 1;
    return acc;
  }, {
    healthy: 0,
    failure: 0,
    drift: 0,
    not_observable: 0,
  });
}

export function assessUpkeepPreview(args: {
  currentSchema: EventSchema;
  baselineSchema: EventSchema;
  diff: SchemaDiffResult;
  health: TrackingHealthReport | null;
  previewResult?: PreviewResult | null;
}): UpkeepPreviewAssessment {
  const diffIndex = indexDiff(args.diff);
  const items: UpkeepPreviewEventAssessment[] = [];

  const baselineEventNames = args.baselineSchema.events.map(event => event.eventName);
  const healthStatusMap = new Map((args.health?.eventStatus || []).map(item => [item.eventName, item]));

  for (const eventName of baselineEventNames) {
    if (!args.health) {
      items.push({
        eventName,
        status: 'not_observable',
        reason: 'No tracking-health baseline is available for this event in the current run.',
      });
      continue;
    }

    const status = healthStatusMap.get(eventName);
    if (!status) {
      items.push({
        eventName,
        status: 'not_observable',
        reason: 'The event was not observed in preview coverage.',
      });
      continue;
    }

    if (!status.fired) {
      if (status.failureCategory === 'requires_login' || status.failureCategory === 'requires_journey') {
        items.push({
          eventName,
          status: 'not_observable',
          reason: `Preview result is ${status.failureCategory}; manual verification is required.`,
        });
      } else {
        items.push({
          eventName,
          status: 'failure',
          reason: status.failureCategory
            ? `Event did not fire (${status.failureCategory}).`
            : 'Event did not fire.',
        });
      }
      continue;
    }

    if (diffIndex.changed.has(eventName) || diffIndex.removed.has(eventName)) {
      items.push({
        eventName,
        status: 'drift',
        reason: diffIndex.removed.has(eventName)
          ? 'Event fires in current tracking but is removed from the recommended schema.'
          : 'Event still fires but its recommended definition changed from historical schema.',
      });
      continue;
    }

    items.push({
      eventName,
      status: 'healthy',
      reason: 'Event fired and remained consistent with the recommended schema.',
    });
  }

  for (const event of args.currentSchema.events) {
    if (!diffIndex.added.has(event.eventName)) continue;
    items.push({
      eventName: event.eventName,
      status: 'not_observable',
      reason: 'New recommended event; no historical live baseline to validate yet.',
    });
  }

  const unexpectedNames = new Set<string>();
  for (const name of args.health?.unexpectedEventNames || []) {
    if (name && !isIgnorableUnexpectedEventName(name)) unexpectedNames.add(name);
  }
  for (const fired of args.previewResult?.unexpectedFiredEvents || []) {
    if (fired.eventName && !isIgnorableUnexpectedEventName(fired.eventName)) unexpectedNames.add(fired.eventName);
  }
  for (const unexpectedName of unexpectedNames) {
    items.push({
      eventName: unexpectedName,
      status: 'drift',
      reason: 'Unexpected event fired outside schema control.',
    });
  }

  items.sort((left, right) => left.eventName.localeCompare(right.eventName));
  const counts = buildCounts(items);
  const summaryLines = [
    `- healthy: ${counts.healthy}`,
    `- failure: ${counts.failure}`,
    `- drift: ${counts.drift}`,
    `- not_observable: ${counts.not_observable}`,
  ];

  return {
    counts,
    items,
    summaryLines,
  };
}

export function decideUpkeepNextStep(args: {
  diff: SchemaDiffResult;
  previewAssessment: UpkeepPreviewAssessment;
}): UpkeepNextStepRecommendation {
  const hasNewRequests = args.diff.added.length > 0;
  const hasLegacyMaintenance =
    args.diff.changed.length > 0
    || args.diff.removed.length > 0
    || args.previewAssessment.counts.failure > 0
    || args.previewAssessment.counts.drift > 0;

  if (hasNewRequests && hasLegacyMaintenance) {
    return {
      trackingUpdateRequired: true,
      recommendationType: 'both',
      reason: 'Schema introduces new requests while legacy tracking also shows drift/failures.',
    };
  }

  if (hasNewRequests) {
    return {
      trackingUpdateRequired: true,
      recommendationType: 'new_requests',
      reason: 'Schema delta is primarily net-new tracking requests.',
    };
  }

  if (hasLegacyMaintenance) {
    return {
      trackingUpdateRequired: true,
      recommendationType: 'legacy_maintenance',
      reason: 'Existing tracking needs maintenance due to drift/failures or schema edits/removals.',
    };
  }

  return {
    trackingUpdateRequired: false,
    recommendationType: 'none',
    reason: 'No meaningful schema delta and no blocking preview drift/failures were found.',
  };
}
