---
name: tracking-shopify
description: Use when the platform is Shopify or the run needs the Shopify-specific schema, sync, install, or verification branch.
---

# Tracking Shopify

Use this skill as the Shopify-specific branch contract after platform detection.

## When To Use

Use this skill when:

- `site-analysis.json` reports `platform.type: "shopify"`
- the user says the target is a Shopify storefront
- sync or verification must produce Shopify custom pixel artifacts
- the shared discovery / grouping flow has already established that the run is on the Shopify branch

## Shared Early Stages

Shopify still uses the same early workflow as generic sites:

- analysis
- page grouping
- page-group approval

Use `tracking-discover` and `tracking-group` for those phases.

## Shopify-Specific Rules

Schema phase:

- run `prepare-schema`
- read `shopify-schema-template.json`
- read `shopify-bootstrap-review.md`
- keep ecommerce funnel events primarily as `triggerType: "custom"`
- validate selector-based CTA events, but do not expect selector checking to validate Shopify ecommerce custom events

Sync phase:

- `sync` also generates `shopify-custom-pixel.js`
- `sync` also generates `shopify-install.md`

Verification phase:

- do not expect standard automated GTM preview to be the source of truth
- install the Shopify custom pixel first
- validate with GA4 Realtime and Shopify pixel debugging tools

## Required Output

Expect some or all of:

- `<artifact-dir>/shopify-schema-template.json`
- `<artifact-dir>/shopify-bootstrap-review.md`
- `<artifact-dir>/shopify-custom-pixel.js`
- `<artifact-dir>/shopify-install.md`
- updated `<artifact-dir>/workflow-state.json`

## Closeout Style

- default to a short Shopify-specific summary before listing files
- explain whether the current output is schema guidance, install guidance, or manual verification guidance
- keep artifact references after the summary, not before it

## Stop Boundary

Stop after the Shopify-specific artifact or manual verification plan the user asked for.

Do not force the generic preview path on a Shopify run.

## References

- [../../references/shopify-workflow.md](../../references/shopify-workflow.md)
- [../../references/event-schema-guide.md](../../references/event-schema-guide.md)
- [../../references/output-contract.md](../../references/output-contract.md)
