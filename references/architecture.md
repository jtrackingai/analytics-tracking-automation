# Architecture Reference

This reference keeps the install-facing architecture notes in the same shape that exported skill bundles use.

If you are working in the source repository, the repo-facing overview still lives at [../ARCHITECTURE.md](../ARCHITECTURE.md).

## Layers

| Layer | Responsibility | Public Surface |
| --- | --- | --- |
| Skill layer | Umbrella workflow routing and phase-specific skill entry points | [../SKILL.md](../SKILL.md), [skill-map.md](skill-map.md), separately installed phase skills |
| CLI layer | Deterministic commands for crawl, validation, GTM sync, preview, and publish | `event-tracking ...` |
| Artifact layer | Durable handoff files between steps | current files in artifact directory under `<output-root>/<url-slug>` plus per-run snapshots in `versions/<run-id>/` |
| Run index layer | Recent run discovery for resume workflows plus per-artifact output-root recovery | `.event-tracking-runs.jsonl` under the output root and `.event-tracking-run.json` inside each artifact directory |
| Reference layer | Domain rules for crawl, grouping, schema, preview, and Shopify behavior | `references/*.md` |

## Scenario Orchestration

The CLI now layers scenario orchestration on top of checkpoint execution:

- start a labeled scenario run: `start-scenario`
- run scenario templates: `run-new-setup`, `run-tracking-update`, `run-upkeep`, `run-health-audit`
- validate scenario readiness: `scenario-check`
- record scenario handoff with reason: `scenario-transition`

Guardrails:

- `tracking_health_audit` is audit-only by default
- deployment commands are blocked in that scenario unless explicitly forced
- scenario report commands are scenario-gated by intent

## Public Surface

Installed or linked skill bundles rely on:

- the public command `event-tracking`
- skill metadata in `agents/openai.yaml`
- artifact files documented in [output-contract.md](output-contract.md)

When working in the source repository, the repo-local wrapper is `./event-tracking`.

## Artifact Lifecycle

All workflow state lives inside one artifact directory for one site, with multiple versioned runs.

| Checkpoint | Required Inputs | Produces | Gate Type |
| --- | --- | --- | --- |
| `analyzed` | site URL | `site-analysis.json` | CLI-enforced |
| `grouped` | `site-analysis.json` | updated `pageGroups` | human or agent workflow |
| `group_approved` | grouped `site-analysis.json` | `pageGroupsReview.confirmedHash` in `site-analysis.json` | CLI-enforced |
| `live_gtm_analyzed` | approved `site-analysis.json` when live GTM IDs are detected | `live-gtm-analysis.json`, `live-gtm-review.md` | CLI-enforced when live GTM is present |
| `schema_prepared` | approved `site-analysis.json` | `schema-context.json`, Shopify bootstrap artifacts when applicable | CLI-enforced |
| `schema_approved` | `event-schema.json` | approved schema hash in `workflow-state.json`, schema restore snapshot, schema decision audit, and optional `event-spec.md` | CLI-enforced |
| `gtm_generated` | approved `event-schema.json` | `gtm-config.json` | CLI-enforced |
| `synced` | `gtm-config.json` | `gtm-context.json`, `credentials.json`, Shopify sync artifacts when applicable | CLI-enforced |
| `verified` | `event-schema.json`, `gtm-context.json` | `preview-report.md`, `preview-result.json`, `tracking-health.json`, `tracking-health-history/` | CLI-enforced for command execution; release readiness is derived from tracking health |
| `published` | `gtm-context.json`, non-blocking `tracking-health.json` unless forced | live GTM container version | human confirmation plus CLI execution |

Gate notes:

- `prepare-schema` enforces `group_approved`
- `prepare-schema` also enforces `live_gtm_analyzed` when `site-analysis.json` detected real GTM container IDs
- `generate-gtm` enforces `schema_approved` unless the user explicitly forces it
- `preview` writes tracking health plus timestamped history, and `publish` consumes that health as its release gate unless the user explicitly forces it
- `preview` and `publish` both write back into `workflow-state.json`

## Branching Model

The workflow branches after `analyze`:

- `generic`: standard schema authoring, GTM sync, automated preview, then publish
- `shopify`: shared early stages, Shopify bootstrap schema, Shopify custom pixel outputs after sync, then manual Shopify verification

Shared early stages:

- `analyze`
- page grouping
- page-group approval
- live GTM baseline audit when applicable
- schema preparation

Shopify-only outputs:

- `shopify-schema-template.json`
- `shopify-bootstrap-review.md`
- `shopify-custom-pixel.js`
- `shopify-install.md`

## Resume Semantics

The system supports partial intent, not just full end-to-end runs.

Resume rules:

- if the user only wants analysis, stop after `analyzed`
- if the user provides `site-analysis.json`, continue from grouping or schema prep depending on page-group status
- if the user provides `event-schema.json`, treat schema review and GTM generation as the default next stages
- if the user provides `gtm-config.json`, skip directly to `sync`
- if the user provides `gtm-context.json`, skip directly to `preview` or `publish`

Use `event-tracking status <artifact-dir-or-file>` when the next step is unclear.

Use `event-tracking runs <output-root>` when the artifact directory is unknown but the output root is known.

## Workflow State

`workflow-state.json` records:

- current checkpoint
- completed checkpoints
- scenario metadata (`scenario`, `subScenario`, `runId`, `runStartedAt`, optional `inputScope`)
- page-group review state
- live GTM baseline readiness
- schema review state
- verification status
- verification health grade, score, blockers, and unexpected-event count
- publish status
- artifact presence for schema audit, restore, run context, and tracking health outputs
- next recommended action and command

Treat it as the machine-readable checkpoint layer on top of the artifact files themselves.

## Skill Family

The skill family has:

- one umbrella skill: `event-tracking-skill`
- seven phase skills: `tracking-discover`, `tracking-group`, `tracking-live-gtm`, `tracking-schema`, `tracking-sync`, `tracking-verify`, `tracking-shopify`

Shopify handoff rule:

- `tracking-discover` and `tracking-group` still own the shared early stages
- once Shopify is confirmed, `tracking-shopify` becomes the governing branch contract
