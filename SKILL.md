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

<!-- event-tracking auto-update bootstrap:start -->
## Auto-Update

This installed root skill can self-check for newer GitHub versions before you continue.

Before doing any task in this bundle:

1. Resolve the directory that contains this installed `SKILL.md`. For Codex installs it is usually `$CODEX_HOME/skills/event-tracking-skill` or `~/.codex/skills/event-tracking-skill`.
2. Run `node "<bundle-dir>/runtime/skill-runtime/update-check.mjs" --json`.
3. If the result status is `update_available`, immediately run `node "<bundle-dir>/runtime/skill-runtime/self-update.mjs" --apply`.
4. If the update succeeds, read `<bundle-dir>/SKILL.md` again before continuing so you are using the refreshed instructions.
5. If the result status is `disabled`, treat this bundle as a local development link or repo checkout and continue without updating.

<!-- event-tracking auto-update bootstrap:end -->

## Skill Family

The skill family is split into one umbrella skill plus seven phase skills:

- `tracking-discover` for crawl coverage, platform detection, and fresh artifact bootstrap
- `tracking-group` for page-group authoring and approval
- `tracking-live-gtm` for auditing the real live GTM runtime before schema generation
- `tracking-schema` for schema preparation, review, validation, and approval
- `tracking-sync` for GTM config generation and sync
- `tracking-verify` for preview QA and optional publish handoff
- `tracking-shopify` for Shopify-specific schema, sync, install, and verification rules

If the request is already bounded to one phase and that phase skill is available, route there instead of inlining the full runbook here.

Once `site-analysis.json` indicates Shopify, keep discovery and grouping shared, then let `tracking-shopify` own the Shopify-specific branch.

## Shared Contract

1. Use the repo-local wrapper `./event-tracking` for CLI commands in this repository. If the wrapper reports that `dist/cli.js` is missing, run `npm run build` first.
2. Keep one artifact directory per site (`<output-root>/<url-slug>`). Each iteration inside that artifact should use a distinct run ID with snapshots under `versions/<run-id>/`.
3. If the user already provides an artifact directory or one of its files, resume from the earliest unmet prerequisite instead of restarting from `analyze`.
4. Use `./event-tracking status <artifact-dir-or-file>` whenever the current checkpoint or next step is unclear.
5. Use `./event-tracking runs <output-root>` when the user wants to find recent site runs and does not remember the artifact directory.
6. Google OAuth client metadata is embedded in the CLI and may be overridden with `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.
7. Any Playwright-backed or OAuth-triggering step must run outside a sandboxed environment by default. In practice, treat `analyze`, `validate-schema --check-selectors`, `preview`, and `sync` as non-sandbox commands, and do not first attempt them in the sandbox before retrying after interception.
8. Never auto-select a GTM account, GTM container, or GTM workspace on the user's behalf. Always show candidates and require explicit confirmation unless the user already provided the exact ID for that step.
9. Prefer scenario-first entry commands for user-facing flows: `run-new-setup`, `run-tracking-update`, `run-upkeep`, `run-health-audit`. Use `start-scenario` when the user wants a labeled scenario run without immediate template execution.
10. Use `./event-tracking scenario <artifact-dir> --set <scenario> [--sub-scenario ...] [--new-run]` for metadata-only adjustments when you should not alter execution flow.
11. Use `./event-tracking scenario-check <artifact-dir>` when the question is "is this scenario ready" rather than "what is the next workflow checkpoint".
12. Use `./event-tracking scenario-transition <artifact-dir> --to <scenario> [--reason ...]` when the user wants an auditable handoff between scenarios.
13. Do not continue past the phase boundary the user asked for. Stop after the requested phase unless the user explicitly asks to continue.

## Routing Rules

Route by user intent and current artifacts:

- fresh URL, crawl request, or no artifacts yet: start with `tracking-discover`
- `site-analysis.json` with missing or unconfirmed `pageGroups`: route to `tracking-group`
- confirmed `site-analysis.json` with detected live GTM container IDs but no live baseline review yet: route to `tracking-live-gtm`
- confirmed `site-analysis.json` or an in-progress `event-schema.json`: route to `tracking-schema`
- `gtm-config.json`: route to `tracking-sync`
- `gtm-context.json`: route to `tracking-verify`, with publish treated as a separate explicit action
- Shopify platform confirmation: keep shared early stages, then hand off to `tracking-shopify`

If only the root skill is available, follow the same routing logic directly and stop at the matching phase boundary.

## Stop Rules

- Do not bypass page-group approval before `prepare-schema`.
- For key decision checkpoints, always require explicit user confirmation before continuing:
  - `pageGroups` (before `confirm-page-groups` and before `prepare-schema`)
  - `event-schema.json` (before `confirm-schema` and before `generate-gtm`)
  - GTM target selection (account/container/workspace during `sync`)
  - publish decision (before `publish`)
- If confirmation is missing or ambiguous, stop and ask; do not auto-proceed.
- When live GTM containers are detected on the site, do not bypass the live baseline review before schema generation.
- Do not bypass schema approval before `generate-gtm` unless the user explicitly wants `--force`.
- Treat preview QA and publish as separate decisions.
- Treat `tracking-health.json` as the publish gate; do not jump to publish when health is missing, manual-only, or blocked unless the user explicitly wants `--force`.
- Treat Shopify manual verification as the expected path for Shopify runs, not as a fallback error case.
- Treat `tracking_health_audit` as an audit-only scenario. Do not run GTM deployment actions (`generate-gtm`, `sync`, `publish`) unless the user explicitly asks to override.

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
- remaining manual actions, especially for custom dimensions, Shopify install, tracking health, preview QA, or publish approval

## References

- [skill-map.md](references/skill-map.md) for the umbrella / phase skill map
- [architecture.md](references/architecture.md) for lifecycle, checkpoints, and resume semantics
- [output-contract.md](references/output-contract.md) for artifact files and gate semantics
- [shopify-workflow.md](references/shopify-workflow.md) for Shopify-specific branch expectations
