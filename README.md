# Event Tracking Skill

`event-tracking-skill` is a local-first skill and CLI for planning, generating, and validating GA4 event tracking in Google Tag Manager.

It turns a website into a reviewable tracking workflow: analyze the site, group pages by business purpose, generate an event schema, create GTM configuration, sync to a GTM workspace, verify in Preview Mode, and publish with more confidence.

## What You Get

For a given website, this skill can help you:

- generate GTM-ready configuration for your website, including tags, triggers, and variables, and sync it into your GTM workspace
- produce an automated verification report based on GTM Preview Mode before publish
- keep the whole implementation flow reviewable through site analysis, schema review, and preview validation

## What It Does

- Analyze a website and identify its main page types, shared UI, and business flows, so tracking starts from real user journeys instead of isolated URLs
- Group pages by business purpose instead of treating every URL separately, so shared interactions and page-specific behaviors can be modeled more cleanly
- Generate a reviewable GA4 event schema for key CTAs and conversion actions, so those events can be used in GA4 to measure progress against business goals
- Turn the approved schema into GTM-ready tags, triggers, and variables, so the tracking plan becomes implementation-ready instead of staying as a static spec
- Sync to GTM and run preview verification before publish, so setup issues can be caught before they affect the live site
- Support both generic websites and Shopify storefronts, with different validation paths when needed

## Installation

Clone the repository and install dependencies:

```bash
git clone <your-repo-url>
cd event-tracking-skill-master
npm ci
npm run build
```

After that, the CLI should work locally with:

```bash
./dist/cli.js --help
```

## Quick Start

### Use It As A Skill

If you are using this in an agent environment, call it in natural language:

```text
Use event-tracking-skill to set up GA4 / GTM tracking for <website-url>.
Use <output-directory> as the artifact directory.
GA4 Measurement ID is <G-XXXXXXXXXX>.
Google tag ID is <GT-XXXXXXX> if needed.
```

Example:

```text
Use event-tracking-skill to set up GA4 / GTM tracking for https://www.example.com.
Use ./output/example-run as the artifact directory.
GA4 Measurement ID is G-XXXXXXXXXX.
```

### Use It As A CLI

Run CLI help:

```bash
./dist/cli.js --help
```

Start with site analysis:

```bash
./dist/cli.js analyze https://www.example.com --output-dir ./output/example-run
```

Then prepare schema context:

```bash
./dist/cli.js prepare-schema ./output/example-run/site-analysis.json
```

From there, continue with schema review, GTM generation, sync, preview, and publish.

The full workflow is documented in [SKILL.md](SKILL.md).

## Required Inputs

Before running the full workflow, prepare:

- target website URL
- output directory for generated artifacts
- GA4 Measurement ID
- optional Google tag ID

The artifact directory is required for every run.

## Workflow

The workflow is designed to stay reviewable from start to finish.

| Step                         | What It Does                                                 | CLI                                                          | Main Output                                         |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------- |
| Analyze                      | Crawls the site and captures page structure, shared UI, warnings, detected events, and platform signals | `./dist/cli.js analyze <url> --output-dir <artifact-dir>`    | `site-analysis.json`                                |
| Page Grouping                | Organizes pages into business-purpose groups and prepares schema context for event generation | `./dist/cli.js prepare-schema <artifact-dir>/site-analysis.json` | updated `site-analysis.json`, `schema-context.json` |
| Schema Generation And Review | Builds a GA4 event schema, checks selectors, and generates a reviewable event spec | `./dist/cli.js validate-schema <artifact-dir>/event-schema.json --check-selectors` and `./dist/cli.js generate-spec <artifact-dir>/event-schema.json` | `event-schema.json`, `event-spec.md`                |
| GTM Generation               | Converts the approved schema into GTM-ready tags, triggers, and variables | `./dist/cli.js generate-gtm <artifact-dir>/event-schema.json --measurement-id <G-XXXXXXXXXX>` | `gtm-config.json`                                   |
| GTM Sync                     | Authenticates with Google, lets you choose the target GTM workspace, and syncs the generated configuration | `./dist/cli.js sync <artifact-dir>/gtm-config.json`          | `gtm-context.json`                                  |
| Preview Verification         | Runs GTM Preview-based verification and reports which events fired, failed, or need review | `./dist/cli.js preview <artifact-dir>/event-schema.json --context-file <artifact-dir>/gtm-context.json` | `preview-report.md`, `preview-result.json`          |
| Publish                      | Publishes the validated GTM workspace as a new container version | `./dist/cli.js publish --context-file <artifact-dir>/gtm-context.json --version-name "GA4 Events v1"` | published GTM version                               |


## Product Boundary

- The core workflow runs locally
- It does not require JTracking product authorization
- GTM sync is handled through Google OAuth
- Selector-based events may still need review when the site uses unstable or highly dynamic markup
- Shopify verification differs from the standard automated GTM preview flow

## Need A More Advanced Setup?

This skill reflects the implementation workflow behind [JTracking](https://www.jtracking.ai).

If you need a more advanced setup, JTracking also supports:

- richer event design based on business scenarios
- server-side tracking and custom loader support
- more channel connections such as GA4, Meta, Google Ads, TikTok, and Klaviyo
- longer-term, unified tracking management

## License

MIT