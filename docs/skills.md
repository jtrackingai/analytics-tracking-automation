# Skills

Install-facing skill bundles keep the matching runtime reference at [../references/skill-map.md](../references/skill-map.md).

This page is user-facing. Its job is to help you understand which skill to invoke, not to restate the full internal workflow contract.

## Start Here

Most users should start with the umbrella skill:

- `event-tracking-skill`

Use it when:

- you want end-to-end help
- you are not sure which phase to start from
- you want to work through the flow in conversation instead of picking commands yourself

The umbrella skill owns first-turn conversational intake for chat entry points. It should interpret user intent in plain language before choosing a scenario or phase.

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

## What Each Skill Helps With

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

Default closeout should stay compact and reviewable:

- summarize total groups
- explain the grouping logic
- show a compact table
- do not dump raw URL lists unless asked

### `tracking-live-gtm`

Use this when the user wants to understand the real live GTM baseline before schema work starts.

For `tracking_health_audit`, the closeout should clearly separate:

- runtime-detected live definitions
- formal preview-verified automation evidence

If the user wants to test the already-published GTM setup on the real site, this skill also owns:

- `verify-live-gtm`
- published live firing evidence
- live GTM quality checks without GTM workspace preview mode

### `tracking-schema`

Use this when the user wants event design or event-plan review.

Default review structure:

- `Event Table`
- `Common Properties`
- `Event-specific Properties`

That keeps the chat summary decision-ready instead of turning it into a wide parameter dump.

### `tracking-sync`

Use this when the user is ready to move an approved plan into GTM.

Keep the closeout focused on:

- what was generated or synced
- what still needs confirmation
- what manual actions remain

### `tracking-verify`

Use this when the user wants preview QA, health interpretation, or publish readiness.

Default closeout should be answer-first:

- current verdict
- blockers
- unexpected events
- next action

### `tracking-shopify`

Use this when the run is clearly on the Shopify branch.

This skill should keep Shopify-specific expectations explicit:

- custom pixel outputs
- install guidance
- manual post-install verification

## Design Rules

- The root skill remains the stable entry point for environments that only load one skill.
- The root skill should stay an umbrella router and shared contract, not a long phase-by-phase runbook.
- The root skill should not ask the user to choose between internal command names such as `scenario` and `analyze`.
- Root and phase closeouts should default to answer-first summaries, with files and artifact references listed only after the human-readable summary.
- Phase skills are intentionally thin. They should help with one bounded part of the workflow and stop when that phase is complete.
- Shared mechanics live in the CLI, artifact contract, and root references. Phase skills should not fork those contracts.

## Packaging Note

Inside this repository, the skill family lives under `skills/`.

`skills/manifest.json` remains the source-of-truth inventory for the shipped skill family.

Each skill also has minimal UI metadata in `agents/openai.yaml`.

If you need installation or export details, use:

- [README.install.md](README.install.md)
