import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

const DEFAULT_ENDPOINT = 'https://analytics-tracking-automation.jtracking.ai/collect';
const CONFIG_DIR = path.join(os.homedir(), '.config', 'analytics-tracking-automation');
const CONFIG_FILE = path.join(CONFIG_DIR, 'telemetry.json');
const TELEMETRY_TIMEOUT_MS = 800;
const SESSION_ID = crypto.randomUUID();
const TELEMETRY_CONSENT_MESSAGE =
  'To improve this skill, we can enable richer anonymous diagnostics beyond the minimal startup signal sent when a command begins. ' +
  'These diagnostics are only used for product optimization and reliability, and do not include sensitive page content or sensitive business data. ' +
  'We do not send full URLs, page paths, query strings, file paths, GTM/GA IDs, selectors, OAuth data, raw errors, or page content. ' +
  'We do send the site hostname and high-level workflow metadata, which may reveal the domain you worked on. ' +
  'If you choose yes, we save that choice in local config and continue with diagnostics enabled for future runs unless you change it. ' +
  'If you choose no, we save that choice in local config and continue the workflow without these richer diagnostics. ' +
  'The minimal startup signal remains enabled either way. You can decline and continue using the tool.';

const ALLOWED_EVENTS = new Set([
  'init_skill',
  'site_analyzed',
  'page_groups_confirmed',
  'live_gtm_analyzed',
  'live_gtm_verified',
  'schema_validated',
  'schema_context_prepared',
  'schema_confirmed',
  'gtm_config_generated',
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
  | 'init_skill'
  | 'site_analyzed'
  | 'page_groups_confirmed'
  | 'live_gtm_analyzed'
  | 'live_gtm_verified'
  | 'schema_validated'
  | 'schema_context_prepared'
  | 'schema_confirmed'
  | 'gtm_config_generated'
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

export interface TelemetryConsentStatus {
  status: 'enabled' | 'disabled' | 'undecided';
  source: 'config' | 'missing_config' | 'invalid_config';
  configFile: string;
}

let consentPromise: Promise<TelemetryConfig | null> | null = null;

function getConfigFile(): string {
  return process.env.EVENT_TRACKING_TELEMETRY_CONFIG_FILE?.trim() || CONFIG_FILE;
}

function getEndpoint(): string {
  return process.env.EVENT_TRACKING_TELEMETRY_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
}

function configFileExists(): boolean {
  return fs.existsSync(getConfigFile());
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
    clientId: crypto.randomUUID(),
    decidedAt: new Date().toISOString(),
  };
}

function isInteractive(): boolean {
  return !!process.stdin.isTTY && !!process.stderr.isTTY;
}

async function promptForConsent(): Promise<boolean> {
  return new Promise(resolve => {
    process.stderr.write(
      `\n${TELEMETRY_CONSENT_MESSAGE} (yes/no): `,
    );
    const iface = readline.createInterface({ input: process.stdin, output: process.stderr });
    iface.question('', answer => {
      iface.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

export function getTelemetryConsentMessage(): string {
  return TELEMETRY_CONSENT_MESSAGE;
}

export function getTelemetryConsentStatus(): TelemetryConsentStatus {
  const configFile = getConfigFile();
  const existing = readConfig();
  if (existing) {
    return {
      status: existing.telemetryEnabled ? 'enabled' : 'disabled',
      source: 'config',
      configFile,
    };
  }

  return {
    status: 'undecided',
    source: configFileExists() ? 'invalid_config' : 'missing_config',
    configFile,
  };
}

export async function ensureTelemetryConsentGate(): Promise<TelemetryConfig | null> {
  const status = getTelemetryConsentStatus();
  if (status.status !== 'undecided') {
    const existing = readConfig();
    if (existing) return existing.telemetryEnabled ? existing : null;
    if (status.status === 'enabled') {
      const config = makeConfig(true);
      writeConfig(config);
      return config;
    }
    return null;
  }

  if (!isInteractive()) {
    throw new Error(
      `User consent is required before starting this workflow because ${status.configFile} ` +
      `${status.source === 'invalid_config' ? 'is invalid' : 'does not exist'}. ` +
      'Run this command in an interactive terminal and answer the diagnostics consent prompt. ' +
      `The prompt says: "${TELEMETRY_CONSENT_MESSAGE}"`,
    );
  }

  const enabled = await promptForConsent();
  const config = makeConfig(enabled);
  writeConfig(config);
  return enabled ? config : null;
}

async function getTelemetryConfig(): Promise<TelemetryConfig | null> {
  const existing = readConfig();
  if (existing) return existing.telemetryEnabled ? existing : null;

  return null;
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

async function postTelemetryPayload(payload: TelemetryPayload): Promise<void> {
  const response = await fetch(getEndpoint(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
  });
  await response.arrayBuffer().catch(() => undefined);
}

export async function captureSkillInit(commandName: string): Promise<void> {
  try {
    const config = readConfig();
    const clientId = config?.clientId || SESSION_ID;
    await postTelemetryPayload(buildTelemetryPayload(clientId, 'init_skill', {
      command_name: commandName,
    }));
  } catch {
    // Network and validation issues are intentionally non-blocking.
  }
}

export async function captureTelemetry(
  name: TelemetryEventName,
  params: TelemetryParams = {},
): Promise<void> {
  try {
    const config = await resolveTelemetryConfig();
    if (!config) return;
    await postTelemetryPayload(buildTelemetryPayload(config.clientId, name, params));
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
