# Event Tracking Skill

`event-tracking-skill` is a local-first skill and CLI for planning, generating, validating, and syncing GA4 event tracking in Google Tag Manager.

It keeps the implementation reviewable from crawl to publish:

1. analyze a site
2. group pages by business intent
3. prepare schema context
4. review the event schema
5. generate GTM config
6. sync to a GTM workspace
7. verify in Preview Mode or the Shopify manual flow
8. publish with more confidence

## What You Get

For a given website, this skill can help you:

- analyze page structure, shared UI, platform signals, and existing `dataLayer` usage
- organize pages into business-purpose groups before defining events
- generate a reviewable GA4 event schema and stakeholder-friendly event spec
- turn the approved schema into GTM-ready tags, triggers, and variables
- sync to GTM, verify before publish, and keep the whole flow artifact-driven
- resume recent runs, audit schema decisions, and compare preview health against a baseline
- support both generic websites and Shopify storefronts with different verification paths

## Installation

### Install Into A Local Agent Skills Directory (Recommended)

There are two install paths:

- if you already have this repository checked out locally, use the built-in installer below
- if you do not want to clone the repository, skip to `npx skills add ...`

Most users only need the umbrella skill.

If you want the built-in installer, first clone the repo and run the installer from the repo root:

```bash
git clone https://github.com/jtrackingai/event-tracking-skill.git
cd event-tracking-skill
npm run install:skills
```

That installs `event-tracking-skill` into the default skills directory with installer-managed auto-update metadata.
You do not need `npm ci` just to install the exported skill bundles.

If you already know you want the full phase-oriented family installed together, make that explicit:

```bash
npm run install:skills -- --with-phases
```

This is the recommended install path for Codex and also the most portable path for other agent environments that can load skills from a local directory.

Codex defaults:

- `$CODEX_HOME/skills` when `CODEX_HOME` is set
- otherwise `~/.codex/skills`

For other agent runtimes, point the installer at that runtime's skills directory:

```bash
npm run install:skills -- --target-dir /path/to/agent/skills
```

If you also want the phase skills in a custom directory:

```bash
npm run install:skills -- --target-dir /path/to/agent/skills --with-phases
```

For local development only, if you want the installed skills to stay pointed at local exported bundles:

```bash
npm run install:skills -- --mode link
```

To link the full skill family during local iteration:

```bash
npm run install:skills -- --mode link --with-phases
```

Auto-update behavior:

- `copy` installs are the recommended user path and can self-check for newer GitHub versions
- `link` installs are for local development only and intentionally do not auto-update from GitHub
- older installer-managed copies need one reinstall through `npm run install:skills` before they gain the installed auto-update bootstrap

Use [docs/README.codex.md](docs/README.codex.md) for Codex-specific defaults, update notes, and troubleshooting.
Use [docs/README.install.md](docs/README.install.md) for the full shared agent-install guide.

### Install with skills.sh (Alternative)

Use this if you want to install the skill into your local agent skills directory without cloning the repository first.

```bash
npx skills add jtrackingai/event-tracking-skill
```

This portable install can self-check for updates too. On the first successful self-update it rewrites the installed copy into the repo's normal copy-mode layout.

If you want the full umbrella + phase-skill family installed together from the start, use `npm run install:skills -- --with-phases`.

If you want the repo-local CLI, contributor setup, or local development workflow, use [DEVELOPING.md](DEVELOPING.md) instead of treating README as a maintainer guide.

## Documentation Map

- [README.md](README.md) for installation, quick start, and the public command surface
- [docs/README.install.md](docs/README.install.md) for the shared agent-install flow, copy vs link behavior, and auto-update notes
- [ARCHITECTURE.md](ARCHITECTURE.md) for artifact lifecycle, branch behavior, and system boundaries
- [DEVELOPING.md](DEVELOPING.md) for maintainer commands, edit rules, and release checks
- [docs/README.codex.md](docs/README.codex.md) for Codex-specific defaults and troubleshooting on top of the generic installer flow
- [docs/skills.md](docs/skills.md) for the umbrella skill and phase-skill map
- [SKILL.md](SKILL.md) for the agent-facing workflow contract

