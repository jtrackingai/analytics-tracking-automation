# Output Contract

Most generated files live inside a single artifact directory for the site.

The only output-root-level index is `.event-tracking-runs.jsonl`, which records recent artifact directories so a later session can find and resume them.

Each artifact directory also stores `.event-tracking-run.json`, which preserves the intended output root for later `runs` indexing and resume after directory moves, plus active run metadata.

- Required output root: pass `--output-root <dir>` to `analyze`, or enter it when the CLI prompts at startup
- The artifact directory for a URL is derived as `<output-root>/<url-slug>`

After the artifact directory is chosen, downstream commands keep reading and writing the current files in that directory.
At the same time, each write is snapshotted into `versions/<run-id>/...` so history is preserved without breaking existing command paths.

## Primary Workflow Artifacts

These are the files that usually matter for routing, approval gates, and the next command.

| File | Description |
|------|-------------|
| `site-analysis.json` | Raw page structure from Playwright crawl — pages, interactive elements, page groups, and page-group confirmation metadata |
| `live-gtm-analysis.json` | Parsed summary of the site's real public GTM runtime, including existing live events, parameters, trigger hints, and the primary comparison container |
| `schema-context.json` | Compressed crawl data for AI event generation (auto-generated, do not edit) |
| `event-schema.json` | GA4 event plan — editable before generating GTM config. For Shopify runs, `prepare-schema` bootstraps this file automatically if it does not already exist |
| `workflow-state.json` | Machine-readable workflow checkpoint state, including schema confirmation, verification status, publish status, warnings, and next recommended step |
| `gtm-config.json` | GTM Web Container export JSON ready to sync, plus event-tracking metadata such as GA4 Measurement ID, configuration-tag target ID, and optional Google tag ID |
| `gtm-context.json` | Saved GTM account / container / workspace IDs for subsequent steps |
| `preview-result.json` | Raw preview intercept data, including unexpected fired events outside the approved schema |
| `tracking-health.json` | Machine-readable preview health score, blockers, recommendations, unexpected-event summary, and optional baseline diff; Shopify manual verification uses `score: null` |
| `shopify-schema-template.json` | Shopify-only baseline event schema template generated during `prepare-schema`; use as the starting point for ecommerce custom events |
| `shopify-custom-pixel.js` | Shopify-only artifact generated after `sync`; installs GTM inside Shopify Customer Events and bridges Shopify standard events into `dataLayer` |
| `shopify-install.md` | Shopify-only install instructions for the generated custom pixel |

## Derived Reports

These are presentation or audit artifacts derived from the primary workflow files.

| File | Description |
|------|-------------|
| `live-gtm-review.md` | Human-readable audit of the live GTM baseline and container comparison |
| `live-preview-result.json` | Raw published-live verification intercept data captured from the site's existing GTM setup, including unexpected fired events outside the parsed live-event baseline |
| `live-preview-report.md` | Human-readable published-live verification report for existing GTM tags |
| `live-tracking-health.json` | Machine-readable health verdict for published-live GTM verification; kept separate from workspace/schema preview health |
| `event-spec.md` | Human-readable event specification for stakeholder review |
| `event-schema-diff-report.md` | Tracking Update schema diff against a chosen baseline schema |
| `tracking-update-change-summary.md` | Business-friendly Tracking Update change summary for stakeholder communication |
| `tracking-plan-comparison.md` | Human-readable comparison of existing live GTM tracking vs the generated event plan, including optimization points, expected benefits, and legacy issues; generated when `live-gtm-analysis.json` is present |
| `upkeep-schema-comparison-report.md` | Upkeep schema comparison summary (current recommendation vs baseline schema) |
| `upkeep-preview-report.md` | Upkeep preview summary with `healthy`, `failure`, `drift`, and `not_observable` status buckets |
| `upkeep-next-step-recommendation.md` | Upkeep recommendation that states whether to enter Tracking Update and whether it is `new_requests`, `legacy_maintenance`, or `both` |
| `tracking-health-schema-gap-report.md` | Tracking Health Audit schema-vs-live gap report with `missing_event`, `missing_parameter`, `weak_naming`, `partial_coverage`, and `high_value_page_gap` classifications |
| `tracking-health-preview-report.md` | Tracking Health Audit preview/validation summary with `healthy`, `failure`, and `not_observable` classifications |
| `tracking-health-next-step-recommendation.md` | Tracking Health Audit recommendation with explicit `Enter New Setup: yes/no` decision |
| `preview-report.md` | Human-readable event firing verification report (failures categorized by type) |
| `tracking-health-report.md` | Human-readable tracking-health summary (score/grade, blockers, recommendations, event status, and optional baseline comparison) |
| `tracking-health-history/` | Timestamped snapshots of every generated tracking health report |
| `shopify-bootstrap-review.md` | Shopify-only human-readable review of baseline and inferred bootstrap events, including why each one was included and whether it should be kept, reviewed manually, or removed |

