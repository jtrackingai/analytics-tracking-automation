---
name: analytics-tracking-automation
description: Use when you need GA4 + GTM tracking delivery from site discovery through publish, or when the right phase entry point is still unclear.
compatibility: >
  Requires Node.js 18+, npm, and Playwright Chromium for browser-backed steps.
  analyze, validate-schema --check-selectors, preview, and sync each launch a
  real Chromium and/or call Google's GTM API, so they need outbound HTTP, local
  browser execution, and (for sync) a local loopback callback on 127.0.0.1 to
  receive Google's OAuth consent redirect. Run them in an environment that
  provides those capabilities. sync uses Google's interactive OAuth consent
  screen; the resulting user-owned refresh token is stored under the artifact
  directory and read locally by sync, preview, and publish when they call the
  official GTM API. A minimal anonymous startup signal is sent when the CLI
  command begins so operators can measure active usage. Richer anonymous
  diagnostics remain opt-in, are used only to improve the skill experience and
  workflow quality, and are not used for sensitive actions or sensitive
  behavior tracking.
---

# Analytics Tracking Automation

Use this skill as the end-to-end coordinator for GA4 + GTM tracking delivery.

Use it when:

- the user needs a full GA4 + GTM implementation flow, from analysis to go-live readiness
- the request spans multiple workflow phases (discovery, schema, sync, verification, publish)
- the correct entry point is still unclear and you need this skill to route to the right phase

Do not assume the user wants the full workflow.

<!-- analytics-tracking-automation auto-update bootstrap:start -->
## Auto-Update

This installed root skill can self-check for newer GitHub versions before you continue.

Before doing any task in this bundle:

1. Resolve the directory that contains this installed `SKILL.md`. Installer-managed copies usually live under the skills directory configured by your agent environment, such as `$CODEX_HOME/skills/analytics-tracking-automation` or an equivalent runtime-managed path.
2. Run `node "<bundle-dir>/runtime/skill-runtime/update-check.mjs" --json`.
3. If the result status is `update_available`, immediately run `node "<bundle-dir>/runtime/skill-runtime/self-update.mjs" --apply`.
4. If the update succeeds, read `<bundle-dir>/SKILL.md` again before continuing so you are using the refreshed instructions.
5. If the result status is `disabled`, treat this bundle as a local development link or repo checkout and continue without updating.

<!-- analytics-tracking-automation auto-update bootstrap:end -->

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

- Use the repo-local wrapper `./event-tracking` in this repository. If `dist/cli.js` is missing, run `npm run build` first.
- For public/ClawHub installs, you must run this first before any `event-tracking` command: `npx skills add jtrackingai/analytics-tracking-automation`.
- Keep one artifact directory per site at `<output-root>/<url-slug>`.
- If the user already provides an artifact directory or one of its files, resume from the earliest unmet prerequisite instead of restarting from `analyze`.
- Use `./event-tracking status <artifact-dir-or-file>` whenever the current checkpoint or next step is unclear.
- Use `./event-tracking runs <output-root>` when the artifact directory is unknown but the output root is known.
- Prefer high-level entry commands for user-facing flows: `run-new-setup`, `run-tracking-update`, `run-upkeep`, `run-health-audit`.
- Telemetry consent is a required user-choice checkpoint for richer diagnostics. If consent is unanswered when any workflow command surfaces the prompt, stop and follow [telemetry-consent.md](references/telemetry-consent.md) as the single-source interaction contract. Never decide `yes`/`no` on the user's behalf, and continue through the interactive prompt so the local config records their choice.
- Explain the purpose, what `yes` does, what `no` does, and the remaining privacy tradeoff before asking the user to reply `yes` or `no`. Do not ask a bare `yes`/`no` question with no context.
- Treat workflow mode metadata as an internal workflow-state layer, not a user-facing command surface.
- `analyze`, `validate-schema --check-selectors`, `preview`, and `sync` each need outbound HTTP and a real Chromium; `sync` additionally needs a local loopback callback on `127.0.0.1` for Google's OAuth consent redirect. Run them in an environment that permits those capabilities so Playwright and the OAuth callback can complete.
- Run prompt-driven GTM sync with an interactive TTY from the start unless exact `--account-id`, `--container-id`, and `--workspace-id` values are already confirmed.
- Never auto-select a GTM account, container, or workspace on the user's behalf.
- Do not continue past the phase boundary the user asked for.

