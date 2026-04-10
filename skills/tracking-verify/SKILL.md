---
name: tracking-verify
description: Use when the user wants preview QA, failure interpretation, release readiness, or an explicit publish handoff.
---

# Tracking Verify

Use this skill for verification and optional publish handoff.

## Inputs

- `<artifact-dir>/event-schema.json`
- `<artifact-dir>/gtm-context.json`

## Workflow

Run preview:

```bash
./event-tracking preview <artifact-dir>/event-schema.json --context-file <artifact-dir>/gtm-context.json
```

If comparing against an older preview run, pass the previous health baseline:

```bash
./event-tracking preview <artifact-dir>/event-schema.json --context-file <artifact-dir>/gtm-context.json --baseline <previous-tracking-health.json>
```

Run `preview` outside sandboxed environments by default. Do not first attempt the Playwright browser step inside the sandbox and then retry after it is intercepted.

Then interpret:

- blockers
- expected failures
- selector mismatches
- unexpected fired events outside the approved schema
- release readiness

If the user explicitly wants to publish after verification:

```bash
./event-tracking publish --context-file <artifact-dir>/gtm-context.json --version-name "GA4 Events v1 - <date>"
```

If `tracking-health.json` is missing, still manual-only, or has blockers, `publish` now stops by default. Only use `--force` when the user explicitly wants to override that gate.

## Required Output

Produce and share:

- `<artifact-dir>/preview-report.md`
- `<artifact-dir>/preview-result.json`
- `<artifact-dir>/tracking-health.json`
- `<artifact-dir>/tracking-health-report.md`
- `<artifact-dir>/tracking-health-history/`
- updated `<artifact-dir>/workflow-state.json`

## Closeout Style

- default to a verification verdict first: healthy, blocked, or manual follow-up required
- summarize blockers, unexpected events, and release-readiness in plain language before listing files
- keep raw preview data and artifact references after the summary

## Stop Boundary

- stop after preview if the user only asked for QA
- publish only when the user explicitly wants to affect the live site

If the platform is Shopify, switch to the Shopify-specific rules in `tracking-shopify`.

## References

- [../../references/preview-report.md](../../references/preview-report.md)
- [../../references/gtm-troubleshooting.md](../../references/gtm-troubleshooting.md)
- [../../references/output-contract.md](../../references/output-contract.md)