## Internal Run Metadata And History

These files support approvals, restore points, indexing, and auditability. They usually should not be treated as primary user-facing deliverables.

| File | Description |
|------|-------------|
| `schema-decisions.jsonl` | Append-only schema confirmation audit, including added, changed, removed, and unchanged events compared with the previous confirmed snapshot when available |
| `schema-restore/` | Restore snapshots of confirmed `event-schema.json` versions, keyed by schema hash |
| `.event-tracking-run.json` | Run-context metadata for output-root recovery and run indexing |
| `mode-transitions.jsonl` | Append-only workflow mode transition audit log (from/to mode, run IDs, optional reason) |
| `versions/` | Per-run snapshots of generated artifacts, keyed by run ID |
| `versions/<run-id>/run-manifest.json` | Run metadata (`runId`, mode, sub-mode, run start, input scope) plus per-file snapshot records |
| `credentials.json` | Google OAuth refresh token that the user generated via Google's own consent screen, scoped to GTM write access. Stored per artifact directory and read locally by `sync`, `preview`, and `publish` when they call the official GTM API. See *Local Secrets* below. |

## Local Secrets

`credentials.json` is a user-owned credential artifact, handled the same way command-line tools like `gh` and `aws` handle local tokens:

- The token is produced by the user completing Google's own OAuth consent screen interactively; the skill never reads, scrapes, or derives it from anywhere else.
- The granted scope is GTM container read/write only. It is not a full-account token and cannot read mail, drive, contacts, or any other Google service.
- The file is stored inside the per-site artifact directory on the user's machine and is read only by `sync`, `preview`, and `publish` when those commands call `googleapis.tagmanager`. It is never transmitted to any third-party service, telemetry endpoint, or this skill's authors.
- Rotate or revoke at any time with `./event-tracking auth-clear --context-file <artifact-dir>/gtm-context.json` (per artifact) or `./event-tracking auth-clear --output-root <output-root>` (every cached token under a root).
- The file is gitignored; do not commit it, just as you would not commit `~/.config/gh/hosts.yml` or `~/.aws/credentials`.

## Editing Between Steps

`event-schema.json` is the primary editable artifact. The agent presents it as a table and waits for user confirmation before proceeding to GTM config generation. Any edits made here flow through to all downstream steps.

The following checkpoints are explicit approval gates and should never be auto-advanced without clear user confirmation:

- page-group approval (`confirm-page-groups`)
- schema approval (`confirm-schema`)
- GTM target selection during `sync` (account/container/workspace)
- publish decision (`publish`)

After the schema is approved, run `./event-tracking confirm-schema <artifact-dir>/event-schema.json`. That command stores a hash of the approved schema snapshot in `workflow-state.json`.

`confirm-schema` also writes a restore snapshot under `schema-restore/` and appends a schema decision audit entry to `schema-decisions.jsonl`.

`site-analysis.json` is editable at Step 1.5 (page group confirmation). Changes to `pageGroups` affect event scoping in the schema.

After the current grouping is approved, run `./event-tracking confirm-page-groups <artifact-dir>/site-analysis.json`. That command stores a hash of the approved `pageGroups` snapshot in `site-analysis.json`.

