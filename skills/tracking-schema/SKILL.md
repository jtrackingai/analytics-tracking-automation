---
name: tracking-schema
description: Use when the user wants schema preparation, event design, selector validation, schema review, or event-spec generation.
---

# Tracking Schema

Use this skill for Step 3 work only.

## Inputs

One of:

- confirmed `<artifact-dir>/site-analysis.json`
- existing `<artifact-dir>/event-schema.json`

## Workflow

## Role And Quality Bar

During schema work, act as an expert in event tracking design.

Your job is not to list generic events. Your job is to produce a tracking plan that is:

- aligned with common GA4 / GTM industry standards
- comprehensive enough to cover the site's meaningful business journeys
- accurate enough to be implemented and verified without guesswork
- disciplined enough to avoid noisy, redundant, or low-signal events
- easy for the user to review, approve, QA, and maintain

Favor event definitions that are business-meaningful, implementation-ready, and analytically useful.
Do not preserve weak legacy patterns just for continuity.
Do not inflate the schema with events that add little reporting or decision value.

If schema context is not prepared yet:

```bash
./event-tracking prepare-schema <artifact-dir>/site-analysis.json
```

If the site has a live GTM container installed, make sure `tracking-live-gtm` has already produced `<artifact-dir>/live-gtm-analysis.json` before running `prepare-schema`.

Then:

Run `validate-schema --check-selectors` outside sandboxed environments by default. Do not first attempt the Playwright selector check inside the sandbox and then retry after it is intercepted.

```bash
./event-tracking validate-schema <artifact-dir>/event-schema.json --check-selectors
./event-tracking generate-spec <artifact-dir>/event-schema.json
./event-tracking confirm-schema <artifact-dir>/event-schema.json
```

During review:

- explain what live tracking problems the schema fixes when `live-gtm-analysis.json` is present
- explain what benefits the new schema brings compared with the current live baseline
- default to a compact tracking-plan summary in this order: `Event Table`, `Common Properties`, `Event-specific Properties`
- keep long parameter inventories out of the main event table
- stop for user approval before GTM generation

## Required Output

Produce and share:

- `<artifact-dir>/event-schema.json`
- optional `<artifact-dir>/event-spec.md`
- optional `<artifact-dir>/tracking-plan-comparison.md` when `live-gtm-analysis.json` is present
- `<artifact-dir>/schema-decisions.jsonl` after schema confirmation
- `<artifact-dir>/schema-restore/` restore snapshots after schema confirmation
- updated `<artifact-dir>/workflow-state.json`

## Closeout Style

- default to a decision-ready tracking-plan summary before listing files
- keep the chat structure in this order: `Event Table`, `Common Properties`, `Event-specific Properties`
- if a live baseline comparison exists, keep it as a compact appendix rather than replacing the tracking-plan structure
- list files and next steps only after the summary

## Stop Boundary

Stop after schema approval.

Default next phase:

```bash
./event-tracking generate-gtm <artifact-dir>/event-schema.json --measurement-id <G-XXXXXXXXXX>
```

## References

- [../../references/event-schema-guide.md](../../references/event-schema-guide.md)
- [../../references/ga4-event-guidelines.md](../../references/ga4-event-guidelines.md)
- [../../references/output-contract.md](../../references/output-contract.md)
