import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';

import {
  PageGroupsReview,
  SiteAnalysis,
  getPageGroupsReviewState,
  hasConfirmedPageGroups,
} from '../crawler/page-analyzer';

export const WORKFLOW_STATE_FILE = 'workflow-state.json';

const PUBLIC_COMMAND = process.env.EVENT_TRACKING_PUBLIC_CMD?.trim() || './event-tracking';

export type WorkflowCheckpoint =
  | 'analyzed'
  | 'grouped'
  | 'group_approved'
  | 'schema_prepared'
  | 'schema_present'
  | 'schema_approved'
  | 'spec_generated'
  | 'gtm_generated'
  | 'synced'
  | 'verified'
  | 'published';

export interface SchemaReviewState {
  status: 'pending' | 'confirmed';
  confirmedAt?: string;
  confirmedHash?: string;
}

export interface VerificationState {
  status: 'pending' | 'completed';
  verifiedAt?: string;
  reportFile?: string;
  resultFile?: string;
  totalExpected?: number;
  totalFired?: number;
}

export interface PublishState {
  status: 'pending' | 'completed';
  publishedAt?: string;
  versionId?: string;
  versionName?: string;
}

export interface WorkflowArtifacts {
  siteAnalysis: boolean;
  schemaContext: boolean;
  eventSchema: boolean;
  eventSpec: boolean;
  gtmConfig: boolean;
  gtmContext: boolean;
  credentials: boolean;
  previewReport: boolean;
  previewResult: boolean;
  shopifySchemaTemplate: boolean;
  shopifyBootstrapReview: boolean;
  shopifyCustomPixel: boolean;
  shopifyInstall: boolean;
}

export interface WorkflowState {
  version: 1;
  updatedAt: string;
  artifactDir: string;
  siteUrl?: string;
  platformType?: string;
  currentCheckpoint: WorkflowCheckpoint | 'not_started';
  completedCheckpoints: WorkflowCheckpoint[];
  nextAction: string;
  nextCommand?: string;
  warnings: string[];
  pageGroupsReview: PageGroupsReview;
  schemaReview: SchemaReviewState;
  verification: VerificationState;
  publish: PublishState;
  artifacts: WorkflowArtifacts;
}

export interface WorkflowStateUpdate {
  schemaReview?: Partial<SchemaReviewState>;
  verification?: Partial<VerificationState>;
  publish?: Partial<PublishState>;
}

interface WorkflowFiles {
  siteAnalysis: string;
  schemaContext: string;
  eventSchema: string;
  eventSpec: string;
  gtmConfig: string;
  gtmContext: string;
  credentials: string;
  previewReport: string;
  previewResult: string;
  shopifySchemaTemplate: string;
  shopifyBootstrapReview: string;
  shopifyCustomPixel: string;
  shopifyInstall: string;
  workflowState: string;
}

const PRIMARY_CHECKPOINTS: WorkflowCheckpoint[] = [
  'analyzed',
  'grouped',
  'group_approved',
  'schema_prepared',
  'schema_present',
  'schema_approved',
  'gtm_generated',
  'synced',
  'verified',
  'published',
];

const OPTIONAL_CHECKPOINTS: WorkflowCheckpoint[] = [
  'spec_generated',
];

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function formatPublicCommand(args: string[]): string {
  return [PUBLIC_COMMAND, ...args.map(quoteShellArg)].join(' ');
}

function getWorkflowFiles(artifactDir: string): WorkflowFiles {
  return {
    siteAnalysis: path.join(artifactDir, 'site-analysis.json'),
    schemaContext: path.join(artifactDir, 'schema-context.json'),
    eventSchema: path.join(artifactDir, 'event-schema.json'),
    eventSpec: path.join(artifactDir, 'event-spec.md'),
    gtmConfig: path.join(artifactDir, 'gtm-config.json'),
    gtmContext: path.join(artifactDir, 'gtm-context.json'),
    credentials: path.join(artifactDir, 'credentials.json'),
    previewReport: path.join(artifactDir, 'preview-report.md'),
    previewResult: path.join(artifactDir, 'preview-result.json'),
    shopifySchemaTemplate: path.join(artifactDir, 'shopify-schema-template.json'),
    shopifyBootstrapReview: path.join(artifactDir, 'shopify-bootstrap-review.md'),
    shopifyCustomPixel: path.join(artifactDir, 'shopify-custom-pixel.js'),
    shopifyInstall: path.join(artifactDir, 'shopify-install.md'),
    workflowState: path.join(artifactDir, WORKFLOW_STATE_FILE),
  };
}

