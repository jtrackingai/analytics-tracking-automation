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

Then interpret:

- blockers
- expected failures
- selector mismatches
- release readiness

If the user explicitly wants to publish after verification:

```bash
./event-tracking publish --context-file <artifact-dir>/gtm-context.json --version-name "GA4 Events v1 - <date>"
```

## Required Output

Produce and share:

- `<artifact-dir>/preview-report.md`
- `<artifact-dir>/preview-result.json`
- updated `<artifact-dir>/workflow-state.json`

## Stop Boundary

- stop after preview if the user only asked for QA
- publish only when the user explicitly wants to affect the live site

If the platform is Shopify, switch to the Shopify-specific rules in `tracking-shopify`.

## References

- [../../references/preview-report.md](../../references/preview-report.md)
- [../../references/gtm-troubleshooting.md](../../references/gtm-troubleshooting.md)
- [../../references/output-contract.md](../../references/output-contract.md)
