# Skill Map Reference

This reference keeps the install-facing skill-family map in the same shape that exported skill bundles use.

If you are working in the source repository, the repo-facing companion lives at [../docs/skills.md](../docs/skills.md).

## Skill Map

| Skill | Role | Use When | Typical Stop Point |
| --- | --- | --- | --- |
| `event-tracking-skill` | umbrella workflow router | the request is end-to-end, ambiguous, or spans multiple phases | whichever checkpoint matches the user intent |
| `tracking-discover` | analysis bootstrap | the user wants crawl coverage, platform detection, dataLayer discovery, or a fresh artifact directory | `site-analysis.json` |
| `tracking-group` | page grouping review | the user wants page-group authoring, grouping adjustments, or page-group approval only | confirmed `site-analysis.json` |
| `tracking-live-gtm` | live GTM baseline audit | the user wants to inspect the real live GTM runtime before schema generation or compare multiple live GTM containers | `live-gtm-analysis.json` and `live-gtm-review.md` |
| `tracking-schema` | schema authoring and approval | the user wants event design, selector validation, schema review, or spec generation | confirmed `event-schema.json`, optional `event-spec.md`, and schema audit/restore artifacts |
| `tracking-sync` | GTM config generation and sync | the user wants GTM-ready config, workspace sync, or container selection | `gtm-config.json` or `gtm-context.json` |
| `tracking-verify` | preview QA and go-live handoff | the user wants preview verification, QA interpretation, or a publish-ready checkpoint | `preview-report.md`, `tracking-health.json`, or publish outcome |
| `tracking-shopify` | Shopify-specific overlay | the platform is Shopify or the user explicitly wants the Shopify branch behavior | Shopify bootstrap review, custom pixel, install guide, or manual verification plan |

## Design Rules

- The root skill remains the stable entry point when only one installed skill is available.
- The root skill owns first-turn conversational intake for chat entry points and should classify requests by user intent before selecting scenario templates or phase skills.
- The root skill should stay an umbrella router and shared contract, not a long phase-by-phase runbook.
- The root skill should not ask the user to choose between internal command names such as `scenario` and `analyze`.
- Phase skills should route to one bounded part of the workflow and stop when that phase is complete.
- Shared mechanics live in the CLI, artifact contract, and root references.
- Shopify keeps discovery and grouping shared, then takes ownership of the Shopify-specific schema, sync, install, and verification branch behavior.

## Boundaries

`tracking-discover` owns:

- `analyze`
- bootstrap artifact directory
- crawl summary and platform detection

`tracking-group` owns:

- editing `pageGroups`
- page-group review
- `confirm-page-groups`

`tracking-live-gtm` owns:

- `analyze-live-gtm`
- public live GTM runtime comparison
- primary comparison container selection

`tracking-schema` owns:

- `prepare-schema`
- schema authoring and validation
- `generate-spec`
- `confirm-schema`

`tracking-sync` owns:

- `generate-gtm`
- custom-dimension gate
- `sync`

`tracking-verify` owns:

- `preview`
- preview report interpretation
- optional publish transition when the user explicitly wants to go live

`tracking-shopify` modifies:

- schema bootstrap expectations
- sync outputs
- verification path
- post-branch handoff rules once the platform is confirmed as Shopify

## Packaging Notes

Each exported bundle carries:

- its own `SKILL.md`
- its own `agents/openai.yaml`
- a copied `references/` tree

When you work in the source repository, `skills/manifest.json` is the shipped-skill inventory and `npm run export:skills` regenerates `dist/skill-bundles/`.
