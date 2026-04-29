import { EventSchema, GA4Event, isRedundantAutoEvent } from './event-schema';

// GTM container export format interfaces
export interface GTMVariable {
  accountId: string;
  containerId: string;
  variableId: string;
  name: string;
  type: string; // 'v' = DataLayer, 'k' = 1st party cookie, 'e' = element, etc.
  parameter?: GTMParameter[];
  fingerprint?: string;
}

export interface GTMTrigger {
  accountId: string;
  containerId: string;
  triggerId: string;
  name: string;
  type: string;
  eventName?: GTMParameter;
  customEventFilter?: GTMCondition[];
  filter?: GTMCondition[];
  parameter?: GTMParameter[];
  fingerprint?: string;
}

export interface GTMTag {
  accountId: string;
  containerId: string;
  tagId: string;
  name: string;
  type: string; // 'gaawe' = GA4 Event, 'gaawc' = GA4 Config, 'html' = Custom HTML
  parameter?: GTMParameter[];
  firingTriggerId?: string[];
  blockingTriggerId?: string[];
  tagFiringOption?: string;
  fingerprint?: string;
}

export interface GTMParameter {
  type: 'template' | 'boolean' | 'integer' | 'list' | 'map' | 'tagReference' | 'triggerReference';
  key?: string;
  value?: string;
  list?: GTMParameter[];
  map?: GTMParameter[];
}

export interface GTMCondition {
  type: string;
  parameter: GTMParameter[];
}

export interface GTMContainerExport {
  exportFormatVersion: number;
  exportTime: string;
  eventTrackingMetadata?: EventTrackingMetadata;
  requiredBuiltInVariables: string[];  // GTM built-in variable type enums to enable
  containerVersion: {
    path?: string;
    accountId: string;
    containerId: string;
    containerVersionId: string;
    name: string;
    description: string;
    container: {
      path?: string;
      accountId: string;
      containerId: string;
      name: string;
      publicId?: string;
      usageContext: string[];
    };
    variable: GTMVariable[];
    trigger: GTMTrigger[];
    tag: GTMTag[];
  };
}

export interface GTMTrackingIds {
  measurementId: string;
  googleTagId?: string;
}

export interface EventTrackingMetadata {
  ga4MeasurementId: string;
  googleTagId?: string;
  configTagTargetId: string;
  syncMode: 'measurement_id_only' | 'google_tag_for_config_tag';
  notes?: string[];
}

export const JTRACKING_PREFIX = '[JTracking] ';

export function toManagedName(name: string): string {
  return name.startsWith(JTRACKING_PREFIX) ? name : `${JTRACKING_PREFIX}${name}`;
}

export function stripManagedPrefix(name: string): string {
  return name.startsWith(JTRACKING_PREFIX) ? name.slice(JTRACKING_PREFIX.length) : name;
}

let idCounter = 100;
function nextId(): string {
  return String(idCounter++);
}

// Parse a urlPattern into zero or more plain URL path substrings for `contains` filtering.
// Regex alternations like \/(pricing|how-it-works) → ['/pricing', '/how-it-works']
// Simple path like \/blog → ['/blog']
// Empty / all-pages → []
function parseUrlPatternToPaths(pattern: string | undefined): string[] {
  if (!pattern) return [];

  // Unescape: \/ → /
  const unescaped = pattern.replace(/\\\//g, '/');

  // Alternation: /(a|b|c) → ['/a', '/b', '/c']
  const altMatch = unescaped.match(/^\/\(([^)]+)\)$/);
  if (altMatch) {
    return altMatch[1].split('|').map(p => `/${p}`);
  }

  // Single path: /blog → ['/blog']
  return [unescaped];
}

