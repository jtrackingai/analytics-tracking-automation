# Skills

Install-facing skill bundles keep the matching runtime reference at [../references/skill-map.md](../references/skill-map.md).

This repository now has an umbrella skill plus a small phase-oriented skill family.

## Skill Map

| Skill | Role | Use When | Typical Stop Point |
| --- | --- | --- | --- |
| `event-tracking-skill` | umbrella workflow router | the request is end-to-end, ambiguous, or spans multiple phases | whichever checkpoint matches the user intent |
| `tracking-discover` | analysis bootstrap | the user wants crawl coverage, platform detection, dataLayer discovery, or a fresh artifact directory | `site-analysis.json` |
| `tracking-group` | page grouping review | the user wants page-group authoring, grouping adjustments, or page-group approval only | confirmed `site-analysis.json` |
| `tracking-live-gtm` | live GTM baseline audit | the user wants to inspect the real public GTM runtime before schema generation or compare multiple live GTM containers | `live-gtm-analysis.json` and `live-gtm-review.md` |
| `tracking-schema` | schema authoring and approval | the user wants event design, selector validation, schema review, or spec generation | confirmed `event-schema.json`, optional `event-spec.md`, and schema audit/restore artifacts |
| `tracking-sync` | GTM config generation and sync | the user wants GTM-ready config, workspace sync, or container selection | `gtm-config.json` or `gtm-context.json` |
| `tracking-verify` | preview QA and go-live handoff | the user wants preview verification, QA interpretation, or a publish-ready checkpoint | `preview-report.md`, `tracking-health.json`, or publish outcome |
| `tracking-shopify` | Shopify-specific overlay | the platform is Shopify or the user explicitly wants the Shopify branch behavior | Shopify bootstrap review, custom pixel, install guide, or manual verification plan |

## Design Rules

- The root skill remains the stable entry point for environments that only load one skill.
- The root skill owns first-turn conversational intake for chat entry points and should classify the request in plain-language intent terms before choosing a scenario template or phase skill.
- The root skill should stay an umbrella router and shared contract, not a long phase-by-phase runbook.
- The root skill should not ask the user to choose between internal command names such as `scenario` and `analyze`.
- Phase skills are intentionally thin. They should route to a bounded part of the workflow and stop when that phase is complete.
- Shared mechanics live in the CLI, artifact contract, and root references. Phase skills should not fork those contracts.
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

## Packaging Note

Inside this repository, the skill family lives under `skills/`.

The root skill is still the canonical umbrella contract. The phase skills are repo-local building blocks for more precise routing and future packaging as separate installed skills.

`skills/manifest.json` is the source-of-truth inventory for the shipped skill family. Export and check tooling derive the expected bundle set from that manifest.

Each skill now also has minimal UI metadata in `agents/openai.yaml`.

To export self-contained bundles for installation or distribution outside this repository, run:

```bash
npm run export:skills
```

That generates `dist/skill-bundles/<skill-name>/`, where each bundle carries its own `SKILL.md`, `agents/openai.yaml`, and copied `references/` tree. Exported architecture and skill-map material is written into `references/` so the installed bundle stays close to the native skill shape used by agent runtimes.

To install those bundles into a real agent skills directory, run:

```bash
npm run install:skills
```

That installs the umbrella skill into the installer's default target, unless `--target-dir` is provided. Add `--with-phases` when you want the full phase-oriented family installed together. See [README.install.md](README.install.md) for the shared install flow and [README.codex.md](README.codex.md) for Codex-specific defaults.