function fileExists(file: string): boolean {
  return fs.existsSync(file);
}

function tryReadJsonFile<T>(file: string, warnings: string[], label: string): T | null {
  if (!fileExists(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    warnings.push(`${label} exists but could not be parsed: ${(error as Error).message}`);
    return null;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

export function getSchemaHash(schema: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(schema)).digest('hex');
}

export function resolveArtifactDirFromInput(input: string): string {
  const resolved = path.resolve(input);
  if (fileExists(resolved) && fs.statSync(resolved).isDirectory()) {
    return resolved;
  }
  return path.dirname(resolved);
}

function defaultPageGroupsReview(): PageGroupsReview {
  return { status: 'pending' };
}

function defaultSchemaReview(): SchemaReviewState {
  return { status: 'pending' };
}

function defaultVerification(): VerificationState {
  return { status: 'pending' };
}

function defaultPublish(): PublishState {
  return { status: 'pending' };
}

function mergeSchemaReview(previous?: SchemaReviewState, update?: Partial<SchemaReviewState>): SchemaReviewState {
  return {
    ...defaultSchemaReview(),
    ...(previous || {}),
    ...(update || {}),
  };
}

function mergeVerification(previous?: VerificationState, update?: Partial<VerificationState>): VerificationState {
  return {
    ...defaultVerification(),
    ...(previous || {}),
    ...(update || {}),
  };
}

function mergePublish(previous?: PublishState, update?: Partial<PublishState>): PublishState {
  return {
    ...defaultPublish(),
    ...(previous || {}),
    ...(update || {}),
  };
}

function getCurrentCheckpoint(completed: WorkflowCheckpoint[]): WorkflowCheckpoint | 'not_started' {
  for (let idx = PRIMARY_CHECKPOINTS.length - 1; idx >= 0; idx -= 1) {
    if (completed.includes(PRIMARY_CHECKPOINTS[idx])) {
      return PRIMARY_CHECKPOINTS[idx];
    }
  }
  return 'not_started';
}

function getNextAction(args: {
  files: WorkflowFiles;
  analysis: SiteAnalysis | null;
  hasGroupedPages: boolean;
  groupsConfirmed: boolean;
  schemaExists: boolean;
  schemaConfirmed: boolean;
  eventSpecExists: boolean;
  gtmConfigExists: boolean;
  gtmContextExists: boolean;
  previewComplete: boolean;
  publishComplete: boolean;
}): { nextAction: string; nextCommand?: string } {
  const {
    files,
    analysis,
    hasGroupedPages,
    groupsConfirmed,
    schemaExists,
    schemaConfirmed,
    eventSpecExists,
    gtmConfigExists,
    gtmContextExists,
    previewComplete,
    publishComplete,
  } = args;

  if (publishComplete) {
    return {
      nextAction: 'Workflow is complete for the current artifact directory.',
    };
  }

  if (gtmContextExists) {
    if (!previewComplete) {
      return {
        nextAction: 'Run verification before publishing.',
        nextCommand: formatPublicCommand(['preview', files.eventSchema, '--context-file', files.gtmContext]),
      };
    }
    return {
      nextAction: 'Publish the verified GTM workspace when ready.',
      nextCommand: formatPublicCommand(['publish', '--context-file', files.gtmContext, '--version-name', 'GA4 Events v1']),
    };
  }

  if (gtmConfigExists) {
    return {
      nextAction: 'Sync the GTM config to a workspace.',
      nextCommand: formatPublicCommand(['sync', files.gtmConfig]),
    };
  }

  if (schemaExists) {
    if (!schemaConfirmed) {
      return {
        nextAction: 'Confirm the current event schema before generating GTM config.',
        nextCommand: formatPublicCommand(['confirm-schema', files.eventSchema]),
      };
    }
    if (!eventSpecExists) {
      return {
        nextAction: 'Generate a human-readable event spec for review and handoff.',
        nextCommand: formatPublicCommand(['generate-spec', files.eventSchema]),
      };
    }
    return {
      nextAction: 'Generate GTM config from the approved schema.',
      nextCommand: formatPublicCommand(['generate-gtm', files.eventSchema, '--measurement-id', '<G-XXXXXXXXXX>']),
    };
  }

  if (!analysis) {
    return {
      nextAction: 'Start a new site run with analysis.',
      nextCommand: formatPublicCommand(['analyze', '<url>', '--output-root', '<output-root>']),
    };
  }

  if (!hasGroupedPages) {
    return {
      nextAction: 'Fill `pageGroups` in site-analysis.json, then confirm them.',
      nextCommand: formatPublicCommand(['confirm-page-groups', files.siteAnalysis]),
    };
  }

  if (!groupsConfirmed) {
    return {
      nextAction: 'Review and confirm the current page groups before schema preparation.',
      nextCommand: formatPublicCommand(['confirm-page-groups', files.siteAnalysis]),
    };
  }

  if (!fileExists(files.schemaContext)) {
    return {
      nextAction: 'Prepare compressed schema context from the approved site analysis.',
      nextCommand: formatPublicCommand(['prepare-schema', files.siteAnalysis]),
    };
  }

  if (!schemaExists) {
    return {
      nextAction: 'Author `event-schema.json` from `schema-context.json`, then validate it.',
      nextCommand: formatPublicCommand(['validate-schema', files.eventSchema, '--check-selectors']),
    };
  }

  return {
    nextAction: 'Start a new site run with analysis.',
    nextCommand: formatPublicCommand(['analyze', '<url>', '--output-root', '<output-root>']),
  };
}

export function buildWorkflowState(artifactDir: string, previousState?: WorkflowState | null): WorkflowState {
  const warnings: string[] = [];
  const files = getWorkflowFiles(artifactDir);

  const analysis = tryReadJsonFile<SiteAnalysis>(files.siteAnalysis, warnings, 'site-analysis.json');
  const schema = tryReadJsonFile<unknown>(files.eventSchema, warnings, 'event-schema.json');
  const previewResult = tryReadJsonFile<Record<string, unknown>>(files.previewResult, warnings, 'preview-result.json');

  const pageGroupsReview = analysis ? getPageGroupsReviewState(analysis) : defaultPageGroupsReview();
  const hasGroupedPages = !!analysis && analysis.pageGroups.length > 0;
  const groupsConfirmed = !!analysis && hasConfirmedPageGroups(analysis);

  const previousSchemaReview = previousState?.schemaReview;
  const schemaHash = schema ? getSchemaHash(schema) : undefined;
  let schemaReview = mergeSchemaReview(previousSchemaReview);
  if (!schemaHash) {
    schemaReview = defaultSchemaReview();
  } else if (schemaReview.status === 'confirmed' && schemaReview.confirmedHash === schemaHash) {
    schemaReview = {
      status: 'confirmed',
      confirmedAt: schemaReview.confirmedAt,
      confirmedHash: schemaReview.confirmedHash,
    };
  } else {
    if (schemaReview.status === 'confirmed' && schemaReview.confirmedHash && schemaReview.confirmedHash !== schemaHash) {
      warnings.push('event-schema.json changed after the last schema confirmation. Re-confirm the schema before GTM generation.');
    }
    schemaReview = defaultSchemaReview();
  }

  const previousVerification = previousState?.verification;
  let verification = mergeVerification(previousVerification);
  if (fileExists(files.previewReport) && fileExists(files.previewResult)) {
    verification = {
      ...verification,
      status: 'completed',
      reportFile: files.previewReport,
      resultFile: files.previewResult,
      verifiedAt: verification.verifiedAt
        || (typeof previewResult?.previewEndedAt === 'string' ? previewResult.previewEndedAt : undefined)
        || (typeof previewResult?.generatedAt === 'string' ? previewResult.generatedAt : undefined),
      totalExpected: typeof previewResult?.totalExpected === 'number' ? previewResult.totalExpected : verification.totalExpected,
      totalFired: typeof previewResult?.totalFired === 'number' ? previewResult.totalFired : verification.totalFired,
    };
  } else {
    verification = defaultVerification();
  }

  const publish = mergePublish(previousState?.publish);

  const artifacts: WorkflowArtifacts = {
    siteAnalysis: fileExists(files.siteAnalysis),
    schemaContext: fileExists(files.schemaContext),
    eventSchema: fileExists(files.eventSchema),
    eventSpec: fileExists(files.eventSpec),
    gtmConfig: fileExists(files.gtmConfig),
    gtmContext: fileExists(files.gtmContext),
    credentials: fileExists(files.credentials),
    previewReport: fileExists(files.previewReport),
    previewResult: fileExists(files.previewResult),
    shopifySchemaTemplate: fileExists(files.shopifySchemaTemplate),
    shopifyBootstrapReview: fileExists(files.shopifyBootstrapReview),
    shopifyCustomPixel: fileExists(files.shopifyCustomPixel),
    shopifyInstall: fileExists(files.shopifyInstall),
  };

  const completed: WorkflowCheckpoint[] = [];
  if (artifacts.siteAnalysis) completed.push('analyzed');
  if (hasGroupedPages) completed.push('grouped');
  if (groupsConfirmed) completed.push('group_approved');
  if (artifacts.schemaContext) completed.push('schema_prepared');
  if (artifacts.eventSchema) completed.push('schema_present');
  if (artifacts.eventSchema && schemaReview.status === 'confirmed') completed.push('schema_approved');
  if (artifacts.eventSpec && artifacts.eventSchema) completed.push('spec_generated');
  if (artifacts.gtmConfig) completed.push('gtm_generated');
  if (artifacts.gtmContext) completed.push('synced');
  if (verification.status === 'completed' && artifacts.gtmContext) completed.push('verified');
  if (publish.status === 'completed' && (verification.status === 'completed' || artifacts.gtmContext)) completed.push('published');

  if (!artifacts.siteAnalysis && (artifacts.eventSchema || artifacts.gtmConfig || artifacts.gtmContext)) {
    warnings.push('site-analysis.json is missing. Workflow state is being inferred from later-stage artifacts only.');
  }

  if (artifacts.schemaContext && !completed.includes('group_approved')) {
    warnings.push('schema-context.json exists, but page groups are not currently approved. Re-confirm page groups and rerun prepare-schema.');
  }
  if (artifacts.gtmConfig && !completed.includes('schema_approved')) {
    warnings.push('gtm-config.json exists, but the current event schema is not confirmed. Treat downstream GTM artifacts as stale until the schema is re-confirmed and GTM config is regenerated.');
  }
  if (artifacts.gtmContext && !completed.includes('gtm_generated')) {
    warnings.push('gtm-context.json exists without a valid current GTM config checkpoint. Re-run generate-gtm and sync before trusting downstream verification or publish state.');
  }

  const next = getNextAction({
    files,
    analysis,
    hasGroupedPages,
    groupsConfirmed,
    schemaExists: artifacts.eventSchema,
    schemaConfirmed: schemaReview.status === 'confirmed',
    eventSpecExists: artifacts.eventSpec,
    gtmConfigExists: artifacts.gtmConfig,
    gtmContextExists: artifacts.gtmContext,
    previewComplete: verification.status === 'completed',
    publishComplete: publish.status === 'completed',
  });

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    artifactDir,
    siteUrl: analysis?.rootUrl,
    platformType: analysis?.platform.type,
    currentCheckpoint: getCurrentCheckpoint(completed),
    completedCheckpoints: [
      ...PRIMARY_CHECKPOINTS.filter(checkpoint => completed.includes(checkpoint)),
      ...OPTIONAL_CHECKPOINTS.filter(checkpoint => completed.includes(checkpoint)),
    ],
    nextAction: next.nextAction,
    nextCommand: next.nextCommand,
    warnings,
    pageGroupsReview,
    schemaReview,
    verification,
    publish,
    artifacts,
  };
}

export function readWorkflowState(artifactDir: string): WorkflowState | null {
  const file = getWorkflowFiles(artifactDir).workflowState;
  if (!fileExists(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as WorkflowState;
  } catch {
    return null;
  }
}

export function refreshWorkflowState(artifactDir: string, update?: WorkflowStateUpdate): WorkflowState {
  const previousState = readWorkflowState(artifactDir);
  const mergedState: WorkflowState | null = previousState
    ? {
        ...previousState,
        schemaReview: mergeSchemaReview(previousState.schemaReview, update?.schemaReview),
        verification: mergeVerification(previousState.verification, update?.verification),
        publish: mergePublish(previousState.publish, update?.publish),
      }
    : null;

  const nextState = buildWorkflowState(artifactDir, mergedState);
  fs.writeFileSync(getWorkflowFiles(artifactDir).workflowState, JSON.stringify(nextState, null, 2));
  return nextState;
}