// Build GTM filter conditions for URL scoping.
// Returns undefined when no URL filter is needed, or when the pattern is multi-path
// (in that case element selector is enough to scope the event).
function makeUrlFilterConditions(
  pageUrlPattern: string | undefined,
  urlVariable: string,
): GTMCondition[] | undefined {
  const paths = parseUrlPatternToPaths(pageUrlPattern);
  if (paths.length === 0) return undefined;   // all pages — no filter
  // Single or multi-path: use matchRegex with alternation pattern
  const regexValue = paths.map(p => p.replace(/\//g, '\\/')).join('|');
  return [{
    type: 'matchRegex',
    parameter: [
      { type: 'template', key: 'arg0', value: urlVariable },
      { type: 'template', key: 'arg1', value: regexValue },
    ],
  }];
}

function splitSelectorList(selector: string): string[] {
  return selector.split(',').map(part => part.trim()).filter(Boolean);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSelectorTextToRegex(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return escapeRegexLiteral(trimmed).replace(/\s+/g, '\\s+');
}

function escapeJsStringLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function extractContainsText(selectorPart: string): { selector: string; textMatches: string[] } {
  const textMatches = Array.from(selectorPart.matchAll(/:contains\((["'])(.*?)\1\)/g))
    .map(match => match[2]?.trim())
    .filter((value): value is string => !!value);
  const selector = selectorPart.replace(/:contains\((["'])(.*?)\1\)/g, '').trim();
  return { selector, textMatches };
}

type CustomListenerMode = 'click' | 'submit';

function isFormSelector(selector: string): boolean {
  return /^form(?=[.#:\[\s]|$)/i.test(selector.trim());
}

function inferCustomListenerMode(event: GA4Event): CustomListenerMode {
  const selectors = splitSelectorList(event.elementSelector || '')
    .map(extractContainsText)
    .map(part => part.selector.trim())
    .filter(Boolean);

  if (selectors.length > 0 && selectors.every(isFormSelector)) {
    return 'submit';
  }

  return 'click';
}

function buildCustomListenerHtml(event: GA4Event): string {
  const parsedParts = splitSelectorList(event.elementSelector || '').map(extractContainsText);
  const selectors = parsedParts
    .map(part => ({ selector: part.selector.trim() }))
    .filter(part => part.selector);
  const listenerMode = inferCustomListenerMode(event);
  const pageUrlPattern = event.pageUrlPattern ? new RegExp(event.pageUrlPattern).source : '';

  const selectorConfig = selectors.map(part => ({
    selector: part.selector,
  }));

  return [
    '<script>',
    '(function(){',
    `  var eventName = "${escapeJsStringLiteral(event.eventName)}";`,
    `  var listenerMode = "${listenerMode}";`,
    `  var pagePattern = ${pageUrlPattern ? `new RegExp("${escapeJsStringLiteral(pageUrlPattern)}")` : 'null'};`,
    `  var selectors = ${JSON.stringify(selectorConfig)};`,
    '  if (window.__jtrackingCustomListeners && window.__jtrackingCustomListeners[eventName]) return;',
    '  window.__jtrackingCustomListeners = window.__jtrackingCustomListeners || {};',
    '  window.__jtrackingCustomListeners[eventName] = true;',
    '  document.addEventListener(listenerMode, function(evt) {',
    '    try {',
    '      if (pagePattern && !pagePattern.test(window.location.href)) return;',
    '      var target = evt.target instanceof Element ? evt.target : null;',
    '      if (!target) return;',
    '      for (var i = 0; i < selectors.length; i++) {',
    '        var item = selectors[i];',
    '        var matched = target.closest(item.selector);',
    '        if (!matched) continue;',
    '        var text = (matched.textContent || "").trim();',
    '        if (listenerMode === "submit" && window.__jtrackingPreviewMode) {',
    '          evt.preventDefault();',
    '        }',
    '        window.dataLayer = window.dataLayer || [];',
    '        if (listenerMode === "submit") {',
    '          var action = "";',
    '          if (matched instanceof HTMLFormElement) {',
    '            action = matched.action || matched.getAttribute("action") || window.location.href;',
    '          }',
    '          var formClassName = typeof matched.className === "string" ? matched.className : "";',
    '          window.dataLayer.push({',
    '            event: eventName,',
    '            form_text: text,',
    '            form_url: action,',
    '            form_classes: formClassName',
    '          });',
    '        } else {',
    '          var href = "";',
    '          if (matched instanceof HTMLAnchorElement || matched instanceof HTMLAreaElement) {',
    '            href = matched.href || matched.getAttribute("href") || "";',
    '          } else if (matched instanceof Element) {',
    '            var hrefNode = matched.closest("a[href], area[href]");',
    '            href = hrefNode ? (hrefNode.href || hrefNode.getAttribute("href") || "") : "";',
    '          }',
    '          var className = typeof matched.className === "string" ? matched.className : "";',
    '          window.dataLayer.push({',
    '            event: eventName,',
    '            link_text: text,',
    '            link_url: href,',
    '            link_classes: className',
    '          });',
    '        }',
    '        return;',
    '      }',
    '    } catch (_err) {}',
    '  }, true);',
    '})();',
    '</script>',
  ].join('\n');
}

function shouldMatchDescendants(selectorPart: string): boolean {
  return !!selectorPart.trim();
}

function makeClickTrigger(event: GA4Event, accountId: string, containerId: string): GTMTrigger {
  const triggerId = nextId();
  const filter: GTMCondition[] = [];

  if (event.elementSelector) {
    // GTM cannot evaluate jQuery :contains() selectors directly.
    // Convert them into a descendant-safe CSS selector only.
    // We intentionally do not add Click Text conditions here because
    // localized pages can render different CTA copy while preserving
    // the same structural selector.
    const parsedParts = splitSelectorList(event.elementSelector).map(extractContainsText);
    const selectorParts = parsedParts
      .map(part => part.selector)
      .filter(Boolean);
    const uniqueParts = [...new Set(selectorParts)];
    const finalSelector = uniqueParts.map(selectorPart => {
      if (!shouldMatchDescendants(selectorPart)) return selectorPart;
      return `:is(${selectorPart}, ${selectorPart} *)`;
    }).join(', ');

    if (finalSelector) {
      filter.push({
        type: 'cssSelector',
        parameter: [
          { type: 'template', key: 'arg0', value: '{{Click Element}}' },
          { type: 'template', key: 'arg1', value: finalSelector },
        ],
      });
    }
  }

  if (event.pageUrlPattern) {
    const urlConditions = makeUrlFilterConditions(event.pageUrlPattern, '{{Page URL}}');
    if (urlConditions) filter.push(...urlConditions);
  }

  return {
    accountId,
    containerId,
    triggerId,
    name: toManagedName(`Trigger - ${event.eventName} - click`),
    // Use All Elements click triggers consistently. Just Links misses
    // some real-world anchor interactions such as file downloads and
    // cross-page navigations that still need reliable click tracking.
    type: 'click',
    filter: filter.length > 0 ? filter : undefined,
    parameter: [
      { type: 'boolean', key: 'waitForTags', value: 'true' },
      { type: 'boolean', key: 'checkValidation', value: 'false' },
      { type: 'integer', key: 'waitForTagsTimeout', value: '2000' },
    ],
  };
}

function makeFormTrigger(event: GA4Event, accountId: string, containerId: string): GTMTrigger {
  const triggerId = nextId();
  const filter: GTMCondition[] = [];

  if (event.elementSelector) {
    const cleanSelector = event.elementSelector.replace(/:contains\([^)]*\)/g, '').trim();
    filter.push({
      type: 'cssSelector',
      parameter: [
        { type: 'template', key: 'arg0', value: '{{Form Element}}' },
        { type: 'template', key: 'arg1', value: cleanSelector },
      ],
    });
  }

  return {
    accountId,
    containerId,
    triggerId,
    name: toManagedName(`Trigger - ${event.eventName} - form`),
    type: 'formSubmission',
    filter: filter.length > 0 ? filter : undefined,
    parameter: [
      { type: 'boolean', key: 'waitForTags', value: 'false' },
      { type: 'boolean', key: 'checkValidation', value: 'false' },
      { type: 'integer', key: 'waitForTagsTimeout', value: '2000' },
    ],
  };
}

function makeScrollTrigger(accountId: string, containerId: string): GTMTrigger {
  return {
    accountId,
    containerId,
    triggerId: nextId(),
    name: toManagedName('Trigger - scroll_depth'),
    type: 'scrollDepth',
    parameter: [
      { type: 'template', key: 'verticalThresholdUnits', value: 'PERCENT' },
      { type: 'template', key: 'verticalThresholds', value: '25,50,75,100' },
      { type: 'boolean', key: 'orCondition', value: 'false' },
    ],
  };
}

function makePageViewTrigger(event: GA4Event, accountId: string, containerId: string): GTMTrigger {
  const triggerId = nextId();

  if (!event.pageUrlPattern) {
    // All pages
    return {
      accountId,
      containerId,
      triggerId,
      name: toManagedName(`Trigger - ${event.eventName}`),
      type: 'pageview',
    };
  }

  const urlConditions = makeUrlFilterConditions(event.pageUrlPattern, '{{Page URL}}');
  return {
    accountId,
    containerId,
    triggerId,
    name: toManagedName(`Trigger - ${event.eventName}`),
    type: 'pageview',
    filter: urlConditions ?? undefined,
  };
}

function rewriteVariableReferences(value: string, variableNameMap: Map<string, string>): string {
  return value.replace(/\{\{(.+?)\}\}/g, (_match, name: string) => {
    const mapped = variableNameMap.get(name);
    return mapped ? `{{${mapped}}}` : `{{${name}}}`;
  });
}

function buildEventParameters(event: GA4Event, variableNameMap: Map<string, string>): GTMParameter[] {
  if (event.parameters.length === 0) return [];

  return [
    {
      type: 'list',
      key: 'eventParameters',
      list: event.parameters.map(param => ({
        type: 'map' as const,
        map: [
          { type: 'template' as const, key: 'name', value: param.name },
          { type: 'template' as const, key: 'value', value: rewriteVariableReferences(param.value, variableNameMap) },
        ],
      })),
    },
  ];
}

function rewriteCustomListenerEventParameters(event: GA4Event): GA4Event {
  if (event.triggerType !== 'custom' || !event.elementSelector) {
    return event;
  }

  const listenerMode = inferCustomListenerMode(event);

  return {
    ...event,
    parameters: event.parameters.map(param => {
      if (listenerMode === 'submit' && param.value === '{{Form Text}}') {
        return { ...param, value: '{{form_text}}' };
      }
      if (listenerMode === 'submit' && param.value === '{{Form URL}}') {
        return { ...param, value: '{{form_url}}' };
      }
      if (listenerMode === 'submit' && param.value === '{{Form Classes}}') {
        return { ...param, value: '{{form_classes}}' };
      }
      if (listenerMode === 'click' && param.value === '{{Click Text}}') {
        return { ...param, value: '{{link_text}}' };
      }
      if (listenerMode === 'click' && param.value === '{{Click URL}}') {
        return { ...param, value: '{{link_url}}' };
      }
      if (listenerMode === 'click' && param.value === '{{Click Classes}}') {
        return { ...param, value: '{{link_classes}}' };
      }
      return param;
    }),
  };
}

function makeGA4EventTag(
  event: GA4Event,
  triggerId: string,
  measurementId: string,
  variableNameMap: Map<string, string>,
  accountId: string,
  containerId: string
): GTMTag {
  return {
    accountId,
    containerId,
    tagId: nextId(),
    name: toManagedName(`GA4 - ${event.eventName} - ${event.triggerType}`),
    type: 'gaawe', // GA4 Event
    parameter: [
      { type: 'template', key: 'eventName', value: event.eventName },
      { type: 'template', key: 'measurementIdOverride', value: measurementId },
      ...buildEventParameters(event, variableNameMap),
    ],
    firingTriggerId: [triggerId],
    tagFiringOption: 'oncePerEvent',
  };
}

function makeGA4ConfigTag(
  configTagTargetId: string,
  pageViewTriggerId: string,
  accountId: string,
  containerId: string
): GTMTag {
  return {
    accountId,
    containerId,
    tagId: nextId(),
    name: toManagedName('GA4 - Configuration'),
    type: 'gaawc', // GA4 Config
    parameter: [
      // The legacy GA4 config export schema still serializes this field as "measurementId".
      // When a distinct Google tag ID is supplied, we apply it here as the configuration tag target.
      { type: 'template', key: 'measurementId', value: configTagTargetId },
      { type: 'boolean', key: 'sendPageView', value: 'true' },
    ],
    firingTriggerId: [pageViewTriggerId],
    tagFiringOption: 'oncePerEvent',
  };
}

function makeCustomHtmlTag(
  event: GA4Event,
  pageViewTriggerId: string,
  accountId: string,
  containerId: string,
): GTMTag {
  return {
    accountId,
    containerId,
    tagId: nextId(),
    name: toManagedName(`Listener - ${event.eventName}`),
    type: 'html',
    parameter: [
      { type: 'template', key: 'html', value: buildCustomListenerHtml(event) },
      { type: 'boolean', key: 'supportDocumentWrite', value: 'false' },
    ],
    firingTriggerId: [pageViewTriggerId],
    tagFiringOption: 'oncePerEvent',
  };
}

// ─── GTM Variable Registry ───────────────────────────────────────────────────

// Built-in variables that must be explicitly enabled via the GTM API
const ENABLEABLE_BUILTINS: Record<string, string> = {
  'Click Element': 'CLICK_ELEMENT',
  'Click Classes': 'CLICK_CLASSES',
  'Click ID': 'CLICK_ID',
  'Click Target': 'CLICK_TARGET',
  'Click URL': 'CLICK_URL',
  'Click Text': 'CLICK_TEXT',
  'Form Element': 'FORM_ELEMENT',
  'Form Classes': 'FORM_CLASSES',
  'Form ID': 'FORM_ID',
  'Form Target': 'FORM_TARGET',
  'Form URL': 'FORM_URL',
  'Form Text': 'FORM_TEXT',
  'Page URL': 'PAGE_URL',
  'Page Hostname': 'PAGE_HOSTNAME',
  'Page Path': 'PAGE_PATH',
  'Referrer': 'REFERRER',
};

// Variables auto-provided by GTM or by specific trigger types (no action needed)
const AUTO_AVAILABLE = new Set([
  '_event', 'Event',
  'Container ID', 'Container Version', 'Debug Mode', 'Random Number', 'HTML ID',
  'Scroll Depth Threshold', 'Scroll Depth Units', 'Scroll Direction',
  'Video Provider', 'Video Status', 'Video URL', 'Video Title',
  'Video Duration', 'Video Current Time', 'Video Percent', 'Video Visible',
]);

// Well-known custom variables with pre-defined GTM config
const KNOWN_CUSTOM_VARIABLES: Record<string, { type: string; parameter: GTMParameter[] }> = {
  'Page Title': {
    type: 'j',
    parameter: [{ type: 'template', key: 'name', value: 'document.title' }],
  },
};

function extractVariableReferences(events: GA4Event[]): Set<string> {
  const refs = new Set<string>();
  for (const event of events) {
    for (const param of event.parameters) {
      for (const match of param.value.matchAll(/\{\{(.+?)\}\}/g)) {
        refs.add(match[1]);
      }
    }
  }
  return refs;
}

function resolveVariables(
  refs: Set<string>,
  accountId: string,
  containerId: string,
): { variables: GTMVariable[]; requiredBuiltIns: string[]; variableNameMap: Map<string, string> } {
  const variables: GTMVariable[] = [];
  const requiredBuiltIns = new Set<string>();
  const variableNameMap = new Map<string, string>();

  for (const name of refs) {
    // Built-in that needs enabling
    if (ENABLEABLE_BUILTINS[name]) {
      requiredBuiltIns.add(ENABLEABLE_BUILTINS[name]);
      continue;
    }

    // Auto-available — skip
    if (AUTO_AVAILABLE.has(name)) continue;

    // Known custom variable with pre-defined config
    if (KNOWN_CUSTOM_VARIABLES[name]) {
      const known = KNOWN_CUSTOM_VARIABLES[name];
      const managedName = toManagedName(name);
      variables.push({
        accountId, containerId, variableId: nextId(),
        name: managedName, type: known.type, parameter: known.parameter,
      });
      variableNameMap.set(name, managedName);
      continue;
    }

    // Unknown: infer type from name pattern
    if (name.includes('.')) {
      // JavaScript property path (e.g., "document.referrer")
      const managedName = toManagedName(name);
      variables.push({
        accountId, containerId, variableId: nextId(),
        name: managedName, type: 'j',
        parameter: [{ type: 'template', key: 'name', value: name }],
      });
      variableNameMap.set(name, managedName);
    } else {
      // DataLayer variable (default for snake_case or other names)
      const dlKey = name.replace(/^DLV - /, '');
      const managedName = toManagedName(name);
      variables.push({
        accountId, containerId, variableId: nextId(),
        name: managedName, type: 'v',
        parameter: [
          { type: 'integer', key: 'dataLayerVersion', value: '2' },
          { type: 'boolean', key: 'setDefaultValue', value: 'false' },
          { type: 'template', key: 'name', value: dlKey },
        ],
      });
      variableNameMap.set(name, managedName);
    }
  }

  return { variables, requiredBuiltIns: Array.from(requiredBuiltIns), variableNameMap };
}

function inferTriggerBuiltIns(events: GA4Event[]): string[] {
  const required = new Set<string>();

  for (const event of events) {
    if (event.pageUrlPattern) {
      required.add('PAGE_URL');
    }

    if (event.triggerType === 'click') {
      required.add('CLICK_ELEMENT');
    }

    if (event.triggerType === 'form_submit') {
      required.add('FORM_ELEMENT');
    }
  }

  return Array.from(required);
}

export function generateGTMConfig(
  schema: EventSchema,
  tracking: GTMTrackingIds | string,
  accountId = '0',
  containerId = '0'
): GTMContainerExport {
  idCounter = 100; // Reset counter for deterministic output
  const trackingIds = typeof tracking === 'string'
    ? { measurementId: tracking }
    : tracking;
  const { measurementId, googleTagId } = trackingIds;
  const configTagTargetId = googleTagId || measurementId;
  const managedEvents = schema.events.filter(event => !isRedundantAutoEvent(event));
  const normalizedEvents = managedEvents.map(rewriteCustomListenerEventParameters);
  const skippedAutoEvents = schema.events
    .filter(isRedundantAutoEvent)
    .map(event => event.eventName);

  // Dynamically resolve variables from event parameter references
  const varRefs = extractVariableReferences(normalizedEvents);
  const { variables, requiredBuiltIns, variableNameMap } = resolveVariables(varRefs, accountId, containerId);
  const triggerBuiltIns = inferTriggerBuiltIns(normalizedEvents);
  const triggers: GTMTrigger[] = [];
  const tags: GTMTag[] = [];

  // Create a single All Pages trigger for GA4 Config tag
  const allPagesTrigger: GTMTrigger = {
    accountId,
    containerId,
    triggerId: nextId(),
    name: toManagedName('Trigger - All Pages'),
    type: 'pageview',
  };
  triggers.push(allPagesTrigger);

  // GA4 Configuration tag (fires on all pages)
  const configTag = makeGA4ConfigTag(configTagTargetId, allPagesTrigger.triggerId, accountId, containerId);
  tags.push(configTag);

  // Track which event names have scroll trigger to avoid duplicates
  let scrollTriggerCreated = false;
  let scrollTriggerId = '';

  for (const event of normalizedEvents) {
    let trigger: GTMTrigger;

    switch (event.triggerType) {
      case 'page_view': {
        trigger = makePageViewTrigger(event, accountId, containerId);
        triggers.push(trigger);
        tags.push(makeGA4EventTag(event, trigger.triggerId, measurementId, variableNameMap, accountId, containerId));
        break;
      }

      case 'click': {
        trigger = makeClickTrigger(event, accountId, containerId);
        triggers.push(trigger);
        tags.push(makeGA4EventTag(event, trigger.triggerId, measurementId, variableNameMap, accountId, containerId));
        break;
      }

      case 'form_submit': {
        trigger = makeFormTrigger(event, accountId, containerId);
        triggers.push(trigger);
        tags.push(makeGA4EventTag(event, trigger.triggerId, measurementId, variableNameMap, accountId, containerId));
        break;
      }

      case 'scroll': {
        if (!scrollTriggerCreated) {
          const scrollTrigger = makeScrollTrigger(accountId, containerId);
          triggers.push(scrollTrigger);
          scrollTriggerId = scrollTrigger.triggerId;
          scrollTriggerCreated = true;
        }
        tags.push(makeGA4EventTag(event, scrollTriggerId, measurementId, variableNameMap, accountId, containerId));
        break;
      }

      case 'video': {
        const videoTrigger: GTMTrigger = {
          accountId,
          containerId,
          triggerId: nextId(),
          name: toManagedName(`Trigger - ${event.eventName}`),
          type: 'youTubeVideo',
          parameter: [
            { type: 'boolean', key: 'trackPlay', value: 'true' },
            { type: 'boolean', key: 'trackPause', value: 'false' },
            { type: 'boolean', key: 'trackComplete', value: 'true' },
            { type: 'template', key: 'progressThresholds', value: '25,50,75' },
            { type: 'boolean', key: 'trackProgress', value: 'true' },
          ],
        };
        triggers.push(videoTrigger);
        tags.push(makeGA4EventTag(event, videoTrigger.triggerId, measurementId, variableNameMap, accountId, containerId));
        break;
      }

      default: {
        // Custom events - use custom event trigger
        const customTrigger: GTMTrigger = {
          accountId,
          containerId,
          triggerId: nextId(),
          name: toManagedName(`Trigger - ${event.eventName}`),
          type: 'customEvent',
          eventName: { type: 'template', key: 'eventName', value: event.eventName },
          customEventFilter: [
            {
              type: 'equals',
              parameter: [
                { type: 'template', key: 'arg0', value: '{{_event}}' },
                { type: 'template', key: 'arg1', value: event.eventName },
              ],
            },
          ],
        };
        triggers.push(customTrigger);
        if (event.elementSelector) {
          tags.push(makeCustomHtmlTag(event, allPagesTrigger.triggerId, accountId, containerId));
        }
        tags.push(makeGA4EventTag(event, customTrigger.triggerId, measurementId, variableNameMap, accountId, containerId));
      }
    }
  }

  const metadataNotes = [
    ...(googleTagId && googleTagId !== measurementId
      ? ['The configuration tag targets googleTagId, while GA4 event tags still target ga4MeasurementId.']
      : []),
    ...(skippedAutoEvents.length > 0
      ? [`Skipped redundant auto-collected schema events: ${[...new Set(skippedAutoEvents)].join(', ')}.`]
      : []),
  ];

  return {
    exportFormatVersion: 2,
    exportTime: new Date().toISOString().replace('T', ' ').slice(0, 19),
    eventTrackingMetadata: {
      ga4MeasurementId: measurementId,
      googleTagId,
      configTagTargetId,
      syncMode: googleTagId ? 'google_tag_for_config_tag' : 'measurement_id_only',
      notes: metadataNotes.length > 0 ? metadataNotes : undefined,
    },
    requiredBuiltInVariables: [...new Set([...requiredBuiltIns, ...triggerBuiltIns])],
    containerVersion: {
      accountId,
      containerId,
      containerVersionId: '0',
      name: `Event Tracking - ${schema.siteUrl}`,
      description: `Auto-generated GA4 event tracking configuration for ${schema.siteUrl}. Generated by analytics-tracking-automation on ${schema.generatedAt}`,
      container: {
        accountId,
        containerId,
        name: `Event Tracking - ${schema.siteUrl}`,
        usageContext: ['WEB'],
      },
      variable: variables,
      trigger: triggers,
      tag: tags,
    },
  };
}
