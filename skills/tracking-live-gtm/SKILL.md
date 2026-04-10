---
name: tracking-live-gtm
description: Use when the user wants to inspect the real live GTM runtime before schema generation or compare multiple live GTM containers.
---

# Tracking Live GTM

Use this skill to audit the site's real live GTM setup before event generation.

## Inputs

One of:

- confirmed `<artifact-dir>/site-analysis.json`
- explicit live GTM public IDs when the crawl did not capture them

## Workflow

Run the live baseline step before schema preparation whenever the site has a real GTM container installed:

```bash
./event-tracking analyze-live-gtm <artifact-dir>/site-analysis.json
```

If multiple live containers matter and the user already knows the primary comparison target:

```bash
./event-tracking analyze-live-gtm <artifact-dir>/site-analysis.json --primary-container-id GTM-XXXXXXX
```

During review:

- show all detected live GTM containers
- explain which container is the primary comparison baseline
- summarize existing live events, measurement IDs, and obvious issues
- if this review is part of `tracking_health_audit`, clearly separate runtime-detected live definitions from any formal preview-verified automation evidence
- stop before schema authoring if the user wants to review the live baseline first

## Required Output

Produce and share:

- `<artifact-dir>/live-gtm-analysis.json`
- `<artifact-dir>/live-gtm-review.md`
- updated `<artifact-dir>/workflow-state.json`

## Closeout Style

- default to a compact live-tracking summary before listing files
- name the detected live events directly instead of only reporting event counts
- in `tracking_health_audit`, explicitly separate runtime-detected live definitions from formal preview-verified automation evidence
- list artifacts only after the decision-ready summary

## Stop Boundary

Stop after the live GTM baseline is reviewed unless the user explicitly asks to continue into schema work.

Default next phase:

```bash
./event-tracking prepare-schema <artifact-dir>/site-analysis.json
```

## References

- [../../references/event-schema-guide.md](../../references/event-schema-guide.md)
- [../../references/output-contract.md](../../references/output-contract.md)
- [../../references/architecture.md](../../references/architecture.md)
