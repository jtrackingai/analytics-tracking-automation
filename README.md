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
- support both generic websites and Shopify storefronts with different verification paths

## Installation

Clone the repository and install dependencies:

```bash
git clone git@github.com:jtrackingai/event-tracking-skill.git
cd event-tracking-skill
npm ci
npm run build
```

`npm ci` also installs Playwright's Chromium browser, which is required by the crawl and preview steps.

After that, the CLI should work locally with:

```bash
node dist/cli.js --help
```

## Quick Start

### Use It As A Skill

If you are using this in an agent environment, call it in natural language and provide the current workflow inputs:

```text
Use event-tracking-skill to set up GA4 / GTM tracking for https://www.example.com.
Use ./output as the output root directory.
GA4 Measurement ID is G-XXXXXXXXXX.
Google tag ID is GT-XXXXXXX if needed.
```

The skill creates the run artifact directory as `<output-root>/<url-slug>` and then walks through grouping, schema review, GTM generation, sync, preview, and publish.

### Use It As A CLI

Start with site analysis:

```bash
node dist/cli.js analyze https://www.example.com --output-root ./output
```

The CLI creates the artifact directory automatically as `<output-root>/<url-slug>`, for example `./output/example_com`.

After filling `pageGroups` in `./output/example_com/site-analysis.json`, continue with the same artifact directory:

```bash
node dist/cli.js confirm-page-groups ./output/example_com/site-analysis.json
node dist/cli.js prepare-schema ./output/example_com/site-analysis.json
node dist/cli.js validate-schema ./output/example_com/event-schema.json --check-selectors
node dist/cli.js generate-spec ./output/example_com/event-schema.json
node dist/cli.js generate-gtm ./output/example_com/event-schema.json --measurement-id G-XXXXXXXXXX
node dist/cli.js sync ./output/example_com/gtm-config.json
node dist/cli.js preview ./output/example_com/event-schema.json --context-file ./output/example_com/gtm-context.json
node dist/cli.js publish --context-file ./output/example_com/gtm-context.json --version-name "GA4 Events v1"
```

Important workflow note:

- `prepare-schema` requires `pageGroups` to already be filled in `site-analysis.json` and explicitly confirmed
- after grouping pages, run `node dist/cli.js confirm-page-groups <artifact-dir>/site-analysis.json`
- for generic sites, `event-schema.json` is authored after `prepare-schema` from `schema-context.json`
- for Shopify sites, `prepare-schema` bootstraps `event-schema.json` automatically if it does not already exist

The full workflow used by the skill is documented in [SKILL.md](SKILL.md).

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
| Analyze | CLI | Crawls the site and captures pages, shared UI, warnings, detected events, and platform signals | `node dist/cli.js analyze <url> --output-root <output-root>` -> `site-analysis.json` |
| Page Grouping | Agent or user | Fills `pageGroups` in `site-analysis.json` by business purpose before schema preparation | updated `site-analysis.json` |
| Page Group Confirmation | User + CLI | Reviews the current page groups and records explicit approval for the current `pageGroups` snapshot | `node dist/cli.js confirm-page-groups <artifact-dir>/site-analysis.json` -> updated `site-analysis.json` |
| Prepare Schema Context | CLI | Compresses grouped analysis for schema authoring and bootstraps Shopify artifacts when needed | `node dist/cli.js prepare-schema <artifact-dir>/site-analysis.json` -> `schema-context.json`, Shopify bootstrap files |
| Schema Authoring And Review | Agent or user + CLI validation | Creates or refines `event-schema.json`, validates selectors, and generates a readable spec for review | `validate-schema`, `generate-spec` -> `event-schema.json`, `event-spec.md` |
| GTM Generation | CLI | Converts the approved schema into GTM-ready tags, triggers, and variables | `node dist/cli.js generate-gtm <artifact-dir>/event-schema.json --measurement-id <G-XXXXXXXXXX>` -> `gtm-config.json` |
| GTM Sync | CLI | Authenticates with Google, requires explicit account/container/workspace selection, and syncs the generated configuration | `node dist/cli.js sync <artifact-dir>/gtm-config.json` -> `gtm-context.json`, `credentials.json` |
| Verification | CLI | Runs GTM preview for generic sites, or writes a Shopify manual verification guide instead | `node dist/cli.js preview <artifact-dir>/event-schema.json --context-file <artifact-dir>/gtm-context.json` -> `preview-report.md`, `preview-result.json` |
| Publish | CLI | Publishes the validated GTM workspace as a new container version | `node dist/cli.js publish --context-file <artifact-dir>/gtm-context.json --version-name "GA4 Events v1"` |

## Generic vs Shopify Branch

After `analyze`, the workflow splits into two branches:

- `generic`: follow the standard page grouping, schema authoring, GTM sync, and automated preview flow
- `shopify`: keep the same crawl and grouping steps, but use Shopify bootstrap artifacts, generate a Shopify custom pixel after `sync`, and use manual post-install verification instead of the normal automated browser preview

Shopify-specific behavior today:

- `prepare-schema` writes `shopify-schema-template.json` and `shopify-bootstrap-review.md`
- `prepare-schema` initializes `event-schema.json` automatically when it does not exist yet
- `sync` generates `shopify-custom-pixel.js` and `shopify-install.md`
- `preview` skips automated browser validation and writes manual Shopify verification guidance instead

For the detailed Shopify branch, see [references/shopify-workflow.md](references/shopify-workflow.md).

## Main Artifacts

All generated files live inside one artifact directory for the run.

| File | Description |
| --- | --- |
| `site-analysis.json` | Crawl output with pages, platform signals, and page groups |
| `schema-context.json` | Compressed context used for event schema authoring |
| `event-schema.json` | Primary editable tracking schema before GTM generation |
| `event-spec.md` | Human-readable event spec for stakeholder review |
| `gtm-config.json` | GTM Web Container export plus tracking metadata |
| `gtm-context.json` | Saved GTM account, container, and workspace IDs |
| `credentials.json` | Local Google OAuth token cache for this artifact directory |
| `preview-report.md` | Human-readable verification report |
| `preview-result.json` | Raw preview verification data |
| `shopify-schema-template.json` | Shopify-only bootstrap schema template |
| `shopify-bootstrap-review.md` | Shopify-only bootstrap review summary |
| `shopify-custom-pixel.js` | Shopify-only custom pixel artifact generated after `sync` |
| `shopify-install.md` | Shopify-only install guide for the generated custom pixel |

For the full output contract, see [references/output-contract.md](references/output-contract.md).

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
- `generate-gtm` will surface any custom dimensions that must be registered in GA4 before you continue
- selector-based events may still need review when the site uses unstable or highly dynamic markup
- Shopify validation differs from the standard automated GTM preview flow

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
