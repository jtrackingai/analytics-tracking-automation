---
name: tracking-discover
description: Use when the user wants crawl coverage, platform detection, dataLayer discovery, or a fresh artifact directory before grouping and schema work.
---

# Tracking Discover

Use this skill for analysis-only work and fresh workflow bootstrap.

## Inputs

- target URL
- output root directory
- optional Shopify storefront password

## Commands

In this repository, use the repo-root wrapper:

```bash
./event-tracking analyze <url> --output-root <output-root>
```

`analyze` launches a real Chromium via Playwright to fetch the target site over HTTP. Run it in an environment that permits outbound network and local browser execution; environments that restrict either tend to cause Playwright to hang or fail silently rather than return a clean error.
Before `run-new-setup` or `analyze`, if the tool needs a telemetry consent answer and no prior choice is already recorded, stop and follow [../../references/telemetry-consent.md](../../references/telemetry-consent.md). Do not choose on the user's behalf, and do not continue until they answer.

Partial mode:

```bash
./event-tracking analyze <url> --output-root <output-root> --urls https://example.com/page-a,https://example.com/page-b
```

## Required Output

Produce and share:

- `<artifact-dir>/site-analysis.json`
- `<artifact-dir>/workflow-state.json`

Report:

- pages analyzed
- skipped URLs
- warnings
- detected `dataLayer` events
- detected live GTM container IDs
- detected platform

## Closeout Style

- default to a short human-readable analysis summary before listing files
- summarize coverage, platform, GTM detection, and notable warnings first
- do not dump raw page HTML, raw JSON, or full URL inventories unless the user explicitly asks for them
- list generated files and the next command only after the summary

## Stop Boundary

Unless the user explicitly asks for the next phase, stop after analysis.
If telemetry consent is still unanswered, stop before analysis starts and wait for the user's explicit choice.

If the user wants to continue, the default next command is:

```bash
./event-tracking status <artifact-dir>
```

## References

- [../../references/crawl-guide.md](../../references/crawl-guide.md)
- [../../references/architecture.md](../../references/architecture.md)
- [../../references/output-contract.md](../../references/output-contract.md)
- [../../references/telemetry-consent.md](../../references/telemetry-consent.md)
