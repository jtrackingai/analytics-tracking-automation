#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import {
  analyzeSite,
  SiteAnalysis,
  CRAWL_MAX_PARTIAL_URLS,
  getPageGroupsHash,
  getPageGroupsReviewState,
  hasConfirmedPageGroups,
} from './crawler/page-analyzer';
import { EventSchema } from './generator/event-schema';
import { generateGTMConfig, GTMContainerExport } from './generator/gtm-config';
import { getAuthClient, clearCredentials } from './gtm/auth';
import { GTMClient, GTMAccount, GTMContainer, GTMWorkspace } from './gtm/client';
import { syncConfigToWorkspace, dryRunSync } from './gtm/sync';
import { validateEventSchema, getQuotaSummary } from './generator/schema-validator';
import { buildSchemaContext } from './generator/schema-context';
import { buildExistingTrackingBaseline, compareSchemaToLiveTracking } from './generator/live-tracking-insights';
import { checkSelectors } from './generator/selector-check';
import { runPreviewVerification, checkGTMOnPage } from './gtm/preview';
import { generatePreviewReport } from './reporter/preview-report';
import { generateTrackingPlanComparisonReport } from './reporter/tracking-plan-comparison';
import { TRACKING_HEALTH_REPORT_FILE, writeTrackingHealthReportMarkdown } from './reporter/tracking-health-report';
import { analyzeLiveGtmContainers, generateLiveGtmReviewMarkdown, LiveGtmAnalysis } from './gtm/live-parser';
import { isShopifyPlatform } from './crawler/platform-detector';
import { generateShopifyPixelArtifacts } from './shopify/pixel';
import { buildShopifyBootstrapArtifacts } from './shopify/schema-template';
import {
  WORKFLOW_STATE_FILE,
  WorkflowState,
  getSchemaHash,
  readWorkflowState,
  refreshWorkflowState,
  resolveArtifactDirFromInput,
} from './workflow/state';
import {
  RUN_CONTEXT_FILE,
  RUN_INDEX_FILE,
  readRunIndex,
  updateRunIndexFromState,
  upsertRunContext,
} from './workflow/run-index';
import { recordSchemaConfirmationAudit } from './workflow/schema-audit';
import {
  TRACKING_HEALTH_FILE,
  TRACKING_HEALTH_HISTORY_DIR,
  TrackingHealthReport,
  buildManualTrackingHealthReport,
  buildTrackingHealthReport,
  formatTrackingHealthScore,
  hasBlockingTrackingHealth,
  readTrackingHealthReport,
  writeTrackingHealthHistory,
  writeTrackingHealthReport,
} from './reporter/tracking-health';

const program = new Command();

// ─── Helpers ────────────────────────────────────────────────────────────────

const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), 'output');
const PUBLIC_COMMAND = process.env.EVENT_TRACKING_PUBLIC_CMD?.trim() || 'event-tracking';

interface AnalyzeOutputLocation {
  artifactDir: string;
  outputRoot: string;
}

function slugifyPathSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function suggestedOutputDir(url: string): string {
  try {
    const parsed = new URL(url);
    const host = slugifyPathSegment(parsed.hostname);
    const pathname = parsed.pathname === '/' ? '' : slugifyPathSegment(parsed.pathname);
    const dirName = pathname ? `${host}_${pathname}` : host;
    return dirName || 'my-event-run';
  } catch {
    return 'my-event-run';
  }
}