If `site-analysis.json` detected real GTM public IDs, run `./event-tracking analyze-live-gtm <artifact-dir>/site-analysis.json` before `prepare-schema`. The schema context is expected to include this live baseline so the generated events can fix or extend the current live tracking instead of ignoring it.

`prepare-schema` only continues when the stored confirmation hash still matches the current `pageGroups`. If the groups change later, the confirmation is treated as stale and must be recorded again.

`generate-gtm` only continues when the stored schema confirmation hash in `workflow-state.json` still matches the current `event-schema.json`. If the schema changes later, the confirmation is treated as stale and must be recorded again.

## Re-running Steps

- Re-run `generate-gtm` after editing `event-schema.json`
- Re-run `confirm-schema` after editing `event-schema.json`
- Re-run `sync` to push a corrected config. Stale `[JTracking]` managed entities are cleaned automatically.
- Re-run `preview` after sync to re-verify
- Run `./event-tracking verify-live-gtm <artifact-dir>/site-analysis.json` when you want best-effort verification of the currently published GTM setup without entering GTM workspace preview mode
- Use `./event-tracking preview ... --baseline <previous-tracking-health.json>` to compare a new preview run with an older tracking health baseline. If omitted, an existing `tracking-health.json` in the same artifact directory is used as the baseline before it is overwritten.
- `publish` now requires a current non-blocking `tracking-health.json`; use `--force` only when you intentionally want to override a missing or blocked verification state.
- For Shopify sites, re-install `shopify-custom-pixel.js` after re-syncing to a different GTM container
- Use `./event-tracking status <artifact-dir-or-file>` as the default resume command. It now shows both checkpoint guidance and workflow mode readiness.
- Use `./event-tracking status <artifact-dir-or-file> --mode-only` when you only need workflow mode readiness instead of the full workflow status.
- Use high-level template commands for user-facing entry flows: `run-new-setup`, `run-tracking-update`, `run-upkeep`, `run-health-audit`
- Workflow mode metadata remains in workflow state and run history, but no longer needs a separate low-level command surface for normal use.
- The `analyze --mode/--sub-mode/--input-scope` flags set workflow mode metadata directly.
- Workflow mode requirements are loaded through `src/workflow/mode-requirements.ts` from `src/workflow/mode-requirements.json`.
- In workflow mode `tracking_health_audit`, deployment commands (`generate-gtm`, `sync`, `publish`) are blocked by default because this mode is audit-only
- `run-health-audit` should not produce `gtm-config.json`; this mode is assessment-only
- Reporting commands are also mode-gated (for example `generate-upkeep-report` is intended for `upkeep`, and `generate-health-audit-report` is intended for `tracking_health_audit`)

## Directory Example

Example:

```
/tmp/output/example_com/
  site-analysis.json
  live-gtm-analysis.json
  live-gtm-review.md
  live-preview-result.json
  live-preview-report.md
  live-tracking-health.json
  event-schema.json
  event-schema-diff-report.md
  tracking-update-change-summary.md
  tracking-plan-comparison.md
  upkeep-schema-comparison-report.md
  upkeep-preview-report.md
  upkeep-next-step-recommendation.md
  tracking-health-schema-gap-report.md
  tracking-health-preview-report.md
  tracking-health-next-step-recommendation.md
  schema-decisions.jsonl
  schema-restore/
  .event-tracking-run.json
  mode-transitions.jsonl
  versions/
    20260409T120501Z-ab12cd/
      run-manifest.json
      event-schema.json
      workflow-state.json
  workflow-state.json
  gtm-config.json
  gtm-context.json
  credentials.json
  preview-report.md
  preview-result.json
  tracking-health.json
  tracking-health-report.md
  tracking-health-history/
  shopify-bootstrap-review.md   # Shopify only
  shopify-schema-template.json   # Shopify only
  shopify-custom-pixel.js        # Shopify only
  shopify-install.md             # Shopify only
```
