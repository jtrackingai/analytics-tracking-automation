import { EventSchema, GA4Event, isRedundantAutoEvent } from './event-schema';

export interface ValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

// GA4 free-tier limits
const GA4_CUSTOM_DIMENSION_LIMIT = 50;
const GA4_CUSTOM_DIMENSION_WARN_THRESHOLD = 40; // warn when approaching limit
const GA4_CUSTOM_EVENT_LIMIT = 500;
const GA4_CUSTOM_EVENT_WARN_THRESHOLD = 400; // warn when approaching limit

// Parameters that GA4 collects automatically — not counted as custom dimensions
const GA4_AUTO_PARAMS = new Set([
  'page_location', 'page_referrer', 'page_title', 'language',
  'screen_resolution', 'source', 'medium', 'campaign',
  'link_text', 'link_url', 'link_classes', 'link_domain',
  'outbound', 'file_name', 'file_extension',
  'video_current_time', 'video_duration', 'video_percent', 'video_provider',
  'video_title', 'video_url', 'visible',
  'percent_scrolled', 'search_term',
  // Standard GA4 ecommerce parameters
  'currency', 'value', 'items', 'transaction_id',
  'shipping', 'tax', 'coupon',
  'payment_type', 'shipping_tier',
  'item_list_id', 'item_list_name',
]);

const VALID_TRIGGER_TYPES = new Set([
  'page_view', 'click', 'form_submit', 'scroll', 'video', 'custom',
]);

// GA4 reserved event names that must not be redefined
const GA4_RESERVED_EVENTS = new Set([
  'page_view', 'session_start', 'first_visit', 'user_engagement',
  'scroll', 'click', 'file_download', 'form_start', 'form_submit',
  'video_start', 'video_progress', 'video_complete',
]);

/**
 * Validates an event-schema.json structure before it's passed to generate-gtm.
 * Returns an array of validation errors/warnings. Empty array = valid.
 */
