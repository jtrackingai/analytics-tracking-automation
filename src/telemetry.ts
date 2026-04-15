import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

const DEFAULT_ENDPOINT = 'https://event-tracking-skill.jtracking.ai/collect';
const CONFIG_DIR = path.join(os.homedir(), '.config', 'event-tracking-skill');
const CONFIG_FILE = path.join(CONFIG_DIR, 'telemetry.json');
const TELEMETRY_TIMEOUT_MS = 800;
const SESSION_ID = crypto.randomUUID();

const ALLOWED_EVENTS = new Set([
  'site_analyzed',
  'schema_confirmed',
  'gtm_sync_completed',
  'preview_completed',
  'gtm_publish_completed',
  'cli_command_completed',
]);

const ALLOWED_PARAM_NAMES = new Set([
  'surface',
  'cli_version',
  'os_family',
  'node_major',
  'session_id',
  'engagement_time_msec',
  'command_name',
  'status',
  'duration_ms',
  'exit_code',
  'error_type',
  'mode',
  'checkpoint',
  'site_hostname',
  'run_mode',
  'page_count',
  'discovered_url_count',
  'skipped_url_count',
  'platform_type',
  'gtm_detected',
  'warning_count',
  'schema_event_count',
  'custom_dimension_count',
  'schema_added_count',
  'schema_changed_count',
  'schema_removed_count',
  'validation_error_count',
  'validation_warning_count',
  'dry_run',
  'new_workspace',
  'tags_created',
  'tags_updated',
  'tags_deleted',
  'sync_error_count',
  'total_expected',
  'total_fired',
  'health_score',
  'health_grade',
  'blocker_count',
  'unexpected_event_count',
  'manual_mode',
  'forced',
]);

export type TelemetryEventName =
  | 'site_analyzed'
  | 'schema_confirmed'
  | 'gtm_sync_completed'
  | 'preview_completed'
  | 'gtm_publish_completed'
  | 'cli_command_completed';

export type TelemetryParamValue = string | number | boolean | null | undefined;

export type TelemetryParams = Record<string, TelemetryParamValue>;

interface TelemetryConfig {
  telemetryEnabled: boolean;
  clientId: string;
  decidedAt: string;
}

interface TelemetryPayloadEvent {
  name: TelemetryEventName;
  params: Record<string, string | number>;
}

interface TelemetryPayload {
  client_id: string;
  events: TelemetryPayloadEvent[];
}

let consentPromise: Promise<TelemetryConfig | null> | null = null;

function getConfigFile(): string {
  return process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE?.trim() || CONFIG_FILE;
}

function getEndpoint(): string {
  return process.env.EVENT_TRACKING_TELEMETRY_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
}

function parseBooleanEnv(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function readConfig(): TelemetryConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getConfigFile(), 'utf8')) as Partial<TelemetryConfig>;
    if (typeof parsed.telemetryEnabled !== 'boolean') return null;
    if (typeof parsed.clientId !== 'string' || parsed.clientId.trim() === '') return null;
    return {
      telemetryEnabled: parsed.telemetryEnabled,
      clientId: parsed.clientId,
      decidedAt: typeof parsed.decidedAt === 'string' ? parsed.decidedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function writeConfig(config: TelemetryConfig): void {
  try {
    const file = getConfigFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
  } catch {
    // Telemetry must never interfere with the primary CLI workflow.
  }
}

function makeConfig(telemetryEnabled: boolean): TelemetryConfig {
  return {
    telemetryEnabled,
    clientId: process.env.EVENT_TRACKING_TELEMETRY_CLIENT_ID?.trim() || crypto.randomUUID(),
    decidedAt: new Date().toISOString(),
  };
}

function isInteractive(): boolean {
  return !!process.stdin.isTTY && !!process.stderr.isTTY;
}

async function promptForConsent(): Promise<boolean> {
  return new Promise(resolve => {
    process.stderr.write(
      '\nAllow event-tracking-skill to send anonymous usage telemetry? ' +
      'This includes the analyzed site hostname but never full URLs, paths, query strings, file paths, GTM/GA IDs, selectors, OAuth data, or raw errors. (yes/no): ',
    );
    const iface = readline.createInterface({ input: process.stdin, output: process.stderr });
    iface.question('', answer => {
      iface.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

async function getTelemetryConfig(): Promise<TelemetryConfig | null> {
  const doNotTrack = parseBooleanEnv(process.env.DO_NOT_TRACK);
  if (doNotTrack === true) return null;

  const forced = parseBooleanEnv(process.env.EVENT_TRACKING_TELEMETRY);
  if (forced !== null) {
    if (!forced) return null;
    const existing = readConfig();
    if (existing) {
      const config = { ...existing, telemetryEnabled: true };
      if (!existing.telemetryEnabled) writeConfig(config);
      return config;
    }
    const config = makeConfig(true);
    writeConfig(config);
    return config;
  }

  const existing = readConfig();
  if (existing) return existing.telemetryEnabled ? existing : null;

  if (!isInteractive()) return null;

  const enabled = await promptForConsent();
  const config = makeConfig(enabled);
  writeConfig(config);
  return enabled ? config : null;
}

async function resolveTelemetryConfig(): Promise<TelemetryConfig | null> {
  if (!consentPromise) {
    consentPromise = getTelemetryConfig();
  }
  return consentPromise;
}

function osFamily(): string {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') return 'linux';
  return 'other';
}

function cliVersion(): string {
  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(process.cwd(), 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch {
      // Try next candidate.
    }
  }
  return '0.0.0';
}

function sanitizeValue(value: TelemetryParamValue): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 100);
}

export function sanitizeTelemetryParams(params: TelemetryParams): Record<string, string | number> {
  const sanitized: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!ALLOWED_PARAM_NAMES.has(key)) continue;
    const sanitizedValue = sanitizeValue(value);
    if (sanitizedValue === null) continue;
    sanitized[key] = sanitizedValue;
    if (Object.keys(sanitized).length >= 25) break;
  }
  return sanitized;
}

export function buildTelemetryPayload(
  clientId: string,
  name: TelemetryEventName,
  params: TelemetryParams = {},
): TelemetryPayload {
  if (!ALLOWED_EVENTS.has(name)) {
    throw new Error(`Unsupported telemetry event: ${name}`);
  }
  return {
    client_id: clientId,
    events: [
      {
        name,
        params: sanitizeTelemetryParams({
          surface: 'cli',
          cli_version: cliVersion(),
          os_family: osFamily(),
          node_major: Number(process.versions.node.split('.')[0]),
          session_id: SESSION_ID,
          engagement_time_msec: 1,
          ...params,
        }),
      },
    ],
  };
}

export async function captureTelemetry(
  name: TelemetryEventName,
  params: TelemetryParams = {},
): Promise<void> {
  try {
    const config = await resolveTelemetryConfig();
    if (!config) return;

    const response = await fetch(getEndpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildTelemetryPayload(config.clientId, name, params)),
      signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
    });
    await response.arrayBuffer().catch(() => undefined);
  } catch {
    // Network, consent, and validation issues are intentionally non-blocking.
  }
}

export async function captureCommandCompleted(
  commandName: string,
  startedAt: number,
  status: 'success' | 'failure' | 'cancelled' | 'blocked',
  params: TelemetryParams = {},
): Promise<void> {
  await captureTelemetry('cli_command_completed', {
    ...params,
    command_name: commandName,
    status,
    duration_ms: Math.max(0, Date.now() - startedAt),
  });
}
