# Output Contract

All generated files live inside a single artifact directory for the run.

- Required output root: pass `--output-root <dir>` to `analyze`, or enter it when the CLI prompts at startup
- The artifact directory for a URL is derived as `<output-root>/<url-slug>`

After the artifact directory is chosen, downstream commands should keep reading from and writing to that same directory.

## Files

| File | Description |
|------|-------------|
| `site-analysis.json` | Raw page structure from Playwright crawl — pages, interactive elements, page groups |
| `schema-context.json` | Compressed crawl data for AI event generation (auto-generated, do not edit) |
| `shopify-schema-template.json` | Shopify-only baseline event schema template generated during `prepare-schema`; use as the starting point for ecommerce custom events |
| `shopify-bootstrap-review.md` | Shopify-only human-readable review of baseline and inferred bootstrap events, including why each one was included and whether it should be kept, reviewed manually, or removed |
| `event-schema.json` | GA4 event plan — editable before generating GTM config. For Shopify runs, `prepare-schema` bootstraps this file automatically if it does not already exist |
| `event-spec.md` | Human-readable event specification for stakeholder review |
| `gtm-config.json` | GTM Web Container export JSON ready to sync, plus event-tracking metadata such as GA4 Measurement ID, configuration-tag target ID, and optional Google tag ID |
| `gtm-context.json` | Saved GTM account / container / workspace IDs for subsequent steps |
| `credentials.json` | URL-scoped Google OAuth token cache reused by `sync`, `preview`, and `publish` for this artifact directory; never commit this file |
| `preview-report.md` | Human-readable event firing verification report (failures categorized by type) |
| `preview-result.json` | Raw preview intercept data |
| `shopify-custom-pixel.js` | Shopify-only artifact generated after `sync`; installs GTM inside Shopify Customer Events and bridges Shopify standard events into `dataLayer` |
| `shopify-install.md` | Shopify-only install instructions for the generated custom pixel |

## Editing Between Steps

`event-schema.json` is the primary editable artifact. The agent presents it as a table and waits for user confirmation before proceeding to GTM config generation. Any edits made here flow through to all downstream steps.

`site-analysis.json` is editable at Step 1.5 (page group confirmation). Changes to `pageGroups` affect event scoping in the schema.

## Re-running Steps

- Re-run `generate-gtm` after editing `event-schema.json`
- Re-run `sync` to push a corrected config. Stale `[JTracking]` managed entities are cleaned automatically.
- Re-run `preview` after sync to re-verify
- For Shopify sites, re-install `shopify-custom-pixel.js` after re-syncing to a different GTM container

## Directory Example

Example:

```
/tmp/output/example_com/
  site-analysis.json
  event-schema.json
  gtm-config.json
  gtm-context.json
  credentials.json
  preview-report.md
  preview-result.json
  shopify-bootstrap-review.md   # Shopify only
  shopify-schema-template.json   # Shopify only
  shopify-custom-pixel.js        # Shopify only
  shopify-install.md             # Shopify only
```