export function validateEventSchema(schema: EventSchema): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!schema.siteUrl) {
    errors.push({ field: 'siteUrl', message: 'Missing siteUrl', severity: 'error' });
  }

  if (!schema.generatedAt) {
    errors.push({ field: 'generatedAt', message: 'Missing generatedAt timestamp', severity: 'error' });
  }

  if (!Array.isArray(schema.events) || schema.events.length === 0) {
    errors.push({ field: 'events', message: 'events array is empty or missing', severity: 'error' });
    return errors;
  }

  const nameCount = new Map<string, number>();
  for (const event of schema.events) {
    nameCount.set(event.eventName, (nameCount.get(event.eventName) || 0) + 1);
  }

  schema.events.forEach((event, idx) => {
    const prefix = `events[${idx}]`;

    if (!event.eventName) {
      errors.push({ field: `${prefix}.eventName`, message: 'Missing eventName', severity: 'error' });
    } else if (!/^[a-z][a-z0-9_]*$/.test(event.eventName)) {
      errors.push({
        field: `${prefix}.eventName`,
        message: `"${event.eventName}" is not valid snake_case (must start with lowercase letter, only a-z 0-9 _)`,
        severity: 'error',
      });
    } else if (event.eventName.length > 40) {
      errors.push({
        field: `${prefix}.eventName`,
        message: `"${event.eventName}" exceeds GA4 40-char limit (${event.eventName.length} chars)`,
        severity: 'error',
      });
    }

    if (event.eventName && nameCount.get(event.eventName)! > 1) {
      errors.push({
        field: `${prefix}.eventName`,
        message: `Duplicate eventName "${event.eventName}" — each event must have a unique name`,
        severity: 'error',
      });
    }

    if (!VALID_TRIGGER_TYPES.has(event.triggerType)) {
      errors.push({
        field: `${prefix}.triggerType`,
        message: `Invalid triggerType "${event.triggerType}" — must be one of: ${[...VALID_TRIGGER_TYPES].join(', ')}`,
        severity: 'error',
      });
    }

    if (isRedundantAutoEvent(event)) {
      errors.push({
        field: `${prefix}.eventName`,
        message: `Event "${event.eventName}" is auto-collected and should usually be omitted from the schema`,
        severity: 'warning',
      });
    }

    if ((event.triggerType === 'click' || event.triggerType === 'form_submit') && !event.elementSelector) {
      errors.push({
        field: `${prefix}.elementSelector`,
        message: `${event.triggerType} event "${event.eventName}" is missing elementSelector`,
        severity: 'error',
      });
    }

    if (!Array.isArray(event.parameters)) {
      errors.push({
        field: `${prefix}.parameters`,
        message: 'parameters must be an array',
        severity: 'error',
      });
    } else {
      const hasPageLocation = event.parameters.some(p => p.name === 'page_location');
      if (!hasPageLocation) {
        errors.push({
          field: `${prefix}.parameters`,
          message: `Event "${event.eventName}" is missing page_location parameter`,
          severity: 'warning',
        });
      }

      for (const param of event.parameters) {
        if (!param.name || !param.value) {
          errors.push({
            field: `${prefix}.parameters`,
            message: `Parameter missing name or value in event "${event.eventName}"`,
            severity: 'error',
          });
        }
      }
    }

    if (!event.priority || !['high', 'medium', 'low'].includes(event.priority)) {
      errors.push({
        field: `${prefix}.priority`,
        message: `Invalid or missing priority "${event.priority}" in event "${event.eventName}"`,
        severity: 'warning',
      });
    }
  });

  // Deduplicate: only report duplicate eventName once
  const reportedDupes = new Set<string>();
  const deduped = errors.filter(e => {
    if (e.message.startsWith('Duplicate eventName')) {
      const name = e.message.match(/"([^"]+)"/)?.[1] || '';
      if (reportedDupes.has(name)) return false;
      reportedDupes.add(name);
    }
    return true;
  });
  errors.length = 0;
  errors.push(...deduped);

  // ── GA4 Quota Checks ──────────────────────────────────────────────────────

  // Count custom events (exclude page_view and scroll which are auto-collected)
  const customEventNames = schema.events
    .map(e => e.eventName)
    .filter(name => !GA4_RESERVED_EVENTS.has(name));

  if (customEventNames.length > GA4_CUSTOM_EVENT_LIMIT) {
    errors.push({
      field: 'events',
      message: `Schema defines ${customEventNames.length} custom events, exceeding GA4 free-tier limit of ${GA4_CUSTOM_EVENT_LIMIT}`,
      severity: 'error',
    });
  } else if (customEventNames.length > GA4_CUSTOM_EVENT_WARN_THRESHOLD) {
    errors.push({
      field: 'events',
      message: `Schema defines ${customEventNames.length} custom events — approaching GA4 free-tier limit of ${GA4_CUSTOM_EVENT_LIMIT}`,
      severity: 'warning',
    });
  }

  // Count unique custom dimensions (parameters that need to be registered in GA4)
  const customDimensions = new Set<string>();
  for (const event of schema.events) {
    for (const param of event.parameters || []) {
      if (param.name && !GA4_AUTO_PARAMS.has(param.name)) {
        customDimensions.add(param.name);
      }
    }
  }

  if (customDimensions.size > GA4_CUSTOM_DIMENSION_LIMIT) {
    errors.push({
      field: 'events',
      message: `Schema requires ${customDimensions.size} custom dimensions, exceeding GA4 free-tier limit of ${GA4_CUSTOM_DIMENSION_LIMIT}. Consider reducing parameters or upgrading to GA4 360.`,
      severity: 'error',
    });
  } else if (customDimensions.size > GA4_CUSTOM_DIMENSION_WARN_THRESHOLD) {
    errors.push({
      field: 'events',
      message: `Schema requires ${customDimensions.size} custom dimensions — approaching GA4 free-tier limit of ${GA4_CUSTOM_DIMENSION_LIMIT}`,
      severity: 'warning',
    });
  }

  return errors;
}

/**
 * Returns a summary of GA4 quota usage for display to the user.
 */
export function getQuotaSummary(schema: EventSchema): {
  customEvents: number;
  customEventLimit: number;
  customDimensions: number;
  customDimensionLimit: number;
  customDimensionNames: string[];
} {
  const customEvents = schema.events
    .filter(e => !GA4_RESERVED_EVENTS.has(e.eventName))
    .length;

  const customDimensionSet = new Set<string>();
  for (const event of schema.events) {
    for (const param of event.parameters || []) {
      if (param.name && !GA4_AUTO_PARAMS.has(param.name)) {
        customDimensionSet.add(param.name);
      }
    }
  }

  return {
    customEvents,
    customEventLimit: GA4_CUSTOM_EVENT_LIMIT,
    customDimensions: customDimensionSet.size,
    customDimensionLimit: GA4_CUSTOM_DIMENSION_LIMIT,
    customDimensionNames: [...customDimensionSet].sort(),
  };
}
