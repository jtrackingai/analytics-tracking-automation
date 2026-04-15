import * as https from 'https';
import * as vm from 'vm';

export type LiveGtmConfidence = 'high' | 'medium' | 'low';
export type LiveGtmTriggerType = 'click' | 'form_submit' | 'page_view' | 'custom' | 'unknown';

export interface LiveGtmParameter {
  name: string;
  value: string;
  source: string;
}

export interface LiveGtmTriggerHint {
  triggerTypes: LiveGtmTriggerType[];
  builtInEvents: string[];
  selectors: string[];
  urlPatterns: string[];
  conditions: string[];
}

export interface LiveGtmEvent {
  eventName: string;
  tagFunction: string;
  tagId?: string;
  measurementIds: string[];
  parameters: LiveGtmParameter[];
  triggerHint: LiveGtmTriggerHint;
  confidence: LiveGtmConfidence;
  notes: string[];
}

export interface LiveGtmContainerAnalysis {
  publicId: string;
  sourceUrl: string;
  analyzedAt: string;
  resourceVersion?: string;
  measurementIds: string[];
  configTagIds: string[];
  events: LiveGtmEvent[];
  warnings: string[];
}

export interface AggregatedLiveGtmEvent {
  eventName: string;
  containers: string[];
  measurementIds: string[];
  parameterNames: string[];
  triggerTypes: LiveGtmTriggerType[];
  selectors: string[];
  urlPatterns: string[];
  confidence: LiveGtmConfidence;
}

export interface LiveGtmAnalysis {
  siteUrl: string;
  analyzedAt: string;
  detectedContainerIds: string[];
  primaryContainerId: string | null;
  containers: LiveGtmContainerAnalysis[];
  aggregatedEvents: AggregatedLiveGtmEvent[];
  warnings: string[];
}

interface GtmRuntimeResource {
  version?: string;
  macros?: Array<Record<string, unknown>>;
  tags?: Array<Record<string, unknown>>;
  predicates?: Array<Record<string, unknown>>;
  rules?: unknown[];
}

interface ResolvedValue {
  text: string;
  selectors: string[];
  urlPatterns: string[];
  eventNames: string[];
}

interface ParsedRuleCondition {
  ifPredicates: number[];
  unlessPredicates: number[];
}

const GTM_BASE_URL = 'https://www.googletagmanager.com/gtm.js';
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_CONDITION_LENGTH = 200;
const MAX_MACRO_TEMPLATE_LENGTH = 240;

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeContainerId(value: string): string {
  return value.trim().toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isMacroReference(value: unknown): value is ['macro', number] {
  return Array.isArray(value) &&
    value.length === 2 &&
    value[0] === 'macro' &&
    typeof value[1] === 'number';
}

function isLikelyUrlVariable(text: string): boolean {
  return text.startsWith('{{url_') || text === '{{Page URL}}' || text.includes('page_location');
}

function isLikelySelector(text: string): boolean {
  if (!text || text.startsWith('{{')) return false;
  return /[#.[>:]]/.test(text) || /\b(button|a|input|form|main|header|footer|nav|section|article|div|span)\b/.test(text);
}

function isLikelyUrlPattern(text: string): boolean {
  return /^https?:\/\//.test(text) || /^\^https?:\/\//.test(text) || /^\/.+/.test(text);
}

function isBuiltInEventName(text: string): boolean {
  return /^gtm\./.test(text);
}

function clampText(text: string, maxLength = MAX_MACRO_TEMPLATE_LENGTH): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function scoreConfidence(args: {
  triggerTypes: LiveGtmTriggerType[];
  selectors: string[];
  urlPatterns: string[];
  builtInEvents: string[];
}): LiveGtmConfidence {
  const hasConcreteTrigger = args.triggerTypes.some(type => type !== 'unknown');
  const hasScopeHint = args.selectors.length > 0 || args.urlPatterns.length > 0;
  const hasEventHint = args.builtInEvents.length > 0;

  if (hasConcreteTrigger && (hasScopeHint || hasEventHint)) return 'high';
  if (hasConcreteTrigger || hasScopeHint || hasEventHint) return 'medium';
  return 'low';
}

function extractMappedEntries(value: unknown): unknown[] {
  if (!Array.isArray(value) || value[0] !== 'list') return [];
  return value.slice(1);
}

function getMapEntryValue(entry: unknown, key: string): unknown {
  if (Array.isArray(entry) && entry[0] === 'map') {
    for (let idx = 1; idx < entry.length - 1; idx += 2) {
      if (entry[idx] === key) {
        return entry[idx + 1];
      }
    }
    return undefined;
  }

  if (isRecord(entry)) {
    return entry[key];
  }

  return undefined;
}

function getObjectLiteralFromRuntime(script: string): string {
  const marker = 'var data =';
  const start = script.indexOf(marker);
  if (start === -1) {
    throw new Error('Could not find `var data =` inside the live GTM runtime.');
  }

  const braceStart = script.indexOf('{', start);
  if (braceStart === -1) {
    throw new Error('Could not find the start of the GTM runtime data object.');
  }

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escape = false;

  for (let idx = braceStart; idx < script.length; idx += 1) {
    const ch = script[idx];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (inSingle) {
      if (ch === '\'') inSingle = false;
      continue;
    }

    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }

    if (inTemplate) {
      if (ch === '`') inTemplate = false;
      continue;
    }

    if (ch === '\'') {
      inSingle = true;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      continue;
    }

    if (ch === '`') {
      inTemplate = true;
      continue;
    }

    if (ch === '{') {
      depth += 1;
      continue;
    }

    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return script.slice(braceStart, idx + 1);
      }
    }
  }

  throw new Error('Could not locate the end of the GTM runtime data object.');
}

