---
name: tracking-sync
description: Use when the user wants GTM-ready config generation, GTM workspace sync, or container selection from an approved schema.
---

# Tracking Sync

Use this skill for Step 4 and Step 5 work.

## Inputs

One of:

- approved `<artifact-dir>/event-schema.json`
- existing `<artifact-dir>/gtm-config.json`

## Workflow

If GTM config does not exist yet:

```bash
./event-tracking generate-gtm <artifact-dir>/event-schema.json --measurement-id <G-XXXXXXXXXX>
```

Then sync:

```bash
./event-tracking sync <artifact-dir>/gtm-config.json
```

## Hard Rules

- Do not bypass schema approval unless the user explicitly wants `--force`.
- Treat custom dimensions as a blocking checklist before sync/publish.
- Never auto-select GTM account, container, or workspace for the user.
- Run OAuth-triggering commands outside sandboxed environments.

## Required Output

Produce and share:

- `<artifact-dir>/gtm-config.json`
- `<artifact-dir>/gtm-context.json`
- `<artifact-dir>/workflow-state.json`

For Shopify runs, also expect:

- `<artifact-dir>/shopify-custom-pixel.js`
- `<artifact-dir>/shopify-install.md`

## Closeout Style

- default to a short answer-first sync summary before listing files
- summarize what was generated or synced, what still needs manual selection or approval, and any blocking checklist items first
- keep file listings and follow-up commands after the summary

## Stop Boundary

Stop after sync unless the user explicitly asks for verification.

Default next phase:

```bash
./event-tracking preview <artifact-dir>/event-schema.json --context-file <artifact-dir>/gtm-context.json
```

## References

- [../../references/output-contract.md](../../references/output-contract.md)
- [../../references/gtm-troubleshooting.md](../../references/gtm-troubleshooting.md)