## Conversation Intake

When the user enters through chat and has not yet provided a bounded phase, artifact directory, or exact command, start with an intent-first intake.

Classify the request into one of these entry intents:

- `resume_existing_run`: the user already has an artifact directory or one of its files; inspect the artifacts and use `status`
- `new_setup`: net-new tracking implementation from scratch; prefer `run-new-setup`, then follow its recommended next step
- `tracking_update`: revise or extend an existing implementation; prefer `run-tracking-update`
- `upkeep`: routine maintenance, review, or incremental QA on an existing setup; prefer `run-upkeep`
- `tracking_health_audit`: audit-only assessment of current live tracking; prefer `run-health-audit`
- `analysis_only`: crawl/bootstrap/discovery only without committing to the full workflow yet; route to `tracking-discover` and stop after `analyze`

Rules:

- Do not ask the user to choose between internal workflow metadata flags and `analyze`.
- If intent is ambiguous, ask one short plain-language intake question using user-facing terms such as "new setup", "update existing tracking", "upkeep", "health audit", "analyze only", or "resume an existing run".
- If the user gives a fresh URL and asks to set up tracking, default to `new_setup`.
- If the user gives a fresh URL and only asks to inspect the site, analyze structure, or review current tracking signals, default to `analysis_only`.
- If the user gives an artifact directory or workflow file, default to `resume_existing_run` instead of restarting from `analyze`.

## Routing Rules

Route by user intent and current artifacts:

- fresh URL, crawl request, or no artifacts yet: start with `tracking-discover`
- `site-analysis.json` with missing or unconfirmed `pageGroups`: route to `tracking-group`
- confirmed `site-analysis.json` with detected live GTM container IDs but no live baseline review yet: route to `tracking-live-gtm`
- confirmed `site-analysis.json` or an in-progress `event-schema.json`: route to `tracking-schema`
- approved `event-schema.json` without `gtm-config.json`: route to `tracking-sync` for `generate-gtm`
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
- Treat telemetry consent the same way as other explicit approval gates: if the user has not chosen `yes` or `no`, stop and ask instead of making the decision for them.
- A broad request such as "full workflow", "全流程", "end-to-end", or "continue all the way" is scope authorization only. It does not count as checkpoint approval.
- Never record checkpoint approval on the user's behalf with `confirm-page-groups --yes` or `confirm-schema --yes` unless the user explicitly confirms that checkpoint in the current turn.
- When live GTM containers are detected on the site, do not bypass the live baseline review before schema generation.
- Do not bypass schema approval before `generate-gtm` unless the user explicitly wants `--force`.
- Treat preview QA and publish as separate decisions.
- Treat `tracking-health.json` as the publish gate; do not jump to publish when health is missing, manual-only, or blocked unless the user explicitly wants `--force`.
- Treat Shopify manual verification as the expected path for Shopify runs, not as a fallback error case.
- Treat `tracking_health_audit` as an audit-only workflow mode. Do not run GTM deployment actions (`generate-gtm`, `sync`, `publish`) unless the user explicitly asks to override.

## Resume And Closeout

When resuming:

- prefer `workflow-state.json` when present
- still inspect the real artifact set if warnings indicate stale gates
- use `status` when the next step is unclear

When a phase or the full workflow ends, keep the closeout answer-first:

- lead with a compact, decision-ready summary in plain language
- do not dump raw JSON, raw URL lists, or artifact inventory before the summary
- list files, checkpoint, and next command only after the human-readable summary

## References

- [skill-map.md](references/skill-map.md) for the umbrella / phase skill map
- [architecture.md](references/architecture.md) for lifecycle, checkpoints, and resume semantics
- [output-contract.md](references/output-contract.md) for artifact files and gate semantics
- [shopify-workflow.md](references/shopify-workflow.md) for Shopify-specific branch expectations
- [telemetry-consent.md](references/telemetry-consent.md) for the telemetry consent gate wording and behavior contract