## Skill Family

The repository now has:

- one umbrella skill: `event-tracking-skill`
- seven phase-oriented subskills under `skills/`: `tracking-discover`, `tracking-group`, `tracking-live-gtm`, `tracking-schema`, `tracking-sync`, `tracking-verify`, `tracking-shopify`

Use the umbrella skill for end-to-end or ambiguous requests. Use the phase skills when the user clearly wants only one part of the workflow, such as discovery, grouping, live GTM baseline review, schema review, GTM sync, preview QA, or Shopify-specific handling.

See [docs/skills.md](docs/skills.md) for the full map.

Root skill UI metadata now lives in [agents/openai.yaml](agents/openai.yaml).

## Exported Skill Bundles

If you need to package these skills outside this repository, generate self-contained bundles with:

```bash
npm run export:skills
```

That writes per-skill bundles to `dist/skill-bundles/<skill-name>/`.

Each exported bundle includes:

- `SKILL.md`
- `agents/openai.yaml`
- the `references/` files that the skill may need, including exported `architecture.md` and `skill-map.md` where relevant

The exported bundles rewrite command examples to the public `event-tracking` command name. Inside this repository, keep using `./event-tracking`.

## Quick Start

### Scenario-First (Recommended)

Use scenario templates as the default entry point. They create a new scenario run, keep versioned history, and generate scenario-specific deliverables when inputs are ready.

```bash
# New implementation from scratch
./event-tracking run-new-setup ./output/example_com

# Incremental update for existing tracking
./event-tracking run-tracking-update ./output/example_com --baseline-schema ./output/example_com/schema-restore/confirmed-<hash>.json

# Routine upkeep check
./event-tracking run-upkeep ./output/example_com --baseline-schema ./output/example_com/schema-restore/confirmed-<hash>.json

# Audit-only health assessment before deciding rebuild
./event-tracking run-health-audit ./output/example_com --live-gtm-analysis ./output/example_com/live-gtm-analysis.json
```

Use these helpers when needed:

- `./event-tracking scenario-check <artifact-dir>` to verify required inputs for the current scenario
- `./event-tracking scenario-transition <artifact-dir> --to <scenario> --reason "<why>"` to record scenario handoff decisions
- `./event-tracking runs <output-root> --json` to inspect recent runs with scenario summary

Scenario guardrails:

- `tracking_health_audit` is audit-only. `generate-gtm`, `sync`, and `publish` are blocked by default unless explicitly forced.
- Scenario report commands are intent-gated (for example, upkeep report commands require `upkeep`).

### Use It As A Skill

If you are using this in an agent environment, call it in natural language and provide the current workflow inputs:

```text
Use event-tracking-skill to set up GA4 / GTM tracking for https://www.example.com.
Use ./output as the output root directory.
GA4 Measurement ID is G-XXXXXXXXXX.
Google tag ID is GT-XXXXXXX if needed.
```

The skill creates the run artifact directory as `<output-root>/<url-slug>` and then walks through grouping, conditional live GTM baseline review, schema review, GTM generation, sync, preview, and publish.

### Use It As A CLI

Start with site analysis:

```bash
./event-tracking analyze https://www.example.com --output-root ./output
```

The CLI creates the artifact directory automatically as `<output-root>/<url-slug>`, for example `./output/example_com`.

After filling and reviewing `pageGroups` in `./output/example_com/site-analysis.json`, continue with the same artifact directory:

```bash
./event-tracking confirm-page-groups ./output/example_com/site-analysis.json
# If site-analysis.json detected real GTM public IDs, run this before prepare-schema:
./event-tracking analyze-live-gtm ./output/example_com/site-analysis.json
./event-tracking prepare-schema ./output/example_com/site-analysis.json
./event-tracking validate-schema ./output/example_com/event-schema.json --check-selectors
./event-tracking generate-spec ./output/example_com/event-schema.json
./event-tracking confirm-schema ./output/example_com/event-schema.json
./event-tracking generate-gtm ./output/example_com/event-schema.json --measurement-id G-XXXXXXXXXX
./event-tracking sync ./output/example_com/gtm-config.json
./event-tracking preview ./output/example_com/event-schema.json --context-file ./output/example_com/gtm-context.json
./event-tracking publish --context-file ./output/example_com/gtm-context.json --version-name "GA4 Events v1"
```

