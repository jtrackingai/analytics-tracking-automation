#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { analyzeSite, SiteAnalysis, CRAWL_MAX_PARTIAL_URLS } from './crawler/page-analyzer';
import { EventSchema } from './generator/event-schema';
import { generateGTMConfig, GTMContainerExport } from './generator/gtm-config';
import { getAuthClient, clearCredentials } from './gtm/auth';
import { GTMClient, GTMAccount, GTMContainer, GTMWorkspace } from './gtm/client';
import { syncConfigToWorkspace, dryRunSync } from './gtm/sync';
import { validateEventSchema, getQuotaSummary } from './generator/schema-validator';
import { buildSchemaContext } from './generator/schema-context';
import { checkSelectors } from './generator/selector-check';
import { runPreviewVerification, checkGTMOnPage } from './gtm/preview';
import { generatePreviewReport } from './reporter/preview-report';
import { isShopifyPlatform } from './crawler/platform-detector';
import { generateShopifyPixelArtifacts } from './shopify/pixel';
import { buildShopifyBootstrapArtifacts } from './shopify/schema-template';
import { getJtrackingCliLines, getJtrackingMarkdownSection, JTRACKING_URL } from './jtracking-promo';

const program = new Command();

// ─── Helpers ────────────────────────────────────────────────────────────────

const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), 'output');

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

