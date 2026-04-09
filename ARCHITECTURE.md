# Architecture

Install-facing skill bundles keep the matching runtime reference at [references/architecture.md](references/architecture.md).

`event-tracking-skill` is a local-first tracking workflow system with four layers:

| Layer | Responsibility | Public Surface |
| --- | --- | --- |
| Skill layer | Umbrella workflow routing and phase-specific skill frontends | [SKILL.md](SKILL.md), [docs/skills.md](docs/skills.md), `skills/*/SKILL.md` |
| CLI layer | Deterministic commands for crawl, validation, GTM sync, preview, and publish | `./event-tracking ...` |
| Artifact layer | Durable handoff files between steps | current files in artifact directory under `<output-root>/<url-slug>` plus per-run snapshots in `versions/<run-id>/` |
| Reference layer | Domain rules for crawl, grouping, schema, preview, and Shopify behavior | `references/*.md` |

## Scenario Orchestration

On top of checkpoint-based execution, the CLI now has scenario orchestration primitives for delivery workflows:

- explicit scenario run start: `start-scenario`
- guided templates: `run-new-setup`, `run-tracking-update`, `run-upkeep`, `run-health-audit`
- scenario readiness check: `scenario-check`
- auditable handoff: `scenario-transition`

Scenario-specific guardrails:

- `tracking_health_audit` is audit-only by default
- deployment commands (`generate-gtm`, `sync`, `publish`) are blocked in that scenario unless explicitly overridden
- scenario report commands are intent-gated to reduce accidental misuse

## Public vs Internal Interfaces

Public interfaces:

- `./setup`
- `./event-tracking`
- `npm run doctor`
- `npm run check`
- artifact files documented in [references/output-contract.md](references/output-contract.md)

Internal implementation details:

- `dist/cli.js`
- `src/*`
- internal helper output that is not part of the documented artifact contract

Documentation and skill examples should refer to the public interfaces, not `node dist/cli.js`.

## Artifact Lifecycle

All workflow state lives inside a single artifact directory for one site, with multiple versioned runs.

| Checkpoint | Required Inputs | Produces | Gate Type |
| --- | --- | --- | --- |
| `analyzed` | site URL | `site-analysis.json` | CLI-enforced |
| `grouped` | `site-analysis.json` | updated `pageGroups` | human/agent workflow |
| `group_approved` | grouped `site-analysis.json` | `pageGroupsReview.confirmedHash` in `site-analysis.json` | CLI-enforced |
| `live_gtm_analyzed` | approved `site-analysis.json` when live GTM IDs are detected | `live-gtm-analysis.json`, `live-gtm-review.md` | CLI-enforced when live GTM is present |
| `schema_prepared` | approved `site-analysis.json` | `schema-context.json`, Shopify bootstrap artifacts when applicable | CLI-enforced |
| `schema_approved` | `event-schema.json` | approved schema hash in `workflow-state.json` and optional `event-spec.md` | CLI-enforced |
| `gtm_generated` | approved `event-schema.json` | `gtm-config.json` | CLI-enforced |
| `synced` | `gtm-config.json` | `gtm-context.json`, `credentials.json`, Shopify sync artifacts when applicable | CLI-enforced |
| `verified` | `event-schema.json`, `gtm-context.json` | `preview-report.md`, `preview-result.json` | CLI-enforced for command execution; release decision remains human |
| `published` | `gtm-context.json` | live GTM container version | human confirmation + CLI execution |

Notes:

- `group_approved` is enforced by `prepare-schema`.
- `prepare-schema` also enforces `live_gtm_analyzed` when `site-analysis.json` detected real GTM container IDs.
- `schema_approved` is enforced by `generate-gtm`, which now requires a matching confirmed schema hash in `workflow-state.json` unless explicitly forced.
- `verified` and `published` are recorded in `workflow-state.json` after the corresponding commands complete.

## Branching Model

The workflow branches after the shared early stages:

- `generic`: standard schema authoring, GTM sync, automated browser preview, then publish
- `shopify`: same crawl and grouping flow, Shopify bootstrap schema, custom pixel artifacts after sync, manual verification guidance instead of normal automated preview

Shared early stages:

- `analyze`
- page grouping
- page-group approval
- live GTM baseline audit when applicable
- schema preparation

Shopify-specific outputs:

- `shopify-schema-template.json`
- `shopify-bootstrap-review.md`
- `shopify-custom-pixel.js`
- `shopify-install.md`

## Resume Semantics

The system should support partial intent, not just full end-to-end runs.

Resume rules:

- if the user only wants analysis, stop after `analyzed`
- if the user provides `site-analysis.json`, continue from grouping, live GTM baseline review, or schema prep depending on page-group approval and whether detected live GTM IDs have already been reviewed
- if the user provides `event-schema.json`, treat schema review and GTM generation as the default next stages
- if the user provides `gtm-config.json`, skip directly to `sync`
- if the user provides `gtm-context.json`, skip directly to `preview` or `publish`

This repo now expresses those entry points through both CLI commands and phase-specific skill frontends.

## Workflow State File

The artifact directory now also contains `workflow-state.json`.

It records:

- current checkpoint
- completed checkpoints
- scenario, sub-scenario, run ID, run start time, optional input scope
- page-group review state
- live GTM baseline readiness
- schema review state
- verification status
- publish status
- next recommended action and command

`workflow-state.json` is the explicit machine-readable state layer that sits on top of the existing artifact files.

## Skill Family Structure

The repository now keeps:

- one umbrella skill at the repo root
- phase skills under `skills/`

The root skill still matters because:

- some environments may load only one installed skill
- cross-phase requests still need a single stable router
- the artifact contract remains shared across all phases
- the root skill is now the umbrella routing contract rather than the primary place for per-phase runbook detail

The phase skills exist to narrow scope and stop boundaries:

- `tracking-discover`
- `tracking-group`
- `tracking-live-gtm`
- `tracking-schema`
- `tracking-sync`
- `tracking-verify`
- `tracking-shopify`

Shopify handoff rule:

- `tracking-discover` and `tracking-group` still handle the shared early stages
- once the platform is confirmed as Shopify, `tracking-shopify` becomes the governing branch contract for Shopify-specific schema bootstrap, sync outputs, install handoff, and verification behavior