Execution environment note:

- Run `analyze`, `validate-schema --check-selectors`, `preview`, and `sync` outside sandboxed environments by default.
- `analyze`, selector checking, and `preview` launch Playwright. `sync` may need a local OAuth callback on `127.0.0.1`.

Important workflow note:

- `prepare-schema` requires `pageGroups` to already be filled in `site-analysis.json` and explicitly confirmed
- after grouping pages, run `./event-tracking confirm-page-groups <artifact-dir>/site-analysis.json`
- if `site-analysis.json` detected real GTM public IDs, run `./event-tracking analyze-live-gtm <artifact-dir>/site-analysis.json` before `prepare-schema`
- for generic sites, `event-schema.json` is authored after `prepare-schema` from `schema-context.json`
- for Shopify sites, `prepare-schema` bootstraps `event-schema.json` automatically if it does not already exist
- `publish` now checks `tracking-health.json` before going live; use `--force` only when you intentionally want to override missing or blocking verification health

The full workflow used by the skill is documented in [SKILL.md](SKILL.md).

## Common Entry Points

You do not need to run the full flow every time.

| Intent | Start From | Minimum Inputs | Typical Command(s) |
| --- | --- | --- | --- |
| Find recent runs | Output root | output root | `./event-tracking runs ./output` |
| Inspect current progress | Any artifact directory or file inside it | artifact directory or file path | `./event-tracking status <artifact-dir>` |
| Analyze a new site | Step 1 | URL, output root | `./event-tracking analyze <url> --output-root <dir>` |
| Review or approve page groups | Step 2 | `site-analysis.json` | update `pageGroups`, then `./event-tracking confirm-page-groups <artifact-dir>/site-analysis.json` |
| Review the live GTM baseline before schema prep | Step 3 | approved `site-analysis.json` with detected live GTM IDs, or explicit primary GTM ID | `./event-tracking analyze-live-gtm <artifact-dir>/site-analysis.json [--primary-container-id GTM-XXXXXXX]` |
| Author or review schema | Step 4 | approved `site-analysis.json` or existing `event-schema.json` | `prepare-schema`, edit `event-schema.json`, `validate-schema`, `generate-spec`, `confirm-schema` |
| Generate GTM config from an approved schema | Step 5 | `event-schema.json`, measurement ID | `./event-tracking generate-gtm <artifact-dir>/event-schema.json --measurement-id <id>` |
| Sync an approved GTM config | Step 6 | `gtm-config.json` | `./event-tracking sync <artifact-dir>/gtm-config.json` |
| QA an existing GTM workspace | Step 7 | `event-schema.json`, `gtm-context.json` | `./event-tracking preview <artifact-dir>/event-schema.json --context-file <artifact-dir>/gtm-context.json` |
| Publish an already-verified workspace | Step 8 | `gtm-context.json`, current `tracking-health.json` | `./event-tracking publish --context-file <artifact-dir>/gtm-context.json --version-name "GA4 Events v1"` |

Scenario-oriented reporting commands:

- `./event-tracking generate-update-report <artifact-dir>/event-schema.json [--baseline-schema <file>]`
- `./event-tracking generate-upkeep-report <artifact-dir>/event-schema.json [--baseline-schema <file>] [--health-file <file>]`
- `./event-tracking generate-health-audit-report <artifact-dir>/event-schema.json [--live-gtm-analysis <file>]`
- `./event-tracking start-scenario <new_setup|tracking_update|upkeep|tracking_health_audit> <artifact-dir> [--sub-scenario ...] [--input-scope ...]`
- `./event-tracking scenario-transition <artifact-dir> --to <scenario> [--to-sub-scenario ...] [--reason ...] [--no-new-run]`
- `./event-tracking scenario-check <artifact-dir> [--json]`
- `./event-tracking run-new-setup <artifact-dir> [--input-scope ...]`
- `./event-tracking run-tracking-update <artifact-dir> [--schema-file ...] [--baseline-schema ...]`
- `./event-tracking run-upkeep <artifact-dir> [--schema-file ...] [--baseline-schema ...] [--health-file ...]`
- `./event-tracking run-health-audit <artifact-dir> [--schema-file ...] [--live-gtm-analysis ...]`