function resolveOutputDir(outputDir: string): string {
  const dir = path.resolve(outputDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveOutputRoot(outputRoot: string): string {
  return path.resolve(outputRoot);
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function formatPublicCommand(args: string[]): string {
  return [PUBLIC_COMMAND, ...args.map(quoteShellArg)].join(' ');
}

function rl(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

async function prompt(question: string): Promise<string> {
  return new Promise(resolve => {
    const iface = rl();
    iface.question(question, answer => {
      iface.close();
      resolve(answer.trim());
    });
  });
}

async function promptRequired(question: string, emptyMessage: string): Promise<string> {
  while (true) {
    const answer = await prompt(question);
    if (answer) return answer;
    console.log(`\n⚠️  ${emptyMessage}`);
  }
}

function getCliVersion(): string {
  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(process.cwd(), 'package.json'),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = readJsonFile<{ version?: string }>(candidate);
      if (parsed.version) return parsed.version;
    } catch {
      // ignore and try the next candidate
    }
  }

  return '0.0.0';
}

async function requireAnalyzeOutputDir(
  url: string,
  explicitOutputRoot?: string,
  explicitOutputDir?: string,
): Promise<AnalyzeOutputLocation> {
  const providedDir = explicitOutputDir?.trim();
  const providedRoot = explicitOutputRoot?.trim();

  if (providedDir && providedRoot) {
    throw new Error('Use either --output-root or --output-dir, not both.');
  }

  if (providedDir) {
    const artifactDir = resolveOutputDir(providedDir);
    return {
      artifactDir,
      outputRoot: path.dirname(artifactDir),
    };
  }

  const outputRoot = providedRoot
    ? resolveOutputRoot(providedRoot)
    : resolveOutputRoot(await promptRequired(
      `\nEnter output root directory for analyzed URLs (e.g. ${DEFAULT_OUTPUT_ROOT}): `,
      'Output root is required before analysis can start.',
    ));
  const artifactDir = path.join(outputRoot, suggestedOutputDir(url));
  console.log(`\n📁 Output root: ${outputRoot}`);
  console.log(`📁 Artifact directory for this URL: ${artifactDir}`);
  return {
    artifactDir: resolveOutputDir(artifactDir),
    outputRoot,
  };
}

function resolveArtifactDirFromFile(file: string): string {
  return path.dirname(path.resolve(file));
}

function normalizeTrackingId(id: string | undefined): string | undefined {
  const trimmed = id?.trim();
  if (!trimmed) return undefined;
  return trimmed.toUpperCase();
}

function readJsonFile<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

function tryReadJsonFile<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  return readJsonFile<T>(file);
}

function writeJsonFile(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function refreshAndIndexWorkflowState(
  artifactDir: string,
  update?: Parameters<typeof refreshWorkflowState>[1],
  runContext?: { outputRoot?: string; siteUrl?: string },
): WorkflowState {
  upsertRunContext({
    artifactDir,
    outputRoot: runContext?.outputRoot,
    siteUrl: runContext?.siteUrl,
  });
  const workflowState = refreshWorkflowState(artifactDir, update);
  updateRunIndexFromState(workflowState);
  return workflowState;
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseCommaSeparatedList(value?: string): string[] {
  return uniq(
    (value || '')
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean),
  );
}

function printPageGroupsSummary(pageGroups: SiteAnalysis['pageGroups']): void {
  console.log('\n📋 Current page groups:');
  pageGroups.forEach((group, idx) => {
    const pattern = group.urlPattern || '(all pages)';
    const label = group.displayName || group.name;
    console.log(`   [${idx + 1}] ${label} | ${group.contentType} | ${pattern} | ${group.urls.length} page(s)`);
    console.log(`       URLs: ${group.urls.join(', ')}`);
  });
}

function writeShopifyPreviewInstructions(
  dir: string,
  siteAnalysis: SiteAnalysis,
  gtmPublicId: string,
): { reportFile: string; jsonFile: string } {
  const reportFile = path.join(dir, 'preview-report.md');
  const jsonFile = path.join(dir, 'preview-result.json');
  const pixelFile = path.join(dir, 'shopify-custom-pixel.js');
  const installFile = path.join(dir, 'shopify-install.md');

  const lines = [
    '# Shopify Preview Instructions',
    '',
    `**Site:** ${siteAnalysis.rootUrl}`,
    `**Detected Platform:** Shopify (${siteAnalysis.platform.confidence})`,
    `**GTM Container:** ${gtmPublicId || 'UNKNOWN'}`,
    '',
    '## Why Automated Preview Is Skipped',
    '',
    '- Shopify custom pixels run in a sandboxed environment.',
    '- The current CLI preview flow assumes a browser page with a directly installed GTM container.',
    '- For Shopify sites, validate after the custom pixel is installed and connected in Shopify Admin.',
    `- If Tag Assistant says \`Google Tag / ${gtmPublicId || 'GTM container'} not found\` on the storefront page, that is expected when GTM is installed only through Shopify Customer Events.`,
    '',
    '## Next Steps',
    '',
    `1. Install [shopify-custom-pixel.js](${pixelFile}) in Shopify Admin -> Settings -> Customer events -> Add custom pixel.`,
    `2. Follow [shopify-install.md](${installFile}) to save and connect the pixel.`,
    '3. If you need GTM to be detectable on storefront pages or need DOM-based GTM triggers, also install the optional theme snippet from the install guide.',
    '4. Publish the GTM workspace once the pixel is connected.',
    '5. Validate with GA4 Realtime and Shopify pixel debugging tools by exercising product, search, cart, and checkout flows.',
    '',
    '## Notes',
    '',
    '- Prefer dataLayer-driven custom event triggers for Shopify ecommerce events.',
    '- DOM click triggers on storefront pages are not the primary validation path in this Shopify flow unless you also install GTM into the Shopify theme.',
  ];

  fs.writeFileSync(reportFile, lines.join('\n'));
  fs.writeFileSync(jsonFile, JSON.stringify({
    mode: 'manual_shopify_verification',
    siteUrl: siteAnalysis.rootUrl,
    platform: siteAnalysis.platform,
    gtmContainerId: gtmPublicId || 'UNKNOWN',
    generatedAt: new Date().toISOString(),
  }, null, 2));

  return { reportFile, jsonFile };
}

function getSelectorCheckableEvents(schema: EventSchema) {
  return schema.events.filter(event =>
    (event.triggerType === 'click' || event.triggerType === 'form_submit') &&
    !!event.elementSelector,
  );
}

function printShopifyBootstrapSummary(reviewItems: Array<{
  eventName: string;
  recommendation: 'keep' | 'review' | 'remove';
}>): void {
  const groups = {
    keep: reviewItems.filter(item => item.recommendation === 'keep'),
    review: reviewItems.filter(item => item.recommendation === 'review'),
    remove: reviewItems.filter(item => item.recommendation === 'remove'),
  };

  console.log(`\n🛍️  Shopify bootstrap summary:`);
  console.log(`   Keep (${groups.keep.length}): ${groups.keep.map(item => item.eventName).join(', ') || '—'}`);
  console.log(`   Review (${groups.review.length}): ${groups.review.map(item => item.eventName).join(', ') || '—'}`);
  console.log(`   Remove (${groups.remove.length}): ${groups.remove.map(item => item.eventName).join(', ') || '—'}`);
}

async function selectFromList<T extends { name?: string; publicId?: string }>(
  items: T[],
  label: string,
  displayFn: (item: T, idx: number) => string
): Promise<T> {
  console.log(`\nAvailable ${label}s:`);
  items.forEach((item, idx) => {
    console.log(`  [${idx + 1}] ${displayFn(item, idx)}`);
  });

  const answer = await prompt(`\nSelect ${label} (1-${items.length}): `);
  const idx = parseInt(answer) - 1;
  if (isNaN(idx) || idx < 0 || idx >= items.length) {
    throw new Error(`Invalid selection: ${answer}`);
  }
  return items[idx];
}

function getRequiredLiveGtmIds(analysis: SiteAnalysis, override?: string): string[] {
  const fromOverride = parseCommaSeparatedList(override).map(id => id.toUpperCase());
  if (fromOverride.length > 0) return fromOverride;
  return uniq((analysis.gtmPublicIds || []).map(id => id.toUpperCase()));
}

function getTrackingHealthFile(artifactDir: string): string {
  return path.join(artifactDir, TRACKING_HEALTH_FILE);
}

function evaluatePublishReadiness(artifactDir: string): {
  blocking: boolean;
  messages: string[];
  health: TrackingHealthReport | null;
} {
  const healthFile = getTrackingHealthFile(artifactDir);
  const previewResultFile = path.join(artifactDir, 'preview-result.json');
  const health = readTrackingHealthReport(healthFile);

  if (!health) {
    return {
      blocking: true,
      messages: [
        fs.existsSync(previewResultFile)
          ? `Missing ${TRACKING_HEALTH_FILE}. Re-run preview before publishing.`
          : 'No preview verification found. Run preview before publishing.',
      ],
      health: null,
    };
  }

  const blocking = hasBlockingTrackingHealth(health);
  const messages = [...health.blockers];

  if (blocking && messages.length === 0) {
    messages.push(
      `Tracking health is ${health.grade} (${formatTrackingHealthScore(health.score)}). ` +
      'Review preview-report.md and re-run preview before publishing.',
    );
  } else if (!blocking && health.grade === 'warning') {
    messages.push(
      `Tracking health is warning (${formatTrackingHealthScore(health.score)}). ` +
      'Review preview-report.md before publishing.',
    );
  }

  return { blocking, messages, health };
}

// ─── Commands ────────────────────────────────────────────────────────────────

program
  .name('event-tracking')
  .description('Automated web event tracking setup with GA4 + GTM')
  .version(getCliVersion());

// STEP 1: Analyze website
program
  .command('analyze <url>')
  .description('Crawl website and analyze page structure')
  .option(
    '--output-root <dir>',
    'Root directory under which this URL gets its own artifact folder; the CLI prompts if omitted',
  )
  .option(
    '--output-dir <dir>',
    'Deprecated exact artifact directory override',
  )
  .option(
    '--storefront-password <password>',
    'Optional Shopify storefront password for password-protected dev stores',
  )
  .option(
    '--urls <urls>',
    `Partial mode: comma-separated list of specific URLs to analyze (max ${CRAWL_MAX_PARTIAL_URLS}). ` +
    'All URLs must belong to the same domain as <url>.',
  )
  .action(async (url: string, opts: { urls?: string; outputRoot?: string; outputDir?: string; storefrontPassword?: string }) => {
    const isPartial = !!opts.urls;
    const partialUrls = opts.urls
      ? opts.urls.split(',').map(u => u.trim()).filter(Boolean)
      : [];
    const storefrontPassword = opts.storefrontPassword?.trim() || process.env.SHOPIFY_STOREFRONT_PASSWORD?.trim();
    const outputLocation = await requireAnalyzeOutputDir(url, opts.outputRoot, opts.outputDir);
    const dir = outputLocation.artifactDir;

    console.log(`\n🔍 Analyzing site: ${url}`);
    console.log(`   Artifact directory: ${dir}`);
    if (isPartial) {
      console.log(`   Mode: partial (${partialUrls.length} URL${partialUrls.length !== 1 ? 's' : ''})`);
    } else {
      console.log(`   Mode: full site`);
    }
    if (storefrontPassword) {
      console.log(`   Shopify storefront password: provided`);
    }

    let siteAnalysis: SiteAnalysis;
    try {
      siteAnalysis = await analyzeSite(
        url,
        isPartial
          ? { mode: 'partial', urls: partialUrls, storefrontPassword }
          : { mode: 'full', storefrontPassword },
      );
    } catch (err) {
      console.error(`\n❌ ${(err as Error).message}`);
      process.exit(1);
    }

    const outFile = path.join(dir, 'site-analysis.json');
    writeJsonFile(outFile, siteAnalysis);
    const workflowState = refreshAndIndexWorkflowState(dir, undefined, {
      outputRoot: outputLocation.outputRoot,
      siteUrl: siteAnalysis.rootUrl,
    });

    console.log(`\n✅ Analysis complete:`);
    console.log(`   Pages analyzed: ${siteAnalysis.pages.length}`);
    console.log(`   Discovered URLs: ${siteAnalysis.discoveredUrls.length}`);
    console.log(`   Skipped URLs: ${siteAnalysis.skippedUrls.length}`);
    console.log(`   Platform: ${siteAnalysis.platform.type} (${siteAnalysis.platform.confidence})`);
    if (siteAnalysis.platform.signals.length > 0) {
      console.log(`   Platform signals: ${siteAnalysis.platform.signals.join(', ')}`);
    }
    if ((siteAnalysis.gtmPublicIds || []).length > 0) {
      console.log(`   Live GTM containers: ${(siteAnalysis.gtmPublicIds || []).join(', ')}`);
    }

    if (siteAnalysis.crawlWarnings.length > 0) {
      console.log(`\n⚠️  Warnings:`);
      for (const w of siteAnalysis.crawlWarnings) {
        console.log(`   ${w}`);
      }
    }

    console.log(`\n   Output: ${outFile}`);
    console.log(`   Workflow state: ${path.join(dir, WORKFLOW_STATE_FILE)}`);
    if (workflowState.nextCommand) {
      console.log(`   Next step: ${workflowState.nextCommand}`);
    }
  });

// STEP 1.5: Confirm page groups before schema preparation
program
  .command('confirm-page-groups <site-analysis-file>')
  .description('Confirm the current page groups in site-analysis.json before schema preparation')
  .option('--yes', 'Skip confirmation prompt and mark the current page groups as approved')
  .action(async (analysisFile: string, opts: { yes?: boolean }) => {
    const resolvedFile = path.resolve(analysisFile);
    const analysis = readJsonFile<SiteAnalysis>(resolvedFile);

    if (analysis.pageGroups.length === 0) {
      console.error('\n❌ pageGroups is empty. Fill pageGroups in site-analysis.json before confirming them.');
      process.exit(1);
    }

    printPageGroupsSummary(analysis.pageGroups);

    const existingReview = getPageGroupsReviewState(analysis);
    const currentHash = getPageGroupsHash(analysis.pageGroups);
    if (existingReview.status === 'confirmed' && existingReview.confirmedHash === currentHash) {
      console.log(`\nℹ️  These page groups are already confirmed${existingReview.confirmedAt ? ` (${existingReview.confirmedAt})` : ''}.`);
    }

    if (!opts.yes) {
      const answer = await prompt('\nConfirm these page groups for schema preparation? (yes/no): ');
      if (answer.toLowerCase() !== 'yes') {
        console.log('Page-group confirmation cancelled.');
        return;
      }
    }

    analysis.pageGroupsReview = {
      status: 'confirmed',
      confirmedAt: new Date().toISOString(),
      confirmedHash: currentHash,
    };
    writeJsonFile(resolvedFile, analysis);
    const workflowState = refreshAndIndexWorkflowState(resolveArtifactDirFromFile(resolvedFile));

    console.log(`\n✅ Page groups confirmed.`);
    console.log(`   Confirmation recorded in: ${resolvedFile}`);
    if (workflowState.nextCommand) {
      console.log(`   Next step: ${workflowState.nextCommand}`);
    }
  });

program
  .command('analyze-live-gtm <site-analysis-file>')
  .description('Fetch and analyze the public live GTM runtime before schema generation')
  .option('--gtm-id <ids>', 'Comma-separated GTM public IDs to analyze instead of the IDs detected during crawl')
  .option('--primary-container-id <id>', 'Primary live GTM container to use as the schema comparison baseline')
  .action(async (analysisFile: string, opts: { gtmId?: string; primaryContainerId?: string }) => {
    const resolvedFile = path.resolve(analysisFile);
    const analysis = readJsonFile<SiteAnalysis>(resolvedFile);
    const publicIds = getRequiredLiveGtmIds(analysis, opts.gtmId);

    if (publicIds.length === 0) {
      console.error('\n❌ No live GTM public IDs were found.');
      console.error('   Re-run `analyze` on the site, or pass one explicitly with --gtm-id GTM-XXXXXXX.');
      process.exit(1);
    }

    console.log(`\n🔍 Analyzing live GTM baseline for: ${analysis.rootUrl}`);
    console.log(`   Containers: ${publicIds.join(', ')}`);

    const liveAnalysis = await analyzeLiveGtmContainers({
      siteUrl: analysis.rootUrl,
      publicIds,
    });

    const meaningfulContainers = liveAnalysis.containers.filter(container =>
      container.events.length > 0 || container.measurementIds.length > 0,
    );
    const requestedPrimaryId = opts.primaryContainerId?.trim().toUpperCase();

    if (requestedPrimaryId) {
      if (!liveAnalysis.containers.some(container => container.publicId === requestedPrimaryId)) {
        console.error(`\n❌ Primary container ${requestedPrimaryId} was not part of the analyzed set.`);
        process.exit(1);
      }
      liveAnalysis.primaryContainerId = requestedPrimaryId;
    } else if (meaningfulContainers.length > 1) {
      const selected = await selectFromList(
        meaningfulContainers,
        'primary comparison GTM container',
        container => `${container.publicId} (${container.events.length} events, ${container.measurementIds.join(', ') || 'no measurement IDs'})`,
      );
      liveAnalysis.primaryContainerId = selected.publicId;
    } else if (meaningfulContainers.length === 1) {
      liveAnalysis.primaryContainerId = meaningfulContainers[0].publicId;
    }

    const artifactDir = path.dirname(resolvedFile);
    const outFile = path.join(artifactDir, 'live-gtm-analysis.json');
    const reviewFile = path.join(artifactDir, 'live-gtm-review.md');
    writeJsonFile(outFile, liveAnalysis);
    fs.writeFileSync(reviewFile, generateLiveGtmReviewMarkdown(liveAnalysis), 'utf8');
    const workflowState = refreshAndIndexWorkflowState(artifactDir);

    console.log(`\n✅ Live GTM baseline analyzed:`);
    console.log(`   Containers analyzed: ${liveAnalysis.containers.length}`);
    console.log(`   Primary comparison container: ${liveAnalysis.primaryContainerId || 'none'}`);
    console.log(`   Aggregated live events: ${liveAnalysis.aggregatedEvents.length}`);
    console.log(`   Output: ${outFile}`);
    console.log(`   Review: ${reviewFile}`);
    console.log(`   Workflow state: ${path.join(artifactDir, WORKFLOW_STATE_FILE)}`);
    if (workflowState.nextCommand) {
      console.log(`   Next step: ${workflowState.nextCommand}`);
    }
  });

// STEP 2: Event schema is generated by the AI agent directly (no CLI command).
// The agent reads site-analysis.json and writes event-schema.json based on
// GA4 guidelines — see SKILL.md Step 2.

// STEP 2.5: Validate event schema
program
  .command('validate-schema <schema-file>')
  .description('Validate event-schema.json before GTM config generation')
  .option('--check-selectors', 'Launch browser and verify CSS selectors match real DOM elements')
  .option(
    '--storefront-password <password>',
    'Optional Shopify storefront password for selector checking on password-protected dev stores',
  )
  .action(async (schemaFile: string, opts: { checkSelectors?: boolean; storefrontPassword?: string }) => {
    const schema = readJsonFile<EventSchema>(schemaFile);
    const issues = validateEventSchema(schema);
    const storefrontPassword = opts.storefrontPassword?.trim() || process.env.SHOPIFY_STOREFRONT_PASSWORD?.trim();

    const errs = issues.filter(i => i.severity === 'error');
    const warns = issues.filter(i => i.severity === 'warning');

    if (errs.length > 0) {
      console.log(`\n❌ ${errs.length} error(s):`);
      for (const e of errs) console.log(`   [${e.field}] ${e.message}`);
    }
    if (warns.length > 0) {
      console.log(`\n⚠️  ${warns.length} warning(s):`);
      for (const w of warns) console.log(`   [${w.field}] ${w.message}`);
    }
    if (issues.length === 0 && !opts.checkSelectors) {
      console.log(`\n✅ Schema is valid (${schema.events.length} events)`);
    }

    if (opts.checkSelectors) {
      const analysisFile = path.join(path.dirname(schemaFile), 'site-analysis.json');
      if (!fs.existsSync(analysisFile)) {
        console.error(`\n❌ Cannot find ${analysisFile} for selector checking.`);
        process.exit(1);
      }
      const analysis = readJsonFile<SiteAnalysis>(analysisFile);
      const selectorCheckableEvents = getSelectorCheckableEvents(schema);
      const shopifyCustomEvents = isShopifyPlatform(analysis.platform)
        ? schema.events.filter(event => event.triggerType === 'custom')
        : [];

      if (isShopifyPlatform(analysis.platform) && shopifyCustomEvents.length > 0) {
        console.log(`\n🛍️  Shopify custom events are skipped during selector checking.`);
        console.log(`   These events are validated after installing the generated Shopify custom pixel:`);
        console.log(`   ${shopifyCustomEvents.map(event => event.eventName).join(', ')}`);
      }

      if (selectorCheckableEvents.length === 0) {
        if (isShopifyPlatform(analysis.platform)) {
          console.log(`\nℹ️  No selector-based events to check on this Shopify schema.`);
        }
      } else {
        console.log(`\n🔍 Checking selectors against live DOM...`);
      }
      const results = selectorCheckableEvents.length > 0
        ? await checkSelectors(schema.events, analysis, storefrontPassword)
        : [];

      const failed = results.filter(r => !r.matched);
      const passed = results.filter(r => r.matched);

      if (passed.length > 0) {
        console.log(`\n✅ ${passed.length} selector(s) matched:`);
        for (const r of passed) console.log(`   ${r.eventName}: ${r.selector} (${r.matchCount} match${r.matchCount > 1 ? 'es' : ''})`);
      }
      if (failed.length > 0) {
        console.log(`\n❌ ${failed.length} selector(s) did NOT match any element:`);
        for (const r of failed) console.log(`   ${r.eventName}: ${r.selector} (on ${r.pageUrl})`);
      }
      if (results.length > 0 && failed.length === 0) {
        console.log(`\n✅ All ${results.length} selectors verified.`);
      } else if (results.length === 0 && selectorCheckableEvents.length === 0 && errs.length === 0) {
        console.log(`\n✅ No selector-based events required DOM verification.`);
      }
    }

    if (errs.length > 0) process.exit(1);
  });

program
  .command('confirm-schema <schema-file>')
  .description('Confirm the current event-schema.json before GTM config generation')
  .option('--yes', 'Skip confirmation prompt and mark the current schema as approved')
  .action(async (schemaFile: string, opts: { yes?: boolean }) => {
    const resolvedFile = path.resolve(schemaFile);
    const schema = readJsonFile<EventSchema>(resolvedFile);
    const issues = validateEventSchema(schema);
    const errs = issues.filter(issue => issue.severity === 'error');
    const warns = issues.filter(issue => issue.severity === 'warning');

    if (warns.length > 0) {
      console.log(`\n⚠️  Schema warnings:`);
      for (const warning of warns) console.log(`   [${warning.field}] ${warning.message}`);
    }
    if (errs.length > 0) {
      console.log(`\n❌ Schema validation failed (${errs.length} error(s)):`);
      for (const error of errs) console.log(`   [${error.field}] ${error.message}`);
      console.log(`\nFix the errors in ${resolvedFile} before confirming the schema.`);
      process.exit(1);
    }

    const artifactDir = resolveArtifactDirFromFile(resolvedFile);
    const currentHash = getSchemaHash(schema);
    const previousWorkflowState = readWorkflowState(artifactDir);
    const previousConfirmedHash = previousWorkflowState?.schemaReview.confirmedHash;
    const existingState = refreshAndIndexWorkflowState(artifactDir);
    const quota = getQuotaSummary(schema);

    console.log(`\n📋 Schema review summary:`);
    console.log(`   Events: ${schema.events.length}`);
    console.log(`   Custom dimensions: ${quota.customDimensions}`);
    console.log(`   Artifact directory: ${artifactDir}`);

    if (
      existingState.schemaReview.status === 'confirmed' &&
      existingState.schemaReview.confirmedHash === currentHash
    ) {
      console.log(`\nℹ️  This schema is already confirmed${existingState.schemaReview.confirmedAt ? ` (${existingState.schemaReview.confirmedAt})` : ''}.`);
      return;
    }

    if (!opts.yes) {
      const answer = await prompt('\nConfirm this schema for GTM generation? (yes/no): ');
      if (answer.toLowerCase() !== 'yes') {
        console.log('Schema confirmation cancelled.');
        return;
      }
    }

    const schemaAudit = recordSchemaConfirmationAudit({
      artifactDir,
      schemaFile: resolvedFile,
      schema,
      previousConfirmedHash,
    });
    const workflowState = refreshAndIndexWorkflowState(artifactDir, {
      schemaReview: {
        status: 'confirmed',
        confirmedAt: new Date().toISOString(),
        confirmedHash: currentHash,
      },
    });

    console.log(`\n✅ Schema confirmed.`);
    console.log(`   Restore snapshot: ${schemaAudit.restoreFile}`);
    console.log(`   Decision audit: ${schemaAudit.auditFile}`);
    if (schemaAudit.entry.summary.added.length || schemaAudit.entry.summary.changed.length || schemaAudit.entry.summary.removed.length) {
      console.log(
        `   Schema delta: ${schemaAudit.entry.summary.added.length} added, ` +
        `${schemaAudit.entry.summary.changed.length} changed, ` +
        `${schemaAudit.entry.summary.removed.length} removed`,
      );
    }
    console.log(`   Workflow state: ${path.join(artifactDir, WORKFLOW_STATE_FILE)}`);
    if (!workflowState.artifacts.eventSpec) {
      console.log(`   Recommended next step: ${formatPublicCommand(['generate-spec', resolvedFile])}`);
    }
    console.log(`   Next step: ${formatPublicCommand(['generate-gtm', resolvedFile, '--measurement-id', '<G-XXXXXXXXXX>'])}`);
  });

// STEP 2.1: Prepare compressed context for AI event schema generation
program
  .command('prepare-schema <site-analysis-file>')
  .description('Compress site-analysis.json into a smaller schema-context.json for AI event generation')
  .action(async (analysisFile: string) => {
    const resolvedFile = path.resolve(analysisFile);
    const analysis = readJsonFile<SiteAnalysis>(resolvedFile);
    const artifactDir = path.dirname(resolvedFile);
    const requiredLiveGtmIds = getRequiredLiveGtmIds(analysis);
    let liveAnalysis: LiveGtmAnalysis | null = null;

    if (analysis.pageGroups.length === 0) {
      console.error('\n❌ pageGroups is empty. Complete Step 1.5 (page grouping) first.');
      process.exit(1);
    }
    if (!hasConfirmedPageGroups(analysis)) {
      const review = getPageGroupsReviewState(analysis);
      console.error('\n❌ pageGroups are not explicitly confirmed.');
      if (review.status === 'confirmed') {
        console.error('   pageGroups changed after the last confirmation. Review them and confirm again.');
      } else {
        console.error('   Review the current groups with the user and record approval before continuing.');
      }
      console.error(`   Run: ${formatPublicCommand(['confirm-page-groups', resolvedFile])}`);
      process.exit(1);
    }

    if (requiredLiveGtmIds.length > 0) {
      const liveAnalysisFile = path.join(artifactDir, 'live-gtm-analysis.json');
      if (!fs.existsSync(liveAnalysisFile)) {
        console.error('\n❌ Live GTM baseline is required before schema preparation for this site.');
        console.error(`   Detected live containers: ${requiredLiveGtmIds.join(', ')}`);
        console.error(`   Run: ${formatPublicCommand(['analyze-live-gtm', resolvedFile])}`);
        process.exit(1);
      }

      liveAnalysis = readJsonFile<LiveGtmAnalysis>(liveAnalysisFile);
      const analyzedIds = uniq((liveAnalysis.detectedContainerIds || []).map(id => id.toUpperCase()));
      const missingIds = requiredLiveGtmIds.filter(id => !analyzedIds.includes(id));

      if (missingIds.length > 0) {
        console.error('\n❌ live-gtm-analysis.json is stale for the currently detected site containers.');
        console.error(`   Missing container(s): ${missingIds.join(', ')}`);
        console.error(`   Run: ${formatPublicCommand(['analyze-live-gtm', resolvedFile])}`);
        process.exit(1);
      }
    } else {
      const liveAnalysisFile = path.join(artifactDir, 'live-gtm-analysis.json');
      liveAnalysis = tryReadJsonFile<LiveGtmAnalysis>(liveAnalysisFile);
    }

    const context = buildSchemaContext(analysis, liveAnalysis);
    const outFile = path.join(artifactDir, 'schema-context.json');
    writeJsonFile(outFile, context);

    let shopifyTemplateFile: string | null = null;
    let shopifyBootstrappedSchemaFile: string | null = null;
    let shopifyReviewFile: string | null = null;
    let shopifyReviewItems: Array<{ eventName: string; recommendation: 'keep' | 'review' | 'remove' }> = [];
    let reusedExistingSchema = false;
    if (isShopifyPlatform(analysis.platform)) {
      const bootstrap = buildShopifyBootstrapArtifacts(analysis);
      const template = bootstrap.schema;
      shopifyReviewItems = bootstrap.reviewItems;
      shopifyTemplateFile = path.join(artifactDir, 'shopify-schema-template.json');
      writeJsonFile(shopifyTemplateFile, template);
      shopifyReviewFile = path.join(artifactDir, 'shopify-bootstrap-review.md');
      fs.writeFileSync(shopifyReviewFile, bootstrap.reviewMarkdown);

      const eventSchemaFile = path.join(artifactDir, 'event-schema.json');
      if (!fs.existsSync(eventSchemaFile)) {
        writeJsonFile(eventSchemaFile, template);
        shopifyBootstrappedSchemaFile = eventSchemaFile;
      } else {
        reusedExistingSchema = true;
      }
    }

    const origSize = Buffer.byteLength(fs.readFileSync(resolvedFile, 'utf-8'));
    const compSize = Buffer.byteLength(JSON.stringify(context, null, 2));
    const ratio = ((1 - compSize / origSize) * 100).toFixed(0);

    console.log(`\n✅ Schema context generated:`);
    console.log(`   Groups: ${context.groups.length}`);
    console.log(`   Total unique elements: ${context.groups.reduce((s, g) => s + g.elements.length, 0)}`);
    console.log(`   Size: ${(origSize / 1024).toFixed(0)}KB → ${(compSize / 1024).toFixed(0)}KB (${ratio}% reduction)`);
    console.log(`   Output: ${outFile}`);
    if (shopifyTemplateFile) {
      console.log(`   Shopify template: ${shopifyTemplateFile}`);
    }
    if (shopifyReviewFile) {
      console.log(`   Shopify review: ${shopifyReviewFile}`);
    }
    if (shopifyBootstrappedSchemaFile) {
      console.log(`   Shopify event schema initialized: ${shopifyBootstrappedSchemaFile}`);
    } else if (reusedExistingSchema) {
      console.log(`   Shopify event schema preserved: ${path.join(path.dirname(analysisFile), 'event-schema.json')}`);
    }
    if (context.existingTrackingBaseline) {
      console.log(`   Live GTM baseline: ${context.existingTrackingBaseline.totalLiveEvents} existing event(s) from ${context.existingTrackingBaseline.comparedContainerIds.join(', ')}`);
    }
    if (shopifyReviewItems.length > 0) {
      printShopifyBootstrapSummary(shopifyReviewItems);
      console.log(`   Review details: ${shopifyReviewFile || '—'}`);
    }
    console.log(`   Workflow state: ${path.join(artifactDir, WORKFLOW_STATE_FILE)}`);
    refreshAndIndexWorkflowState(artifactDir);
  });

// STEP 3: Generate GTM config
program
  .command('generate-gtm <schema-file>')
  .description('Generate GTM Web Container configuration JSON')
  .option('--output-dir <dir>', 'Directory for generated files (default: same directory as <schema-file>)')
  .option('--measurement-id <id>', 'GA4 Measurement ID (G-XXXXXXXXXX)')
  .option('--google-tag-id <id>', 'Optional Google tag ID (GT-/G-/AW-...). Used for the configuration tag target when provided')
  .option('--force', 'Generate GTM config without a current schema confirmation')
  .action(async (schemaFile: string, opts: { measurementId?: string; googleTagId?: string; outputDir?: string; force?: boolean }) => {
    const schema = readJsonFile<EventSchema>(schemaFile);
    const artifactDir = path.dirname(path.resolve(schemaFile));

    // Validate schema before generating
    const issues = validateEventSchema(schema);
    const errs = issues.filter(i => i.severity === 'error');
    const warns = issues.filter(i => i.severity === 'warning');

    if (warns.length > 0) {
      console.log(`\n⚠️  Schema warnings:`);
      for (const w of warns) console.log(`   [${w.field}] ${w.message}`);
    }
    if (errs.length > 0) {
      console.log(`\n❌ Schema validation failed (${errs.length} error(s)):`);
      for (const e of errs) console.log(`   [${e.field}] ${e.message}`);
      console.log(`\nFix the errors in ${schemaFile} before generating GTM config.`);
      process.exit(1);
    }

    const workflowState = refreshAndIndexWorkflowState(artifactDir);
    if (!opts.force && workflowState.schemaReview.status !== 'confirmed') {
      console.error('\n❌ event-schema.json is not currently confirmed.');
      if (workflowState.warnings.length > 0) {
        workflowState.warnings.forEach(warning => console.error(`   ${warning}`));
      }
      console.error(`   Run: ${formatPublicCommand(['confirm-schema', path.resolve(schemaFile)])}`);
      console.error('   Use --force only if you intentionally want to bypass the schema approval gate.');
      process.exit(1);
    }

    let measurementId = normalizeTrackingId(opts.measurementId) || normalizeTrackingId(schema.measurementId);
    if (!measurementId) {
      measurementId = normalizeTrackingId(await prompt('\nEnter GA4 Measurement ID (e.g. G-XXXXXXXXXX): '));
    }
    if (!measurementId) {
      console.error('\n❌ GA4 Measurement ID is required.');
      process.exit(1);
    }
    const googleTagId = normalizeTrackingId(opts.googleTagId) || normalizeTrackingId(schema.googleTagId);

    console.log(`\n⚙️  Generating GTM configuration...`);
    const config = generateGTMConfig(schema, { measurementId, googleTagId });

    const dir = opts.outputDir
      ? resolveOutputDir(opts.outputDir)
      : artifactDir;
    const outFile = path.join(dir, 'gtm-config.json');
    fs.writeFileSync(outFile, JSON.stringify(config, null, 2));
    refreshAndIndexWorkflowState(dir);

    const { tag: tags, trigger: triggers, variable: variables } = config.containerVersion;
    console.log(`\n✅ GTM configuration generated:`);
    console.log(`   Tags: ${tags.length}`);
    console.log(`   Triggers: ${triggers.length}`);
    console.log(`   Variables: ${variables.length}`);
    console.log(`   GA4 Measurement ID: ${measurementId}`);
    if (googleTagId) {
      console.log(`   Google tag ID: ${googleTagId}`);
      if (googleTagId !== measurementId) {
        console.log(`   Note: the configuration tag will target ${googleTagId}; GA4 event tags still target ${measurementId}.`);
      }
    }
    console.log(`   Output: ${outFile}`);

    // Show quota usage
    const quota = getQuotaSummary(schema);
    console.log(`\n📊 GA4 Quota Usage:`);
    console.log(`   Custom events: ${quota.customEvents} / ${quota.customEventLimit}`);
    console.log(`   Custom dimensions: ${quota.customDimensions} / ${quota.customDimensionLimit}`);

    if (quota.customDimensionNames.length > 0) {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`⚠️  ACTION REQUIRED — Register Custom Dimensions in GA4`);
      console.log(`${'═'.repeat(60)}`);
      console.log(`\n   ${quota.customDimensionNames.length} custom parameter(s) MUST be registered in GA4`);
      console.log(`   before publishing. If skipped, these parameters will be`);
      console.log(`   silently discarded and the data CANNOT be recovered.\n`);
      console.log(`   GA4 Admin → Custom Definitions → Create custom dimension:`);
      for (const name of quota.customDimensionNames) {
        console.log(`     □  ${name}  (Scope: Event)`);
      }
      console.log(`\n   ⚠️  Do not proceed to sync/publish until all dimensions are registered.`);
      console.log(`${'═'.repeat(60)}`);
    }
    console.log(`   Workflow state: ${path.join(dir, WORKFLOW_STATE_FILE)}`);
  });

// STEP 4+5: Auth, select workspace, and sync
program
  .command('sync <config-file>')
  .description('Authenticate with Google, select GTM workspace, and sync configuration')
  .option('--account-id <id>', 'GTM Account ID (skip selection)')
  .option('--container-id <id>', 'GTM Container ID (skip selection)')
  .option('--workspace-id <id>', 'GTM Workspace ID (skip selection)')
  .option('--new-workspace', 'Create a new workspace instead of selecting existing')
  .option('--clean', 'Deprecated: cleanup of [JTracking] managed entities now happens automatically on every sync')
  .option('--dry-run', 'Show planned changes without executing them')
  .action(async (configFile: string, opts: {
    accountId?: string;
    containerId?: string;
    workspaceId?: string;
    newWorkspace?: boolean;
    clean?: boolean;
    dryRun?: boolean;
  }) => {
    const config = readJsonFile<GTMContainerExport>(configFile);

    console.log('\n🔐 Authenticating with Google...');
    const artifactDir = resolveArtifactDirFromFile(configFile);
    const auth = await getAuthClient(artifactDir);
    const client = new GTMClient(auth);

    // Select account
    let accountId = opts.accountId;
    if (!accountId) {
      const accounts = await client.listAccounts();
      if (accounts.length === 0) throw new Error('No GTM accounts found.');
      const account = await selectFromList(accounts, 'GTM Account', (a, i) => `${a.name} (${a.accountId})`);
      accountId = account.accountId;
    }

    // Select container (web containers only)
    let containerId = opts.containerId;
    let publicId = '';
    if (!containerId) {
      const containers = await client.listContainers(accountId);
      if (containers.length === 0) throw new Error('No web containers found in this account.');
      const container = await selectFromList(containers, 'GTM Container', (c, i) => `${c.name} (${c.publicId})`);
      containerId = container.containerId;
      publicId = container.publicId;
    } else if (opts.containerId) {
      // If containerId is provided via flag, try to look up publicId
      const containers = await client.listContainers(accountId!).catch(() => []);
      const found = containers.find(c => c.containerId === opts.containerId);
      if (found) publicId = found.publicId;
    }

    // Select or create workspace
    let workspaceId = opts.workspaceId;
    if (!workspaceId) {
      if (opts.newWorkspace) {
        const wsName = await prompt('New workspace name (default: "event-tracking-auto"): ') || 'event-tracking-auto';
        const ws = await client.createWorkspace(accountId, containerId, wsName, 'Created by event-tracking-skill');
        workspaceId = ws.workspaceId;
        console.log(`\n✅ Created workspace: ${ws.name} (${ws.workspaceId})`);
      } else {
        const workspaces = await client.listWorkspaces(accountId, containerId);
        if (workspaces.length === 0) {
          const ws = await client.createWorkspace(accountId, containerId, 'event-tracking-auto');
          workspaceId = ws.workspaceId;
          console.log(`\nCreated default workspace: ${ws.name}`);
        } else {
          const ws = await selectFromList(workspaces, 'GTM Workspace', (w, i) => `${w.name} (ID: ${w.workspaceId})`);
          workspaceId = ws.workspaceId;
        }
      }
    }

    if (opts.dryRun) {
      console.log(`\n🔍 Dry-run: computing planned changes...`);
      const plan = await dryRunSync(client, config, accountId, containerId, workspaceId, opts.clean);

      const printSection = (label: string, section: { create: string[]; update: string[]; delete: string[] }) => {
        console.log(`\n   ${label}:`);
        console.log(`     Create (${section.create.length}): ${section.create.join(', ') || '—'}`);
        console.log(`     Update (${section.update.length}): ${section.update.join(', ') || '—'}`);
        console.log(`     Delete (${section.delete.length}): ${section.delete.join(', ') || '—'}`);
      };

      console.log(`\n📋 Planned changes (dry-run, nothing was modified):`);
      printSection('Variables', plan.variables);
      printSection('Triggers', plan.triggers);
      printSection('Tags', plan.tags);
      return;
    }

    console.log(`\n📤 Syncing GTM configuration to workspace ${workspaceId}...`);
    const syncResult = await syncConfigToWorkspace(client, config, accountId, containerId, workspaceId, opts.clean);

    console.log(`\n✅ Sync complete:`);
    console.log(`   Tags: ${syncResult.tagsCreated} created, ${syncResult.tagsUpdated} updated, ${syncResult.tagsDeleted} deleted`);
    console.log(`   Triggers: ${syncResult.triggersCreated} created, ${syncResult.triggersUpdated} updated, ${syncResult.triggersDeleted} deleted`);
    console.log(`   Variables: ${syncResult.variablesCreated} created, ${syncResult.variablesUpdated} updated, ${syncResult.variablesDeleted} deleted`);
    if (syncResult.errors.length > 0) {
      console.log(`   Errors: ${syncResult.errors.length}`);
      syncResult.errors.forEach(e => console.log(`     ⚠️  ${e}`));
    }

    // Save workspace info for subsequent commands
    const contextFile = path.join(path.dirname(configFile), 'gtm-context.json');
    fs.writeFileSync(contextFile, JSON.stringify({
      accountId, containerId, workspaceId, publicId,
      syncedAt: new Date().toISOString(),
    }, null, 2));
    console.log(`\n   GTM context saved: ${contextFile}`);
    refreshAndIndexWorkflowState(artifactDir);

    const siteAnalysis = tryReadJsonFile<SiteAnalysis>(path.join(artifactDir, 'site-analysis.json'));
    if (siteAnalysis && isShopifyPlatform(siteAnalysis.platform)) {
      if (!publicId) {
        console.log(`\n⚠️  Shopify site detected, but the container public ID was not available.`);
        console.log(`   Re-run sync with an interactively selected container or provide a valid GTM public ID before generating the Shopify custom pixel.`);
      } else {
        const schema = tryReadJsonFile<EventSchema>(path.join(artifactDir, 'event-schema.json')) || undefined;
        const artifacts = generateShopifyPixelArtifacts(publicId, siteAnalysis.rootUrl, schema);
        const pixelFile = path.join(artifactDir, 'shopify-custom-pixel.js');
        const installFile = path.join(artifactDir, 'shopify-install.md');
        fs.writeFileSync(pixelFile, artifacts.pixelCode);
        fs.writeFileSync(installFile, artifacts.installGuide);

        console.log(`\n🛍️  Shopify site detected. Generated custom pixel artifacts:`);
        console.log(`   Pixel: ${pixelFile}`);
        console.log(`   Install guide: ${installFile}`);
        console.log(`   Event mappings: ${artifacts.mappings.map(m => `${m.shopifyEventName}->${m.ga4EventName}`).join(', ')}`);
        console.log(`\n   Next step: install the Shopify custom pixel, then run`);
        console.log(`   ${formatPublicCommand(['preview', path.join(artifactDir, 'event-schema.json'), '--context-file', contextFile])}`);
        return;
      }
    }

    console.log(`\n   Next step:`);
    console.log(`   ${formatPublicCommand(['preview', path.join(artifactDir, 'event-schema.json'), '--context-file', contextFile])}`);
  });

// STEP 6: Run preview verification
program
  .command('preview <schema-file>')
  .description('Run GTM preview and verify GA4 events are firing')
  .option('--context-file <file>', 'Path to gtm-context.json from sync step')
  .option('--account-id <id>', 'GTM Account ID')
  .option('--container-id <id>', 'GTM Container ID')
  .option('--workspace-id <id>', 'GTM Workspace ID')
  .option('--public-id <id>', 'GTM Container Public ID (e.g. ABC123 from GTM-ABC123)')
  .option('--baseline <file>', 'Optional previous tracking-health.json for regression comparison')
  .action(async (schemaFile: string, opts: {
    contextFile?: string;
    accountId?: string;
    containerId?: string;
    workspaceId?: string;
    publicId?: string;
    baseline?: string;
  }) => {
    const schema = readJsonFile<EventSchema>(schemaFile);

    // Load context
    let accountId = opts.accountId;
    let containerId = opts.containerId;
    let workspaceId = opts.workspaceId;
    let publicId = opts.publicId || '';

    if (opts.contextFile && fs.existsSync(opts.contextFile)) {
      const ctx = readJsonFile<{
        accountId?: string;
        containerId?: string;
        workspaceId?: string;
        publicId?: string;
      }>(opts.contextFile);
      accountId = accountId || ctx.accountId;
      containerId = containerId || ctx.containerId;
      workspaceId = workspaceId || ctx.workspaceId;
      publicId = publicId || ctx.publicId || '';
    }

    if (!accountId || !containerId || !workspaceId) {
      throw new Error('Missing GTM context. Run sync first or provide --account-id, --container-id, --workspace-id');
    }

    const gtmPublicId = publicId || 'UNKNOWN';

    // Load site analysis
    const analysisFile = path.join(path.dirname(schemaFile), 'site-analysis.json');
    const siteAnalysis = readJsonFile<SiteAnalysis>(analysisFile);

    if (isShopifyPlatform(siteAnalysis.platform)) {
      console.log(`\n🛍️  Shopify site detected. Skipping automated browser preview.`);
      const dir = path.dirname(schemaFile);
      const { reportFile, jsonFile } = writeShopifyPreviewInstructions(dir, siteAnalysis, gtmPublicId);
      const healthFile = path.join(dir, TRACKING_HEALTH_FILE);
      const healthReportFile = path.join(dir, TRACKING_HEALTH_REPORT_FILE);
      const manualTrackingHealth = buildManualTrackingHealthReport({
        siteUrl: siteAnalysis.rootUrl,
        gtmContainerId: gtmPublicId,
        generatedAt: new Date().toISOString(),
        reason: 'Shopify custom pixel verification requires a manual GA4 Realtime and Shopify pixel debugging pass.',
        totalSchemaEvents: schema.events.length,
      });
      writeTrackingHealthReport(healthFile, manualTrackingHealth);
      writeTrackingHealthReportMarkdown(healthReportFile, manualTrackingHealth);
      const historyFile = writeTrackingHealthHistory(dir, manualTrackingHealth);
      refreshAndIndexWorkflowState(dir, {
        verification: {
          status: 'completed',
          verifiedAt: new Date().toISOString(),
          reportFile,
          resultFile: jsonFile,
        },
      });
      console.log(`   Manual verification guide saved to: ${reportFile}`);
      console.log(`   Preview metadata saved to: ${jsonFile}`);
      console.log(`   Tracking health saved to: ${healthFile}`);
      console.log(`   Tracking health report saved to: ${healthReportFile}`);
      console.log(`   Tracking health history saved to: ${historyFile}`);
      console.log(`\n   Next step: install the Shopify custom pixel, publish the GTM workspace, and validate in GA4 Realtime.`);
      return;
    }

    // ── GTM container check ────────────────────────────────────────────────
    console.log(`\n🔍 Checking GTM container on site...`);
    const gtmCheck = await checkGTMOnPage(siteAnalysis.rootUrl, gtmPublicId);

    let injectGTM = false;

    if (gtmPublicId === 'UNKNOWN') {
      console.log(`\n⚠️  No GTM public ID found in context. Re-run sync to capture container info.`);
    } else if (gtmCheck.hasExpectedContainer) {
      console.log(`\n✅ Container ${gtmPublicId} detected on site. Proceeding with preview.`);
    } else {
      if (gtmCheck.siteLoadsGTM) {
        console.log(`\n⚠️  Site loads GTM, but with a different container: [${gtmCheck.loadedContainerIds.join(', ')}]`);
        console.log(`   Expected: ${gtmPublicId}`);
      } else {
        console.log(`\n⚠️  No GTM container detected on site (${siteAnalysis.rootUrl})`);
      }

      console.log(`\nOptions:`);
      console.log(`  [1] Go back and re-sync to the correct container`);
      console.log(`  [2] Inject ${gtmPublicId} into the page during preview (simulates GTM being installed)`);
      const choice = await prompt('\nSelect option (1 or 2): ');

      if (choice === '1') {
        console.log(`\n💡 Re-run the 'sync' command and select the container that's actually installed on the site.`);
        if (gtmCheck.siteLoadsGTM) {
          console.log(`   Site currently uses: ${gtmCheck.loadedContainerIds.join(', ')}`);
        }
        return;
      } else if (choice === '2') {
        injectGTM = true;
        console.log(`\n💉 Will inject ${gtmPublicId} during preview.`);
      } else {
        console.log(`Invalid choice. Exiting.`);
        return;
      }
    }

    // ─────────────────────────────────────────────────────────────────────

    console.log('\n🔐 Authenticating with Google...');
    const artifactDir = resolveArtifactDirFromFile(schemaFile);
    const auth = await getAuthClient(artifactDir);
    const client = new GTMClient(auth);

    console.log('\n🔬 Running GTM Preview verification...');
    console.log('   (This may take 2-5 minutes)');

    const previewResult = await runPreviewVerification(
      siteAnalysis, schema, client,
      accountId, containerId, workspaceId, gtmPublicId, injectGTM
    );

    // Generate and save report
    const dir = path.dirname(schemaFile);
    const reportFile = path.join(dir, 'preview-report.md');
    const report = generatePreviewReport(previewResult, reportFile);

    const jsonFile = path.join(dir, 'preview-result.json');
    fs.writeFileSync(jsonFile, JSON.stringify(previewResult, null, 2));
    const healthFile = path.join(dir, TRACKING_HEALTH_FILE);
    const healthReportFile = path.join(dir, TRACKING_HEALTH_REPORT_FILE);
    const baselineFile = opts.baseline?.trim()
      ? path.resolve(opts.baseline)
      : (fs.existsSync(healthFile) ? healthFile : undefined);
    const baselineHealth = baselineFile ? readTrackingHealthReport(baselineFile) : null;
    const trackingHealth = buildTrackingHealthReport(previewResult, baselineHealth, baselineFile);
    writeTrackingHealthReport(healthFile, trackingHealth);
    writeTrackingHealthReportMarkdown(healthReportFile, trackingHealth);
    const historyFile = writeTrackingHealthHistory(dir, trackingHealth);
    refreshAndIndexWorkflowState(dir, {
      verification: {
        status: 'completed',
        verifiedAt: previewResult.previewEndedAt,
        reportFile,
        resultFile: jsonFile,
        totalExpected: previewResult.totalExpected,
        totalFired: previewResult.totalFired,
      },
    });

    console.log('\n' + '─'.repeat(60));
    console.log(report);
    console.log('─'.repeat(60));
    console.log(`\n✅ Report saved to: ${reportFile}`);
    console.log(`   Raw data saved to: ${jsonFile}`);
    console.log(`   Tracking health saved to: ${healthFile} (score ${formatTrackingHealthScore(trackingHealth.score)}, ${trackingHealth.grade})`);
    console.log(`   Tracking health report saved to: ${healthReportFile}`);
    console.log(`   Tracking health history saved to: ${historyFile}`);
    if (trackingHealth.baseline) {
      if (typeof trackingHealth.baseline.scoreDelta === 'number') {
        const delta = trackingHealth.baseline.scoreDelta >= 0
          ? `+${trackingHealth.baseline.scoreDelta}`
          : `${trackingHealth.baseline.scoreDelta}`;
        console.log(`   Baseline delta: ${delta} point(s) vs ${trackingHealth.baseline.file || 'previous health report'}`);
      } else {
        console.log(`   Baseline delta: n/a vs ${trackingHealth.baseline.file || 'previous health report'}`);
      }
      if (trackingHealth.baseline.newFailures.length > 0) {
        console.log(`   New failures: ${trackingHealth.baseline.newFailures.join(', ')}`);
      }
    }
    if (trackingHealth.unexpectedEventNames.length > 0) {
      console.log(`   Unexpected events: ${trackingHealth.unexpectedEventNames.join(', ')}`);
    }

    if (!hasBlockingTrackingHealth(trackingHealth) && previewResult.totalFired > 0) {
      console.log(`\n   Next step:`);
      console.log(`   ${formatPublicCommand(['publish', '--context-file', path.join(dir, 'gtm-context.json'), '--version-name', 'GA4 Events v1'])}`);
    } else if (hasBlockingTrackingHealth(trackingHealth)) {
      console.log(`\n   Publish is blocked until tracking-health blockers are resolved.`);
    }
  });

// STEP 7: Publish container
program
  .command('publish')
  .description('Publish the GTM container workspace')
  .option('--context-file <file>', 'Path to gtm-context.json')
  .option('--artifact-dir <dir>', 'Artifact directory for URL-scoped auth/context files')
  .option('--account-id <id>', 'GTM Account ID')
  .option('--container-id <id>', 'GTM Container ID')
  .option('--workspace-id <id>', 'GTM Workspace ID')
  .option('--version-name <name>', 'Version name for the published container')
  .option('--force', 'Publish even when preview health is missing or blocked')
  .option('--yes', 'Skip confirmation prompt')
  .action(async (opts: {
    contextFile?: string;
    artifactDir?: string;
    accountId?: string;
    containerId?: string;
    workspaceId?: string;
    versionName?: string;
    force?: boolean;
    yes?: boolean;
  }) => {
    let accountId = opts.accountId;
    let containerId = opts.containerId;
    let workspaceId = opts.workspaceId;
    const artifactDir = opts.artifactDir?.trim()
      ? path.resolve(opts.artifactDir)
      : (opts.contextFile?.trim() ? resolveArtifactDirFromFile(opts.contextFile) : undefined);

    if (opts.contextFile && fs.existsSync(opts.contextFile)) {
      const ctx = readJsonFile<{
        accountId?: string;
        containerId?: string;
        workspaceId?: string;
      }>(opts.contextFile);
      accountId = accountId || ctx.accountId;
      containerId = containerId || ctx.containerId;
      workspaceId = workspaceId || ctx.workspaceId;
    }

    if (!accountId || !containerId || !workspaceId) {
      throw new Error('Missing GTM context. Provide --context-file or individual IDs.');
    }
    if (!artifactDir) {
      throw new Error('Missing artifact directory. Provide --context-file or --artifact-dir so URL-scoped OAuth credentials can be loaded.');
    }

    const publishReadiness = evaluatePublishReadiness(artifactDir);
    if (publishReadiness.blocking && !opts.force) {
      console.error(`\n❌ Publish blocked:`);
      for (const message of publishReadiness.messages) {
        console.error(`   - ${message}`);
      }
      console.error(`   Re-run preview after fixes, or use --force to override.`);
      process.exit(1);
    }

    if (publishReadiness.messages.length > 0) {
      console.log(`\n⚠️  Publish readiness notes:`);
      for (const message of publishReadiness.messages) {
        console.log(`   - ${message}`);
      }
    }
    if (publishReadiness.blocking && opts.force) {
      console.log(`   Force override enabled. Continuing anyway.`);
    }

    if (!opts.yes) {
      const confirm = await prompt('\n⚠️  This will PUBLISH the GTM container (affects live site). Continue? (yes/no): ');
      if (confirm.toLowerCase() !== 'yes') {
        console.log('Publish cancelled.');
        return;
      }
    }

    console.log('\n🔐 Authenticating with Google...');
    const auth = await getAuthClient(artifactDir);
    const client = new GTMClient(auth);

    console.log('\n🚀 Publishing GTM container...');
    const result = await client.publishContainer(
      accountId, containerId, workspaceId,
      opts.versionName
    );

    console.log(`\n✅ Container published successfully!`);
    console.log(`   Version ID: ${result.versionId}`);
    console.log(`\n   The GA4 event tracking is now LIVE on your website.`);
    console.log(`   Monitor events in GA4 Realtime: https://analytics.google.com/`);
    refreshAndIndexWorkflowState(artifactDir, {
      publish: {
        status: 'completed',
        publishedAt: new Date().toISOString(),
        versionId: result.versionId,
        versionName: opts.versionName,
      },
    });
    console.log(`   Workflow state: ${path.join(artifactDir, WORKFLOW_STATE_FILE)}`);
  });

program
  .command('status <artifact-path>')
  .description('Inspect workflow state for an artifact directory or one of its files')
  .option('--json', 'Print machine-readable workflow state JSON')
  .action((artifactPath: string, opts: { json?: boolean }) => {
    const artifactDir = resolveArtifactDirFromInput(artifactPath);
    const workflowState = refreshAndIndexWorkflowState(artifactDir);

    if (opts.json) {
      console.log(JSON.stringify(workflowState, null, 2));
      return;
    }

    console.log(`\n📍 Workflow status`);
    console.log(`   Artifact directory: ${workflowState.artifactDir}`);
    console.log(`   Current checkpoint: ${workflowState.currentCheckpoint}`);
    if (workflowState.siteUrl) {
      console.log(`   Site: ${workflowState.siteUrl}`);
    }
    if (workflowState.platformType) {
      console.log(`   Platform: ${workflowState.platformType}`);
    }

    console.log(`\n✅ Completed checkpoints:`);
    if (workflowState.completedCheckpoints.length === 0) {
      console.log('   none');
    } else {
      workflowState.completedCheckpoints.forEach(checkpoint => console.log(`   - ${checkpoint}`));
    }

    console.log(`\n📦 Key artifacts:`);
    const artifactFlags: Array<[string, boolean]> = [
      ['site-analysis.json', workflowState.artifacts.siteAnalysis],
      ['live-gtm-analysis.json', workflowState.artifacts.liveGtmAnalysis],
      ['live-gtm-review.md', workflowState.artifacts.liveGtmReview],
      ['schema-context.json', workflowState.artifacts.schemaContext],
      ['event-schema.json', workflowState.artifacts.eventSchema],
      ['event-spec.md', workflowState.artifacts.eventSpec],
      ['tracking-plan-comparison.md', workflowState.artifacts.trackingPlanComparison],
      ['schema-decisions.jsonl', workflowState.artifacts.schemaDecisionAudit],
      ['schema-restore/', workflowState.artifacts.schemaRestore],
      ['gtm-config.json', workflowState.artifacts.gtmConfig],
      ['gtm-context.json', workflowState.artifacts.gtmContext],
      ['preview-report.md', workflowState.artifacts.previewReport],
      [TRACKING_HEALTH_FILE, workflowState.artifacts.trackingHealth],
      [TRACKING_HEALTH_REPORT_FILE, workflowState.artifacts.trackingHealthReport],
      [TRACKING_HEALTH_HISTORY_DIR, workflowState.artifacts.trackingHealthHistory],
      [RUN_CONTEXT_FILE, fs.existsSync(path.join(workflowState.artifactDir, RUN_CONTEXT_FILE))],
      [WORKFLOW_STATE_FILE, true],
    ];
    artifactFlags.forEach(([label, present]) => {
      console.log(`   - ${label}: ${present ? 'present' : 'missing'}`);
    });

    console.log(`\n🛂 Review gates:`);
    console.log(`   - page groups: ${workflowState.pageGroupsReview.status}${workflowState.pageGroupsReview.confirmedAt ? ` (${workflowState.pageGroupsReview.confirmedAt})` : ''}`);
    console.log(`   - schema: ${workflowState.schemaReview.status}${workflowState.schemaReview.confirmedAt ? ` (${workflowState.schemaReview.confirmedAt})` : ''}`);
    if (workflowState.verification.status === 'completed') {
      const scoreLabel = formatTrackingHealthScore(
        workflowState.verification.healthScore === undefined ? null : workflowState.verification.healthScore,
      );
      console.log(
        `   - verification: completed` +
        `${workflowState.verification.healthGrade ? ` (${workflowState.verification.healthGrade}, ${scoreLabel})` : ''}`,
      );
      if ((workflowState.verification.healthBlockers || []).length > 0) {
        console.log(`   - publish blockers: ${workflowState.verification.healthBlockers!.join(' | ')}`);
      }
      if ((workflowState.verification.unexpectedEventCount || 0) > 0) {
        console.log(`   - unexpected events: ${workflowState.verification.unexpectedEventCount}`);
      }
    }

    if (workflowState.warnings.length > 0) {
      console.log(`\n⚠️  Warnings:`);
      workflowState.warnings.forEach(warning => console.log(`   - ${warning}`));
    }

    console.log(`\n➡️  Next action: ${workflowState.nextAction}`);
    if (workflowState.nextCommand) {
      console.log(`   ${workflowState.nextCommand}`);
    }
  });

program
  .command('runs [output-root]')
  .description('List known event-tracking artifact directories from an output root')
  .option('--json', 'Print machine-readable run index JSON')
  .option('--limit <count>', 'Maximum number of runs to show', '10')
  .action((outputRoot: string | undefined, opts: { json?: boolean; limit?: string }) => {
    const resolvedRoot = path.resolve(outputRoot?.trim() || DEFAULT_OUTPUT_ROOT);
    const limit = Math.max(1, Number.parseInt(opts.limit || '10', 10) || 10);
    const entries = readRunIndex(resolvedRoot).slice(0, limit);

    if (opts.json) {
      console.log(JSON.stringify({
        outputRoot: resolvedRoot,
        indexFile: path.join(resolvedRoot, RUN_INDEX_FILE),
        runs: entries,
      }, null, 2));
      return;
    }

    console.log(`\n📍 Event tracking runs`);
    console.log(`   Output root: ${resolvedRoot}`);
    if (entries.length === 0) {
      console.log(`   No runs found. Run analyze first, or pass the output root that contains your artifact directories.`);
      return;
    }

    entries.forEach((entry, index) => {
      console.log(`\n   [${index + 1}] ${entry.siteUrl || '(site unknown)'}`);
      console.log(`       Artifact directory: ${entry.artifactDir}`);
      console.log(`       Checkpoint: ${entry.currentCheckpoint}`);
      if (entry.platformType) {
        console.log(`       Platform: ${entry.platformType}`);
      }
      if (entry.nextCommand) {
        console.log(`       Next: ${entry.nextCommand}`);
      }
    });
  });

// Auth management
program
  .command('auth-clear')
  .description('Clear stored OAuth credentials')
  .option('--context-file <file>', 'Path to gtm-context.json to locate the URL-scoped auth cache')
  .option('--artifact-dir <dir>', 'Artifact directory whose URL-scoped auth cache should be cleared')
  .option('--output-root <dir>', 'Clear all URL-scoped auth caches found under this output root')
  .action((opts: { contextFile?: string; artifactDir?: string; outputRoot?: string }) => {
    const artifactDir = opts.artifactDir?.trim()
      ? path.resolve(opts.artifactDir)
      : (opts.contextFile?.trim() ? resolveArtifactDirFromFile(opts.contextFile) : undefined);
    clearCredentials({
      artifactDir,
      outputRoot: opts.outputRoot?.trim() ? path.resolve(opts.outputRoot) : undefined,
    });
  });

// GENERATE-SPEC: produce a human-readable event spec document
program
  .command('generate-spec <schema-file>')
  .description('Generate a human-readable event-spec.md from event-schema.json for stakeholder review')
  .action(async (schemaFile: string) => {
    const resolvedSchemaFile = path.resolve(schemaFile);
    const artifactDir = path.dirname(resolvedSchemaFile);
    const schema = readJsonFile<EventSchema>(resolvedSchemaFile);
    const quota = getQuotaSummary(schema);
    const liveAnalysis = tryReadJsonFile<LiveGtmAnalysis>(path.join(artifactDir, 'live-gtm-analysis.json'));
    const baseline = liveAnalysis ? buildExistingTrackingBaseline(liveAnalysis) : null;
    const liveDelta = liveAnalysis ? compareSchemaToLiveTracking(schema, liveAnalysis) : null;
    const comparisonOutFile = path.join(artifactDir, 'tracking-plan-comparison.md');

    const lines: string[] = [
      `# GA4 Event Tracking Specification`,
      ``,
      `**Site:** ${schema.siteUrl}`,
      `**Generated:** ${new Date(schema.generatedAt).toLocaleString()}`,
      `**Total Events:** ${schema.events.length}`,
      `**Custom Dimensions:** ${quota.customDimensions}`,
      ``,
      `---`,
      ``,
      `## Overview`,
      ``,
      `| Event Name | Trigger | Page Pattern | Priority |`,
      `|------------|---------|--------------|----------|`,
      ...schema.events.map(e =>
        `| \`${e.eventName}\` | ${e.triggerType} | ${e.pageUrlPattern ? `\`${e.pageUrlPattern}\`` : '_all pages_'} | ${e.priority} |`
      ),
      ``,
      `---`,
      ``,
    ];

    if (baseline) {
      lines.push(
        `## Live Tracking Baseline`,
        ``,
        `- Primary comparison container: ${baseline.primaryContainerId ? `\`${baseline.primaryContainerId}\`` : 'none'}`,
        `- Compared live containers: ${baseline.comparedContainerIds.map(id => `\`${id}\``).join(', ') || 'none'}`,
        `- Existing live events parsed: ${baseline.totalLiveEvents}`,
        `- Existing measurement IDs: ${baseline.measurementIds.join(', ') || 'none detected'}`,
        ``,
      );

      if (baseline.events.length > 0) {
        lines.push(
          `| Live Event | Containers | Trigger Types | Parameters | Confidence |`,
          `| --- | --- | --- | --- | --- |`,
          ...baseline.events.map(event =>
            `| \`${event.eventName}\` | ${event.containers.map(id => `\`${id}\``).join(', ')} | ${event.triggerTypes.join(', ')} | ${event.parameterNames.join(', ') || '—'} | ${event.confidence} |`,
          ),
          ``,
        );
      }

      lines.push(`---`, ``);
    }

    if (baseline?.observedProblems.length) {
      lines.push(
        `## Current Live Tracking Issues`,
        ``,
        ...baseline.observedProblems.map(problem => `- ${problem}`),
        ``,
        `---`,
        ``,
      );
    }

    if (liveDelta) {
      lines.push(
        `## Change Summary`,
        ``,
        `| Event Name | Status vs Live | Improvements |`,
        `| --- | --- | --- |`,
        ...liveDelta.changes.map(change =>
          `| \`${change.eventName}\` | ${change.status} | ${change.improvements.join('; ') || 'Keeps the existing live definition shape'} |`,
        ),
        ``,
      );

      if (liveDelta.problemsSolved.length > 0) {
        lines.push(
          `## What This Schema Solves`,
          ``,
          ...liveDelta.problemsSolved.map(problem => `- ${problem}`),
          ``,
        );
      }

      if (liveDelta.benefits.length > 0) {
        lines.push(
          `## Benefits`,
          ``,
          ...liveDelta.benefits.map(benefit => `- ${benefit}`),
          ``,
        );
      }

      if (liveDelta.carryOverWarnings.length > 0) {
        lines.push(
          `## Live Baseline Warnings`,
          ``,
          ...liveDelta.carryOverWarnings.map(warning => `- ${warning}`),
          ``,
        );
      }

      lines.push(`---`, ``);
    }

    lines.push(
      `## Event Details`,
      ``,
    );

    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const sorted = [...schema.events].sort((a, b) =>
      (priorityOrder[a.priority as keyof typeof priorityOrder] ?? 1) -
      (priorityOrder[b.priority as keyof typeof priorityOrder] ?? 1)
    );

    for (const event of sorted) {
      lines.push(`### \`${event.eventName}\``);
      lines.push('');
      lines.push(`**Description:** ${event.description}`);
      lines.push('');
      lines.push(`| Field | Value |`);
      lines.push(`|-------|-------|`);
      lines.push(`| Trigger Type | \`${event.triggerType}\` |`);
      lines.push(`| Priority | ${event.priority} |`);
      if (event.elementSelector) {
        lines.push(`| Element Selector | \`${event.elementSelector}\` |`);
      }
      if (event.pageUrlPattern) {
        lines.push(`| Page Pattern | \`${event.pageUrlPattern}\` |`);
      }
      lines.push('');

      if (event.parameters.length > 0) {
        lines.push(`**Parameters:**`);
        lines.push('');
        lines.push(`| Parameter | Value | Description |`);
        lines.push(`|-----------|-------|-------------|`);
        for (const param of event.parameters) {
          lines.push(`| \`${param.name}\` | \`${param.value}\` | ${param.description} |`);
        }
        lines.push('');
      }

      if (event.notes) {
        lines.push(`> 📝 ${event.notes}`);
        lines.push('');
      }

      lines.push('---', '');
    }

    if (quota.customDimensionNames.length > 0) {
      lines.push(`## Custom Dimensions to Register in GA4`);
      lines.push('');
      lines.push(`The following parameters must be registered in **GA4 Admin → Custom Definitions → Custom Dimensions** (Scope: Event) before they appear in reports:`);
      lines.push('');
      for (const dim of quota.customDimensionNames) {
        lines.push(`- \`${dim}\``);
      }
      lines.push('');
      lines.push('---', '');
    }

    lines.push(`_Generated by event-tracking-skill_`);

    const spec = lines.join('\n');
    const outFile = path.join(artifactDir, 'event-spec.md');
    fs.writeFileSync(outFile, spec, 'utf-8');

    if (baseline && liveDelta) {
      const comparisonReport = generateTrackingPlanComparisonReport({
        schema,
        baseline,
        liveDelta,
      });
      fs.writeFileSync(comparisonOutFile, comparisonReport, 'utf-8');
    }

    refreshAndIndexWorkflowState(artifactDir);

    console.log(`\n✅ Event spec generated: ${outFile}`);
    console.log(`   ${schema.events.length} events documented`);
    if (liveDelta) {
      console.log(`   Live baseline comparison: ${liveDelta.reusedEventCount} reused, ${liveDelta.newEventCount} new`);
      if (liveDelta.problemsSolved.length > 0) {
        console.log(`   Solves: ${liveDelta.problemsSolved[0]}`);
      }
      if (baseline) {
        console.log(`   Comparison report: ${comparisonOutFile}`);
      }
    }
    if (quota.customDimensions > 0) {
      console.log(`   ${quota.customDimensions} custom dimensions listed`);
    }
    console.log(`   Workflow state: ${path.join(artifactDir, WORKFLOW_STATE_FILE)}`);
  });

program.parseAsync(process.argv).catch(err => {
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