function fetchText(url: string, timeoutMs = DEFAULT_TIMEOUT_MS, redirectsLeft = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, response => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects while fetching ${url}`));
          return;
        }
        const nextUrl = new URL(location, url).toString();
        fetchText(nextUrl, timeoutMs, redirectsLeft - 1).then(resolve).catch(reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${statusCode} while fetching ${url}`));
        return;
      }

      response.setEncoding('utf8');
      let body = '';
      response.on('data', chunk => {
        body += chunk;
      });
      response.on('end', () => resolve(body));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
    });
    req.on('error', reject);
  });
}

function evalRuntimeObject(source: string): GtmRuntimeResource {
  const data = vm.runInNewContext(`(${source})`, {}, { timeout: 1000 }) as { resource?: GtmRuntimeResource };
  if (!data?.resource) {
    throw new Error('The live GTM runtime did not expose `data.resource`.');
  }
  return data.resource;
}

function mergeResolved(parts: ResolvedValue[]): ResolvedValue {
  return {
    text: parts.map(part => part.text).join(''),
    selectors: uniq(parts.flatMap(part => part.selectors)),
    urlPatterns: uniq(parts.flatMap(part => part.urlPatterns)),
    eventNames: uniq(parts.flatMap(part => part.eventNames)),
  };
}

function resolveTemplateParts(
  value: unknown[],
  resource: GtmRuntimeResource,
  macroCache: Map<number, ResolvedValue>,
  seenMacros: Set<number>,
): ResolvedValue {
  const parts: ResolvedValue[] = [];
  for (const part of value.slice(1)) {
    if (typeof part === 'string') {
      parts.push({ text: part, selectors: [], urlPatterns: [], eventNames: [] });
      continue;
    }
    parts.push(resolveValue(part, resource, macroCache, seenMacros));
  }

  const merged = mergeResolved(parts);
  return { ...merged, text: clampText(merged.text) };
}

function extractMacroTemplate(macro: Record<string, unknown>): unknown[] | null {
  const js = macro.vtp_javascript;
  if (Array.isArray(js)) return js;
  return null;
}