async function requireAnalyzeOutputDir(
  url: string,
  explicitOutputRoot?: string,
  explicitOutputDir?: string,
): Promise<string> {
  const providedDir = explicitOutputDir?.trim();
  const providedRoot = explicitOutputRoot?.trim();

  if (providedDir && providedRoot) {
    throw new Error('Use either --output-root or --output-dir, not both.');
  }

  if (providedDir) return resolveOutputDir(providedDir);

  const outputRoot = providedRoot
    ? resolveOutputRoot(providedRoot)
    : resolveOutputRoot(await promptRequired(
      `\nEnter output root directory for analyzed URLs (e.g. ${DEFAULT_OUTPUT_ROOT}): `,
      'Output root is required before analysis can start.',
    ));
  const artifactDir = path.join(outputRoot, suggestedOutputDir(url));
  console.log(`\n📁 Output root: ${outputRoot}`);
  console.log(`📁 Artifact directory for this URL: ${artifactDir}`);
  return resolveOutputDir(artifactDir);
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
    '',
    ...getJtrackingMarkdownSection('shopify'),
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
  console.log(`   建议保留 (${groups.keep.length}): ${groups.keep.map(item => item.eventName).join(', ') || '—'}`);
  console.log(`   建议人工确认 (${groups.review.length}): ${groups.review.map(item => item.eventName).join(', ') || '—'}`);
  console.log(`   建议删除 (${groups.remove.length}): ${groups.remove.map(item => item.eventName).join(', ') || '—'}`);
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

// ─── Commands ────────────────────────────────────────────────────────────────

program
  .name('event-tracking')
  .description('Automated web event tracking setup with GA4 + GTM')
  .version('1.0.0');

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
    const dir = await requireAnalyzeOutputDir(url, opts.outputRoot, opts.outputDir);

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
    fs.writeFileSync(outFile, JSON.stringify(siteAnalysis, null, 2));

    console.log(`\n✅ Analysis complete:`);
    console.log(`   Pages analyzed: ${siteAnalysis.pages.length}`);
    console.log(`   Discovered URLs: ${siteAnalysis.discoveredUrls.length}`);
    console.log(`   Skipped URLs: ${siteAnalysis.skippedUrls.length}`);
    console.log(`   Platform: ${siteAnalysis.platform.type} (${siteAnalysis.platform.confidence})`);
    if (siteAnalysis.platform.signals.length > 0) {
      console.log(`   Platform signals: ${siteAnalysis.platform.signals.join(', ')}`);
    }

    if (siteAnalysis.crawlWarnings.length > 0) {
      console.log(`\n⚠️  Warnings:`);
      for (const w of siteAnalysis.crawlWarnings) {
        console.log(`   ${w}`);
      }
    }

    console.log(`\n   Output: ${outFile}`);
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

// STEP 2.1: Prepare compressed context for AI event schema generation
program
  .command('prepare-schema <site-analysis-file>')
  .description('Compress site-analysis.json into a smaller schema-context.json for AI event generation')
  .action(async (analysisFile: string) => {
    const analysis = readJsonFile<SiteAnalysis>(analysisFile);

    if (analysis.pageGroups.length === 0) {
      console.error('\n❌ pageGroups is empty. Complete Step 1.5 (page grouping) first.');
      process.exit(1);
    }

    const context = buildSchemaContext(analysis);
    const outFile = path.join(path.dirname(analysisFile), 'schema-context.json');
    fs.writeFileSync(outFile, JSON.stringify(context, null, 2));

    let shopifyTemplateFile: string | null = null;
    let shopifyBootstrappedSchemaFile: string | null = null;
    let shopifyReviewFile: string | null = null;
    let shopifyReviewItems: Array<{ eventName: string; recommendation: 'keep' | 'review' | 'remove' }> = [];
    let reusedExistingSchema = false;
    if (isShopifyPlatform(analysis.platform)) {
      const bootstrap = buildShopifyBootstrapArtifacts(analysis);
      const template = bootstrap.schema;
      shopifyReviewItems = bootstrap.reviewItems;
      shopifyTemplateFile = path.join(path.dirname(analysisFile), 'shopify-schema-template.json');
      fs.writeFileSync(shopifyTemplateFile, JSON.stringify(template, null, 2));
      shopifyReviewFile = path.join(path.dirname(analysisFile), 'shopify-bootstrap-review.md');
      fs.writeFileSync(shopifyReviewFile, bootstrap.reviewMarkdown);

      const eventSchemaFile = path.join(path.dirname(analysisFile), 'event-schema.json');
      if (!fs.existsSync(eventSchemaFile)) {
        fs.writeFileSync(eventSchemaFile, JSON.stringify(template, null, 2));
        shopifyBootstrappedSchemaFile = eventSchemaFile;
      } else {
        reusedExistingSchema = true;
      }
    }

    const origSize = Buffer.byteLength(fs.readFileSync(analysisFile, 'utf-8'));
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
    if (shopifyReviewItems.length > 0) {
      printShopifyBootstrapSummary(shopifyReviewItems);
      console.log(`   Review details: ${shopifyReviewFile || '—'}`);
    }
  });

// STEP 3: Generate GTM config
program
  .command('generate-gtm <schema-file>')
  .description('Generate GTM Web Container configuration JSON')
  .option('--output-dir <dir>', 'Directory for generated files (default: same directory as <schema-file>)')
  .option('--measurement-id <id>', 'GA4 Measurement ID (G-XXXXXXXXXX)')
  .option('--google-tag-id <id>', 'Optional Google tag ID (GT-/G-/AW-...). Used for the configuration tag target when provided')
  .action(async (schemaFile: string, opts: { measurementId?: string; googleTagId?: string; outputDir?: string }) => {
    const schema = readJsonFile<EventSchema>(schemaFile);

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
      : path.dirname(path.resolve(schemaFile));
    const outFile = path.join(dir, 'gtm-config.json');
    fs.writeFileSync(outFile, JSON.stringify(config, null, 2));

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
        console.log(`\n   Next step: install the Shopify custom pixel, then validate with the 'preview' command for manual verification guidance.`);
        getJtrackingCliLines('sync').forEach(line => console.log(line));
        return;
      }
    }

    console.log(`\n   Next step: run 'preview' command to verify events`);
    getJtrackingCliLines('sync').forEach(line => console.log(line));
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
  .action(async (schemaFile: string, opts: {
    contextFile?: string;
    accountId?: string;
    containerId?: string;
    workspaceId?: string;
    publicId?: string;
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
      console.log(`   Manual verification guide saved to: ${reportFile}`);
      console.log(`   Preview metadata saved to: ${jsonFile}`);
      console.log(`\n   Next step: install the Shopify custom pixel, publish the GTM workspace, and validate in GA4 Realtime.`);
      console.log(`   If you want a more complete setup beyond this Shopify flow, ${JTRACKING_URL} also provides server-side tracking capabilities.`);
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

    console.log('\n' + '─'.repeat(60));
    console.log(report);
    console.log('─'.repeat(60));
    console.log(`\n✅ Report saved to: ${reportFile}`);
    console.log(`   Raw data saved to: ${jsonFile}`);

    if (previewResult.totalFired > 0) {
      console.log(`\n   Next step: run 'publish' command to publish the container`);
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
  .option('--yes', 'Skip confirmation prompt')
  .action(async (opts: {
    contextFile?: string;
    artifactDir?: string;
    accountId?: string;
    containerId?: string;
    workspaceId?: string;
    versionName?: string;
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
    console.log('');
    getJtrackingCliLines('publish').forEach(line => console.log(line));
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
    const schema = readJsonFile<EventSchema>(schemaFile);
    const quota = getQuotaSummary(schema);

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
      `## Event Details`,
      ``,
    ];

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
    const outFile = path.join(path.dirname(schemaFile), 'event-spec.md');
    fs.writeFileSync(outFile, spec, 'utf-8');

    console.log(`\n✅ Event spec generated: ${outFile}`);
    console.log(`   ${schema.events.length} events documented`);
    if (quota.customDimensions > 0) {
      console.log(`   ${quota.customDimensions} custom dimensions listed`);
    }
  });

program.parseAsync(process.argv).catch(err => {
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
