---
name: event-tracking-skill
description: Use when the request is end-to-end, spans multiple workflow phases, or the correct tracking-workflow entry point is still unclear.
---

# Event Tracking Skill

Use this skill as the umbrella router for the GA4 + GTM tracking system.

Use it when:

- the request is end-to-end
- the request spans multiple phases
- the correct workflow entry point is still unclear

Do not assume the user wants the full workflow.

## Skill Family

The skill family is split into one umbrella skill plus six phase skills:

- `tracking-discover` for crawl coverage, platform detection, and fresh artifact bootstrap
- `tracking-group` for page-group authoring and approval
- `tracking-schema` for schema preparation, review, validation, and approval
- `tracking-sync` for GTM config generation and sync
- `tracking-verify` for preview QA and optional publish handoff
- `tracking-shopify` for Shopify-specific schema, sync, install, and verification rules

If the request is already bounded to one phase and that phase skill is available, route there instead of inlining the full runbook here.

Once `site-analysis.json` indicates Shopify, keep discovery and grouping shared, then let `tracking-shopify` own the Shopify-specific branch.

## Shared Contract

1. Use the repo-local wrapper `./event-tracking` for CLI commands in this repository. If the wrapper reports that `dist/cli.js` is missing, run `npm run build` first.
2. Keep one artifact directory per site run. The CLI derives it as `<output-root>/<url-slug>` during `analyze`.
3. If the user already provides an artifact directory or one of its files, resume from the earliest unmet prerequisite instead of restarting from `analyze`.
4. Use `./event-tracking status <artifact-dir-or-file>` whenever the current checkpoint or next step is unclear.
5. Google OAuth client metadata is embedded in the CLI and may be overridden with `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.
6. Any step that may trigger Google OAuth must run outside a sandboxed environment. In practice, treat `sync` as a non-sandbox command by default because the OAuth flow may need to bind a local callback on `127.0.0.1` and reach GTM APIs directly.
7. Never auto-select a GTM account, GTM container, or GTM workspace on the user's behalf. Always show candidates and require explicit confirmation unless the user already provided the exact ID for that step.
8. Do not continue past the phase boundary the user asked for. Stop after the requested phase unless the user explicitly asks to continue.

## Routing Rules

Route by user intent and current artifacts:

- fresh URL, crawl request, or no artifacts yet: start with `tracking-discover`
- `site-analysis.json` with missing or unconfirmed `pageGroups`: route to `tracking-group`
- confirmed `site-analysis.json` or an in-progress `event-schema.json`: route to `tracking-schema`
- `gtm-config.json`: route to `tracking-sync`
- `gtm-context.json`: route to `tracking-verify`, with publish treated as a separate explicit action
- Shopify platform confirmation: keep shared early stages, then hand off to `tracking-shopify`

If only the root skill is available, follow the same routing logic directly and stop at the matching phase boundary.

## Stop Rules

- Do not bypass page-group approval before `prepare-schema`.
- Do not bypass schema approval before `generate-gtm` unless the user explicitly wants `--force`.
- Treat preview QA and publish as separate decisions.
- Treat Shopify manual verification as the expected path for Shopify runs, not as a fallback error case.

## Resume And Closeout

When resuming:

- prefer `workflow-state.json` when present
- still inspect the real artifact set if warnings indicate stale gates
- use `status` when the next step is unclear

When a phase or the full workflow ends, summarize:

- artifact directory
- current checkpoint from `workflow-state.json`
- key output files from the completed phase
- next recommended command, if any
- remaining manual actions, especially for custom dimensions, Shopify install, preview QA, or publish approval

## References

- [skill-map.md](references/skill-map.md) for the umbrella / phase skill map
- [architecture.md](references/architecture.md) for lifecycle, checkpoints, and resume semantics
- [output-contract.md](references/output-contract.md) for artifact files and gate semantics
- [shopify-workflow.md](references/shopify-workflow.md) for Shopify-specific branch expectations