function resolveMacro(
  index: number,
  resource: GtmRuntimeResource,
  macroCache: Map<number, ResolvedValue>,
  seenMacros: Set<number>,
): ResolvedValue {
  if (macroCache.has(index)) {
    return macroCache.get(index)!;
  }

  if (seenMacros.has(index)) {
    return { text: `{{macro_${index}}}`, selectors: [], urlPatterns: [], eventNames: [] };
  }

  seenMacros.add(index);
  const macro = resource.macros?.[index];
  if (!macro) {
    const unresolved = { text: `{{macro_${index}}}`, selectors: [], urlPatterns: [], eventNames: [] };
    macroCache.set(index, unresolved);
    seenMacros.delete(index);
    return unresolved;
  }

  const macroFn = typeof macro.function === 'string' ? macro.function : '';
  let resolved: ResolvedValue;

  switch (macroFn) {
    case '__c':
      resolved = {
        text: String(macro.vtp_value ?? ''),
        selectors: [],
        urlPatterns: isLikelyUrlPattern(String(macro.vtp_value ?? '')) ? [String(macro.vtp_value)] : [],
        eventNames: [],
      };
      break;
    case '__e':
      resolved = { text: '{{event}}', selectors: [], urlPatterns: [], eventNames: [] };
      break;
    case '__v':
      resolved = { text: `{{${String(macro.vtp_name ?? 'dataLayer')}}}`, selectors: [], urlPatterns: [], eventNames: [] };
      break;
    case '__u':
      resolved = {
        text: `{{url_${String(macro.vtp_component ?? 'full').toLowerCase()}}}`,
        selectors: [],
        urlPatterns: [],
        eventNames: [],
      };
      break;
    case '__d': {
      const selector = String(macro.vtp_elementSelector ?? '');
      resolved = {
        text: selector || `{{selector_macro_${index}}}`,
        selectors: selector ? [selector] : [],
        urlPatterns: [],
        eventNames: [],
      };
      break;
    }
    case '__cid':
      resolved = { text: '{{container_id}}', selectors: [], urlPatterns: [], eventNames: [] };
      break;
    case '__f':
      resolved = { text: '{{referrer}}', selectors: [], urlPatterns: [], eventNames: [] };
      break;
    case '__aev':
      resolved = { text: '{{auto_event_variable}}', selectors: [], urlPatterns: [], eventNames: [] };
      break;
    case '__jsm': {
      const template = extractMacroTemplate(macro);
      if (template) {
        const fromTemplate = resolveTemplateParts(template, resource, macroCache, seenMacros);
        resolved = {
          text: fromTemplate.text ? `{{jsm_${index}:${clampText(fromTemplate.text, 80)}}}` : `{{jsm_${index}}}`,
          selectors: fromTemplate.selectors,
          urlPatterns: fromTemplate.urlPatterns,
          eventNames: fromTemplate.eventNames,
        };
      } else {
        resolved = { text: `{{jsm_${index}}}`, selectors: [], urlPatterns: [], eventNames: [] };
      }
      break;
    }
    default:
      resolved = { text: `{{macro_${index}}}`, selectors: [], urlPatterns: [], eventNames: [] };
      break;
  }

  macroCache.set(index, resolved);
  seenMacros.delete(index);
  return resolved;
}

function resolveValue(
  value: unknown,
  resource: GtmRuntimeResource,
  macroCache: Map<number, ResolvedValue>,
  seenMacros: Set<number> = new Set(),
): ResolvedValue {
  if (isMacroReference(value)) {
    return resolveMacro(value[1], resource, macroCache, seenMacros);
  }

  if (Array.isArray(value)) {
    if (value[0] === 'template') {
      return resolveTemplateParts(value, resource, macroCache, seenMacros);
    }
    return {
      text: JSON.stringify(value),
      selectors: [],
      urlPatterns: [],
      eventNames: [],
    };
  }

  if (value === null || value === undefined) {
    return { text: '', selectors: [], urlPatterns: [], eventNames: [] };
  }

  if (typeof value === 'string') {
    return {
      text: value,
      selectors: isLikelySelector(value) ? [value] : [],
      urlPatterns: isLikelyUrlPattern(value) ? [value] : [],
      eventNames: isBuiltInEventName(value) ? [value] : [],
    };
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return { text: String(value), selectors: [], urlPatterns: [], eventNames: [] };
  }

  if (isRecord(value)) {
    return {
      text: JSON.stringify(value),
      selectors: [],
      urlPatterns: [],
      eventNames: [],
    };
  }

  return { text: String(value), selectors: [], urlPatterns: [], eventNames: [] };
}

function collectTagConditions(resource: GtmRuntimeResource): Map<number, ParsedRuleCondition[]> {
  const tagConditions = new Map<number, ParsedRuleCondition[]>();

  for (const rule of resource.rules ?? []) {
    if (!Array.isArray(rule)) continue;

    const ifPredicates: number[] = [];
    const unlessPredicates: number[] = [];
    const addTags: number[] = [];

    for (const step of rule) {
      if (!Array.isArray(step) || typeof step[0] !== 'string') continue;

      const op = step[0];
      const refs = step
        .slice(1)
        .filter((value): value is number => typeof value === 'number');

      if (op === 'if') {
        ifPredicates.push(...refs);
      } else if (op === 'unless') {
        unlessPredicates.push(...refs);
      } else if (op === 'add') {
        addTags.push(...refs);
      }
    }

    for (const tagIndex of addTags) {
      const current = tagConditions.get(tagIndex) ?? [];
      current.push({ ifPredicates: [...ifPredicates], unlessPredicates: [...unlessPredicates] });
      tagConditions.set(tagIndex, current);
    }
  }

  return tagConditions;
}

