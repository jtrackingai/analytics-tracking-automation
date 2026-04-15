# Skills

Install-facing skill bundles keep the matching runtime reference at [../references/skill-map.md](../references/skill-map.md).

This page is user-facing. Its job is to help you choose the right skill entry point, not to restate the full internal workflow contract.

## Start Here

Most users should start with the umbrella skill:

- `event-tracking-skill`

Use it when:

- you want end-to-end help
- you are not sure which phase to start from
- you want to work through the flow in conversation instead of picking commands yourself

The umbrella skill owns first-turn conversational intake for chat entry points. It should interpret user intent in plain language before choosing a high-level entry path or phase.

## Skill Map

<!-- contract-generated:user-skill-map:start -->
| Skill | Best For | What The User Usually Says |
| --- | --- | --- |
| `event-tracking-skill` | end-to-end routing | "Help me set up or review tracking for this site" |
| `tracking-discover` | site inspection and bootstrap | "Analyze this site first" |
| `tracking-group` | page-group review | "Group these pages by business meaning" |
| `tracking-live-gtm` | live GTM baseline review | "Show me what is already live in GTM" |
| `tracking-schema` | event-plan design and approval | "Help me design or review the event schema" |
| `tracking-sync` | GTM generation and sync | "Generate or sync the GTM setup" |
| `tracking-verify` | preview QA and release readiness | "Check whether tracking is healthy before publish" |
| `tracking-shopify` | Shopify-specific branch | "This is a Shopify storefront" |
<!-- contract-generated:user-skill-map:end -->

## Recommended Default

- If the request is broad or ambiguous, use `event-tracking-skill`.
- If the user already has a specific artifact such as `site-analysis.json` or `event-schema.json`, move directly to the matching phase skill.
- If the platform is Shopify, keep discovery and grouping shared, then switch to `tracking-shopify` for the Shopify-specific branch.

## Quick Routing Guide

### `event-tracking-skill`

Use this when you want the agent to figure out the right starting point and keep the conversation moving.

Typical user asks:

- "Set up GA4 + GTM tracking for this site."
- "Resume this existing artifact directory."
- "I need an upkeep review."
- "Run a health audit and tell me if we should repair or rebuild."

### `tracking-discover`

Use this when the user wants analysis only.

Typical outcomes:

- crawl coverage
- platform detection
- detected GTM IDs
- a fresh artifact directory

### `tracking-group`

Use this when the user wants page groups reviewed in business language.

### `tracking-live-gtm`

Use this when the user wants to understand the real live GTM baseline before schema work starts.

### `tracking-schema`

Use this when the user wants event design or event-plan review.

### `tracking-sync`

Use this when the user is ready to move an approved plan into GTM.

### `tracking-verify`

Use this when the user wants preview QA, health interpretation, or publish readiness.

### `tracking-shopify`

Use this when the run is clearly on the Shopify branch.

## Design Rules

- The root skill remains the stable entry point for environments that only load one skill.
- The root skill should stay an umbrella router and shared contract, not a long phase-by-phase runbook.
- The root skill should not ask the user to choose between internal workflow metadata flags and `analyze`.
- Root and phase closeouts should default to answer-first summaries, with files and artifact references listed only after the human-readable summary.
- Phase skills are intentionally thin. They should help with one bounded part of the workflow and stop when that phase is complete.
- Shared mechanics live in the CLI, artifact contract, and root references. Phase skills should not fork those contracts.
- Workflow mode metadata is an internal run-labeling layer. Default user-facing guidance should prefer `status` plus the high-level template commands.

## Where The Details Live

- For artifact and checkpoint details, use [../references/output-contract.md](../references/output-contract.md).
- For lifecycle and resume semantics, use [../references/architecture.md](../references/architecture.md).
- For the install-facing phase map, use [../references/skill-map.md](../references/skill-map.md).

## Packaging Note

Inside this repository, the skill family lives under `skills/`.

`skills/manifest.json` remains the source-of-truth inventory for the shipped skill family.

Each skill also has minimal UI metadata in `agents/openai.yaml`.

If you need installation or export details, use:

- [README.install.md](README.install.md)
