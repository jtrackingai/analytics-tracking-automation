# Output Contract

Most generated files live inside a single artifact directory for the run.

The only output-root-level index is `.event-tracking-runs.jsonl`, which records recent artifact directories so a later session can find and resume them.

Each artifact directory also stores `.event-tracking-run.json`, which preserves the intended output root for later `runs` indexing and resume after directory moves.

- Required output root: pass `--output-root <dir>` to `analyze`, or enter it when the CLI prompts at startup
- The artifact directory for a URL is derived as `<output-root>/<url-slug>`

After the artifact directory is chosen, downstream commands should keep reading from and writing to that same directory.

## Files

| File | Description |
|------|-------------|
| `site-analysis.json` | Raw page structure from Playwright crawl — pages, interactive elements, page groups, and page-group confirmation metadata |
| `live-gtm-analysis.json` | Parsed summary of the site's real public GTM runtime, including existing live events, parameters, trigger hints, and the primary comparison container |
| `live-gtm-review.md` | Human-readable audit of the live GTM baseline and container comparison |
| `schema-context.json` | Compressed crawl data for AI event generation (auto-generated, do not edit) |
| `shopify-schema-template.json` | Shopify-only baseline event schema template generated during `prepare-schema`; use as the starting point for ecommerce custom events |
| `shopify-bootstrap-review.md` | Shopify-only human-readable review of baseline and inferred bootstrap events, including why each one was included and whether it should be kept, reviewed manually, or removed |
| `event-schema.json` | GA4 event plan — editable before generating GTM config. For Shopify runs, `prepare-schema` bootstraps this file automatically if it does not already exist |
| `event-spec.md` | Human-readable event specification for stakeholder review |
| `tracking-plan-comparison.md` | Human-readable comparison of existing live GTM tracking vs the generated event plan, including optimization points, expected benefits, and legacy issues; generated when `live-gtm-analysis.json` is present |
| `schema-decisions.jsonl` | Append-only schema confirmation audit, including added, changed, removed, and unchanged events compared with the previous confirmed snapshot when available |
| `schema-restore/` | Restore snapshots of confirmed `event-schema.json` versions, keyed by schema hash |
| `.event-tracking-run.json` | Run-context metadata for output-root recovery and run indexing |
| `workflow-state.json` | Machine-readable workflow checkpoint state, including schema confirmation, verification status, publish status, warnings, and next recommended step |
| `gtm-config.json` | GTM Web Container export JSON ready to sync, plus event-tracking metadata such as GA4 Measurement ID, configuration-tag target ID, and optional Google tag ID |
| `gtm-context.json` | Saved GTM account / container / workspace IDs for subsequent steps |
| `credentials.json` | URL-scoped Google OAuth token cache reused by `sync`, `preview`, and `publish` for this artifact directory; never commit this file |
| `preview-report.md` | Human-readable event firing verification report (failures categorized by type) |
| `preview-result.json` | Raw preview intercept data, including unexpected fired events outside the approved schema |
| `tracking-health.json` | Machine-readable preview health score, blockers, recommendations, unexpected-event summary, and optional baseline diff; Shopify manual verification uses `score: null` |
| `tracking-health-report.md` | Human-readable tracking-health summary (score/grade, blockers, recommendations, event status, and optional baseline comparison) |
| `tracking-health-history/` | Timestamped snapshots of every generated tracking health report |
| `shopify-custom-pixel.js` | Shopify-only artifact generated after `sync`; installs GTM inside Shopify Customer Events and bridges Shopify standard events into `dataLayer` |
| `shopify-install.md` | Shopify-only install instructions for the generated custom pixel |

## Editing Between Steps

`event-schema.json` is the primary editable artifact. The agent presents it as a table and waits for user confirmation before proceeding to GTM config generation. Any edits made here flow through to all downstream steps.

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
- Use `./event-tracking preview ... --baseline <previous-tracking-health.json>` to compare a new preview run with an older tracking health baseline. If omitted, an existing `tracking-health.json` in the same artifact directory is used as the baseline before it is overwritten.
- `publish` now requires a current non-blocking `tracking-health.json`; use `--force` only when you intentionally want to override a missing or blocked verification state.
- For Shopify sites, re-install `shopify-custom-pixel.js` after re-syncing to a different GTM container

## Directory Example

Example:

```
/tmp/output/example_com/
  site-analysis.json
  live-gtm-analysis.json
  live-gtm-review.md
  event-schema.json
  tracking-plan-comparison.md
  schema-decisions.jsonl
  schema-restore/
  .event-tracking-run.json
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