function parsePredicateCondition(
  predicate: Record<string, unknown>,
  resource: GtmRuntimeResource,
  macroCache: Map<number, ResolvedValue>,
): ResolvedValue {
  const fn = typeof predicate.function === 'string' ? predicate.function : 'unknown';
  const args = Object.entries(predicate)
    .filter(([key]) => key !== 'function')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => resolveValue(value, resource, macroCache));

  const selectors = uniq(args.flatMap(arg => arg.selectors));
  const urlPatterns = uniq(args.flatMap(arg => arg.urlPatterns));
  const eventNames = uniq(args.flatMap(arg => arg.eventNames));
  const texts = args.map(arg => arg.text).filter(Boolean);

  if (fn === '_eq' || fn === '_eqi') {
    if (texts.includes('{{event}}')) {
      const other = texts.find(text => text !== '{{event}}');
      if (other) {
        return {
          text: `event == ${other}`,
          selectors,
          urlPatterns,
          eventNames: other ? [other] : eventNames,
        };
      }
    }
  }

  if (fn === '_re' && texts.length >= 2) {
    const [left, right] = texts;
    if (isLikelyUrlVariable(left) && right) {
      return {
        text: `URL matches ${right}`,
        selectors,
        urlPatterns: uniq([...urlPatterns, right]),
        eventNames,
      };
    }
  }

  if (fn === '_css' && texts.length >= 2) {
    const selector = texts.find(text => isLikelySelector(text));
    return {
      text: selector ? `element matches ${selector}` : `${fn}(${texts.join(', ')})`,
      selectors: selector ? uniq([...selectors, selector]) : selectors,
      urlPatterns,
      eventNames,
    };
  }

  return {
    text: `${fn}(${texts.join(', ')})`,
    selectors,
    urlPatterns,
    eventNames,
  };
}

function buildTriggerHint(
  tagIndex: number,
  resource: GtmRuntimeResource,
  tagConditions: Map<number, ParsedRuleCondition[]>,
  macroCache: Map<number, ResolvedValue>,
): LiveGtmTriggerHint {
  const conditions = tagConditions.get(tagIndex) ?? [];
  const selectors: string[] = [];
  const urlPatterns: string[] = [];
  const firingEvents: string[] = [];
  const readableConditions: string[] = [];

  for (const condition of conditions) {
    for (const predicateIndex of condition.ifPredicates) {
      const predicate = resource.predicates?.[predicateIndex];
      if (!predicate) continue;

      const parsed = parsePredicateCondition(predicate, resource, macroCache);
      selectors.push(...parsed.selectors);
      urlPatterns.push(...parsed.urlPatterns);
      firingEvents.push(...parsed.eventNames);
      if (parsed.text) readableConditions.push(clampText(parsed.text, MAX_CONDITION_LENGTH));
    }

    for (const predicateIndex of condition.unlessPredicates) {
      const predicate = resource.predicates?.[predicateIndex];
      if (!predicate) continue;

      const parsed = parsePredicateCondition(predicate, resource, macroCache);
      if (parsed.text) readableConditions.push(`NOT ${clampText(parsed.text, MAX_CONDITION_LENGTH - 4)}`);
    }
  }

  const triggerTypes = new Set<LiveGtmTriggerType>();
  const uniqueFiringEvents = uniq(firingEvents);

  for (const eventName of uniqueFiringEvents) {
    if (eventName === 'gtm.click' || eventName === 'gtm.linkClick') {
      triggerTypes.add('click');
      continue;
    }
    if (eventName === 'gtm.formSubmit') {
      triggerTypes.add('form_submit');
      continue;
    }
    if (eventName === 'gtm.js' || eventName === 'gtm.dom' || eventName === 'gtm.load') {
      triggerTypes.add('page_view');
      continue;
    }
    if (!isBuiltInEventName(eventName)) {
      triggerTypes.add('custom');
    }
  }

  if (triggerTypes.size === 0 && selectors.length > 0) {
    triggerTypes.add('click');
  }

  if (triggerTypes.size === 0) {
    triggerTypes.add('unknown');
  }

  return {
    triggerTypes: Array.from(triggerTypes),
    builtInEvents: uniqueFiringEvents,
    selectors: uniq(selectors),
    urlPatterns: uniq(urlPatterns),
    conditions: uniq(readableConditions),
  };
}

