export interface GA4Parameter {
  name: string;
  value: string; // Can be a literal value or a JS expression like "{{Click Text}}"
  description: string;
}

export interface GA4Event {
  eventName: string;          // GA4 event name (snake_case)
  description: string;        // What this event tracks
  triggerType: 'page_view' | 'click' | 'form_submit' | 'scroll' | 'video' | 'custom';
  elementSelector?: string;   // CSS selector or GTM variable reference
  pageUrlPattern?: string;    // URL pattern to match (regex)
  parameters: GA4Parameter[]; // GA4 event parameters
  priority: 'high' | 'medium' | 'low';
  notes?: string;             // Special considerations
}

export const REDUNDANT_AUTO_EVENT_NAMES = new Set([
  'page_view',
  'scroll',
]);

export function isRedundantAutoEvent(event: Pick<GA4Event, 'eventName'>): boolean {
  return REDUNDANT_AUTO_EVENT_NAMES.has(event.eventName);
}

export interface EventSchema {
  siteUrl: string;
  generatedAt: string;
  events: GA4Event[];
  measurementId?: string;     // GA4 Measurement ID / destination ID (G-XXXXXXXXXX)
  googleTagId?: string;       // Optional Google tag ID (GT-/G-/AW-...), used for the configuration tag when provided
}
