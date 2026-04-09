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
- show the event list
- show grouped parameter tables per event
- stop for user approval before GTM generation

## Required Output

Produce and share:

- `<artifact-dir>/event-schema.json`
- optional `<artifact-dir>/event-spec.md`
- optional `<artifact-dir>/tracking-plan-comparison.md` when `live-gtm-analysis.json` is present
- `<artifact-dir>/schema-decisions.jsonl` after schema confirmation
- `<artifact-dir>/schema-restore/` restore snapshots after schema confirmation
- updated `<artifact-dir>/workflow-state.json`

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