function resolveTrackingIds(tag: Record<string, unknown>, resource: GtmRuntimeResource, macroCache: Map<number, ResolvedValue>): string[] {
  const candidates = [
    resolveValue(tag.vtp_measurementIdOverride, resource, macroCache).text,
    resolveValue(tag.vtp_tagId, resource, macroCache).text,
  ].filter(Boolean);

  return uniq(
    candidates.filter(candidate => /^(?:G|GT|AW)-[A-Z0-9-]+$/i.test(candidate)).map(candidate => candidate.toUpperCase()),
  );
}

function extractEventParameters(
  tag: Record<string, unknown>,
  resource: GtmRuntimeResource,
  macroCache: Map<number, ResolvedValue>,
): LiveGtmParameter[] {
  return extractMappedEntries(tag.vtp_eventSettingsTable).flatMap(entry => {
    const name = getMapEntryValue(entry, 'parameter');
    const value = getMapEntryValue(entry, 'parameterValue');

    if (typeof name !== 'string') return [];

    const resolved = resolveValue(value, resource, macroCache);
    return [{
      name,
      value: resolved.text,
      source: Array.isArray(value) ? JSON.stringify(value) : String(value ?? ''),
    }];
  });
}

export function parseLiveGtmRuntime(
  script: string,
  publicId: string,
  sourceUrl = `${GTM_BASE_URL}?id=${encodeURIComponent(publicId)}`,
): LiveGtmContainerAnalysis {
  const runtime = evalRuntimeObject(getObjectLiteralFromRuntime(script));
  const macroCache = new Map<number, ResolvedValue>();
  const tagConditions = collectTagConditions(runtime);
  const warnings: string[] = [];

  const configTagIds = uniq(
    (runtime.tags ?? [])
      .filter(tag => tag.function === '__googtag')
      .flatMap(tag => resolveTrackingIds(tag, runtime, macroCache)),
  );

  const events: LiveGtmEvent[] = (runtime.tags ?? []).flatMap((tag, index) => {
    if (typeof tag.vtp_eventName !== 'string') return [];

    const parameters = extractEventParameters(tag, runtime, macroCache);
    const triggerHint = buildTriggerHint(index, runtime, tagConditions, macroCache);
    const measurementIds = resolveTrackingIds(tag, runtime, macroCache);
    const notes: string[] = [];

    if (triggerHint.conditions.length === 0) {
      notes.push('The public runtime did not expose a readable trigger rule for this tag.');
    }
    if (triggerHint.triggerTypes.includes('unknown')) {
      notes.push('Trigger type could only be reconstructed partially from the runtime container.');
    }

    return [{
      eventName: tag.vtp_eventName,
      tagFunction: typeof tag.function === 'string' ? tag.function : 'unknown',
      tagId: tag.tag_id !== undefined ? String(tag.tag_id) : undefined,
      measurementIds,
      parameters,
      triggerHint,
      confidence: scoreConfidence({
        triggerTypes: triggerHint.triggerTypes,
        selectors: triggerHint.selectors,
        urlPatterns: triggerHint.urlPatterns,
        builtInEvents: triggerHint.builtInEvents,
      }),
      notes,
    }];
  });

  const measurementIds = uniq([
    ...configTagIds.filter(id => /^G-/i.test(id)),
    ...events.flatMap(event => event.measurementIds.filter(id => /^G-/i.test(id))),
  ]);

  if (events.length === 0) {
    warnings.push('No GA4 event tags were recovered from the public runtime container.');
  }

  return {
    publicId: normalizeContainerId(publicId),
    sourceUrl,
    analyzedAt: new Date().toISOString(),
    resourceVersion: runtime.version,
    measurementIds,
    configTagIds,
    events,
    warnings,
  };
}