Scenario gate note:

- `tracking_health_audit` is treated as audit-only and blocks `generate-gtm`, `sync`, and `publish` unless explicitly forced.
- Scenario reporting commands are gated by scenario intent: upkeep reports require `upkeep`, health-audit reports require `tracking_health_audit`.
- `runs --json` now includes a `scenarioSummary` section with per-scenario counts and latest run pointers.

If a user already has an artifact directory, resume from the earliest unmet prerequisite instead of restarting from `analyze`. If they only know the output root, use `./event-tracking runs <output-root>` to find recent artifact directories.

## Required Inputs

Before running the full workflow, prepare:

- target website URL
- output root directory for generated artifacts
- GA4 Measurement ID
- optional Google tag ID

The artifact directory is required for every downstream step and is derived as `<output-root>/<url-slug>`.

## Workflow

The current workflow mixes agent-led review steps with CLI execution steps.

| Step | Owner | What It Does | Command / Output |
| --- | --- | --- | --- |
| Analyze | CLI | Crawls the site and captures pages, shared UI, warnings, detected events, and platform signals | `./event-tracking analyze <url> --output-root <output-root>` -> `site-analysis.json` |
| Page Grouping | Agent or user | Fills `pageGroups` in `site-analysis.json` by business purpose before schema preparation | updated `site-analysis.json` |
| Page Group Confirmation | User + CLI | Reviews the current page groups and records explicit approval for the current `pageGroups` snapshot | `./event-tracking confirm-page-groups <artifact-dir>/site-analysis.json` -> updated `site-analysis.json` |
| Live GTM Baseline Audit | CLI | Reviews the site's real public GTM runtime before schema generation when live GTM container IDs were detected during analysis | `./event-tracking analyze-live-gtm <artifact-dir>/site-analysis.json` -> `live-gtm-analysis.json`, `live-gtm-review.md` |
| Prepare Schema Context | CLI | Compresses grouped analysis plus any reviewed live GTM baseline for schema authoring and bootstraps Shopify artifacts when needed | `./event-tracking prepare-schema <artifact-dir>/site-analysis.json` -> `schema-context.json`, Shopify bootstrap files |
| Schema Authoring And Review | Agent or user + CLI validation | Creates or refines `event-schema.json`, validates selectors, generates a readable spec, emits a live-baseline comparison report when available, records schema approval, and keeps restore/audit history | `validate-schema`, `generate-spec`, `confirm-schema` -> `event-schema.json`, `event-spec.md`, `tracking-plan-comparison.md` (when live baseline exists), `schema-decisions.jsonl`, `schema-restore/`, `workflow-state.json` |
| GTM Generation | CLI | Converts the approved schema into GTM-ready tags, triggers, and variables | `./event-tracking generate-gtm <artifact-dir>/event-schema.json --measurement-id <G-XXXXXXXXXX>` -> `gtm-config.json` |
| GTM Sync | CLI | Authenticates with Google, requires explicit account/container/workspace selection, and syncs the generated configuration | `./event-tracking sync <artifact-dir>/gtm-config.json` -> `gtm-context.json`, `credentials.json` |
| Verification | CLI | Runs GTM preview for generic sites, records unexpected fired events, writes tracking health JSON plus a human-readable health report and timestamped health history, or writes a Shopify manual verification guide instead | `./event-tracking preview <artifact-dir>/event-schema.json --context-file <artifact-dir>/gtm-context.json` -> `preview-report.md`, `preview-result.json`, `tracking-health.json`, `tracking-health-report.md`, `tracking-health-history/` |
| Publish | CLI | Publishes the validated GTM workspace as a new container version, but only after current tracking health is present and non-blocking unless the user explicitly passes `--force` | `./event-tracking publish --context-file <artifact-dir>/gtm-context.json --version-name "GA4 Events v1"` |

## Generic vs Shopify Branch

After `analyze`, the run still shares grouping, page-group approval, and live GTM baseline review when applicable before the generic and Shopify-specific schema behavior diverges:

- `generic`: follow the standard schema authoring, GTM sync, and automated preview flow
- `shopify`: use Shopify bootstrap artifacts after the shared early stages, generate a Shopify custom pixel after `sync`, and use manual post-install verification instead of the normal automated browser preview

Shopify-specific behavior today:

- `prepare-schema` writes `shopify-schema-template.json` and `shopify-bootstrap-review.md`
- `prepare-schema` initializes `event-schema.json` automatically when it does not exist yet
- `sync` generates `shopify-custom-pixel.js` and `shopify-install.md`
- `preview` skips automated browser validation and writes manual Shopify verification guidance instead

For the detailed Shopify branch, see [references/shopify-workflow.md](references/shopify-workflow.md).

## Main Artifacts

Artifacts now follow a site-level directory with versioned runs:

- current files under `<output-root>/<url-slug>/`
- run snapshots under `<output-root>/<url-slug>/versions/<run-id>/`
- scenario handoff audit in `scenario-transitions.jsonl`

For the complete and always-current artifact list (including scenario deliverables), see [references/output-contract.md](references/output-contract.md).

## GTM Selection Rule

During `sync`, GTM target selection is a required user-confirmation step.

- never auto-select the GTM account, container, or workspace for the user
- always show the candidate list and require explicit user confirmation at each selection step
- a matching domain name or a likely production-looking option is not enough to justify auto-selection
- only skip a selection step when the user has already provided the exact GTM ID for that step

## Important Notes

- prefer `--output-root` for `analyze`; `--output-dir` is only a deprecated exact artifact-directory override
- `analyze` supports partial mode with `--urls` for specific same-domain pages
- `analyze` also supports `--storefront-password` for password-protected Shopify dev stores
- when `site-analysis.json` contains real GTM public IDs, `prepare-schema` requires `analyze-live-gtm` first so schema design can compare against the current live baseline
- `generate-gtm` will surface any custom dimensions that must be registered in GA4 before you continue
- `generate-gtm` now requires a current schema confirmation; use `./event-tracking confirm-schema <artifact-dir>/event-schema.json` after schema review
- selector-based events may still need review when the site uses unstable or highly dynamic markup
- `preview` now scores only the schema events that are actually verified in automation, persists unexpected fired events, and keeps timestamped health history snapshots
- `publish` now blocks when preview health is missing, still manual-only, or contains blockers; use `--force` only for an intentional override
- Shopify validation differs from the standard automated GTM preview flow

## Maintenance

- `npm test` rebuilds the CLI and runs the standalone automated workflow-state and gate tests.
- `npm run doctor` checks Node, the built CLI artifact, the repo-local wrapper, and the Playwright Chromium install.
- `npm run export:skills` writes self-contained skill bundles to `dist/skill-bundles/` for packaging outside the repo.
- `npm run install:skills` installs the umbrella bundle into `$CODEX_HOME/skills` or `~/.codex/skills`, with optional `--target-dir`, `--skill`, and `--with-phases` controls.
- copy-mode installed bundles can now check GitHub for a newer `VERSION` and self-update the selected installed bundle set.
- `npm run install:skills -- --mode link` links the selected exported bundles into the skills directory instead of copying them, which is useful during local iteration.
- `npm run check` rebuilds the CLI, runs automated tests, smoke-tests `./event-tracking --help`, exports and installs skill bundles into a temp directory, and enforces the public command surface in docs.

## Product Boundary

- the core workflow runs locally
- it does not require JTracking product authorization
- GTM sync is handled through Google OAuth
- generic sites are validated through GTM Preview Mode
- Shopify stores use custom pixel artifacts plus manual validation after installation

## Need A More Advanced Setup?

This skill reflects the implementation workflow behind [JTracking](https://www.jtracking.ai).

If you need a more advanced setup, JTracking also supports:

- richer event design based on business scenarios
- server-side tracking and custom loader support
- more channel connections such as GA4, Meta, Google Ads, TikTok, and Klaviyo
- longer-term, unified tracking management

## License

This project is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full text.

Use of the JTracking name, logo, and other brand assets is not granted under this license.