function aggregateEvents(containers: LiveGtmContainerAnalysis[]): AggregatedLiveGtmEvent[] {
  const byName = new Map<string, AggregatedLiveGtmEvent>();

  for (const container of containers) {
    for (const event of container.events) {
      const existing = byName.get(event.eventName);
      if (existing) {
        existing.containers = uniq([...existing.containers, container.publicId]);
        existing.measurementIds = uniq([...existing.measurementIds, ...event.measurementIds]);
        existing.parameterNames = uniq([...existing.parameterNames, ...event.parameters.map(param => param.name)]);
        existing.triggerTypes = Array.from(new Set([...existing.triggerTypes, ...event.triggerHint.triggerTypes]));
        existing.selectors = uniq([...existing.selectors, ...event.triggerHint.selectors]);
        existing.urlPatterns = uniq([...existing.urlPatterns, ...event.triggerHint.urlPatterns]);
        if (existing.confidence === 'low' && event.confidence !== 'low') {
          existing.confidence = event.confidence;
        } else if (existing.confidence === 'medium' && event.confidence === 'high') {
          existing.confidence = 'high';
        }
      } else {
        byName.set(event.eventName, {
          eventName: event.eventName,
          containers: [container.publicId],
          measurementIds: [...event.measurementIds],
          parameterNames: uniq(event.parameters.map(param => param.name)),
          triggerTypes: [...event.triggerHint.triggerTypes],
          selectors: [...event.triggerHint.selectors],
          urlPatterns: [...event.triggerHint.urlPatterns],
          confidence: event.confidence,
        });
      }
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.eventName.localeCompare(b.eventName));
}

export async function analyzeLiveGtmContainers(args: {
  siteUrl: string;
  publicIds: string[];
  primaryContainerId?: string;
}): Promise<LiveGtmAnalysis> {
  const publicIds = uniq(args.publicIds.map(normalizeContainerId));
  if (publicIds.length === 0) {
    throw new Error('No GTM public IDs were provided for live analysis.');
  }

  const containers: LiveGtmContainerAnalysis[] = [];
  const warnings: string[] = [];

  for (const publicId of publicIds) {
    const sourceUrl = `${GTM_BASE_URL}?id=${encodeURIComponent(publicId)}`;
    try {
      const script = await fetchText(sourceUrl);
      containers.push(parseLiveGtmRuntime(script, publicId, sourceUrl));
    } catch (error) {
      warnings.push(`Failed to analyze live container ${publicId}: ${(error as Error).message}`);
    }
  }

  const aggregatedEvents = aggregateEvents(containers);
  const meaningfulContainers = containers.filter(container => container.events.length > 0 || container.measurementIds.length > 0);
  const primaryContainerId = args.primaryContainerId
    ? normalizeContainerId(args.primaryContainerId)
    : (meaningfulContainers[0]?.publicId || containers[0]?.publicId || null);

  if (primaryContainerId && !containers.some(container => container.publicId === primaryContainerId)) {
    throw new Error(`Primary container ${primaryContainerId} was not part of the analyzed live GTM set.`);
  }

  return {
    siteUrl: args.siteUrl,
    analyzedAt: new Date().toISOString(),
    detectedContainerIds: publicIds,
    primaryContainerId,
    containers,
    aggregatedEvents,
    warnings: uniq([...warnings, ...containers.flatMap(container => container.warnings)]),
  };
}

export function generateLiveGtmReviewMarkdown(analysis: LiveGtmAnalysis): string {
  const lines: string[] = [
    '# Live GTM Review',
    '',
    `**Site:** ${analysis.siteUrl}`,
    `**Analyzed:** ${new Date(analysis.analyzedAt).toLocaleString()}`,
    `**Detected Containers:** ${analysis.detectedContainerIds.join(', ') || 'none'}`,
    `**Primary Comparison Container:** ${analysis.primaryContainerId || 'none'}`,
    '',
    '## Container Summary',
    '',
    '| Container | Events | Measurement IDs | Notes |',
    '| --- | ---: | --- | --- |',
    ...analysis.containers.map(container =>
      `| \`${container.publicId}\` | ${container.events.length} | ${container.measurementIds.join(', ') || '—'} | ${container.warnings.join('; ') || '—'} |`,
    ),
    '',
    '## Aggregated Live Events',
    '',
    '| Event Name | Containers | Trigger Types | Parameters | Confidence |',
    '| --- | --- | --- | --- | --- |',
    ...analysis.aggregatedEvents.map(event =>
      `| \`${event.eventName}\` | ${event.containers.map(id => `\`${id}\``).join(', ')} | ${event.triggerTypes.join(', ')} | ${event.parameterNames.join(', ') || '—'} | ${event.confidence} |`,
    ),
    '',
  ];

  if (analysis.warnings.length > 0) {
    lines.push('## Warnings', '', ...analysis.warnings.map(warning => `- ${warning}`), '');
  }

  lines.push('_Generated by analytics-tracking-automation_');
  return lines.join('\n');
}
