# Developing

This repository has two command surfaces:

| Audience | Surface | Purpose |
| --- | --- | --- |
| Users and agents | `./event-tracking` | public workflow commands, status inspection, and workflow gates |
| Maintainers | `./setup`, `npm run doctor`, `npm run check`, `npm run build`, `npm run dev` | setup, verification, and development |

## Setup

Recommended:

```bash
./setup
```

Manual:

```bash
npm ci
npm run build
npm run doctor
```

## Maintainer Commands

| Command | Use |
| --- | --- |
| `./setup` | install dependencies, build, and run environment checks |
| `./setup --install-skills` | install dependencies, build, run environment checks, then install skill bundles into the default Codex skills directory |
| `./setup --install-skills --mode link` | same as above, but link exported skill bundles into the skills directory for local iteration |
| `npm run build` | compile TypeScript into `dist/` |
| `npm test` | rebuild, then run the standalone automated workflow-state and gate tests |
| `npm run doctor` | verify Node, built CLI, repo-local wrapper, and Playwright Chromium |
| `npm run export:skills` | generate self-contained skill bundles under `dist/skill-bundles/` |
| `npm run install:skills -- [--target-dir <dir>] [--skill <name>] [--mode <copy|link>]` | copy or link exported bundles into a Codex skills directory |
| `npm run check` | rebuild, run automated tests and doctor, smoke-test `./event-tracking --help`, export skill bundles, and validate documented command surface |
| `npm run dev` | run the CLI through `ts-node` while iterating locally |

## Change Rules

Keep these rules stable unless you intentionally want to change the public surface:

- docs and skill instructions should use `./event-tracking` inside this repository
- `dist/cli.js` is an implementation detail, not a user-facing command example
- `SKILL.md` should stay focused on routing and shared workflow contract, not phase-by-phase runbook detail or mandatory product marketing
- `skills/*/SKILL.md` should stay phase-scoped and should not duplicate the full umbrella workflow
- skill frontmatter `description` fields should stay trigger-oriented and start with `Use when ...`
- `skills/manifest.json` is the source of truth for the exported / installable skill family; update it when adding, renaming, or removing shipped skills
- `agents/openai.yaml` and `skills/*/agents/openai.yaml` should stay minimal and UI-focused
- `dist/skill-bundles/` is generated output; change source docs first, then regenerate with `npm run export:skills`
- installed copies under `$CODEX_HOME/skills` or `~/.codex/skills` are deployment output; regenerate and reinstall instead of editing them in place
- linked installs under `$CODEX_HOME/skills` or `~/.codex/skills` point back to `dist/skill-bundles/`; regenerate exports after changing skill text or metadata
- `references/architecture.md` and `references/skill-map.md` are the install-facing runtime references that should ship unchanged into exported bundles
- `README.md`, `ARCHITECTURE.md`, `references/architecture.md`, `SKILL.md`, and `references/output-contract.md` should agree on workflow checkpoints, prerequisite artifacts, produced artifacts, and resume semantics
- conditional gates such as `analyze-live-gtm` before `prepare-schema` must be documented in workflow tables and quick-start snippets, not only in phase skills
- skill counts and phase names in docs should stay aligned with `skills/manifest.json`
- artifact filenames in [references/output-contract.md](references/output-contract.md) are part of the public workflow contract
- `workflow-state.json` is part of the public workflow contract once generated
- when adding a new workflow step, document its prerequisite artifact and produced artifact explicitly

## Minimum Validation

Run this after changing code or documentation that affects the command surface:

```bash
npm run check
```

Run this when changing workflow-state logic, gate logic, or other non-networked CLI behavior:

```bash
npm test
```

Run this when changing skill wording, references, or packaging metadata and you want to inspect the exported result directly:

```bash
npm run export:skills
```

Run this when you want to verify the installed shape in a real skills directory:

```bash
npm run install:skills -- --target-dir /tmp/codex-skills
```

Run this when you want an in-place Codex install that follows regenerated bundles without another copy step:

```bash
npm run install:skills -- --mode link
```

Run this when working on crawl, preview, or environment issues:

```bash
npm run doctor
```

`tests/workflow-state.test.mjs` is the current standalone automated test suite. `npm run check` remains the minimum release gate for this repository because it also verifies docs, packaging, and install shape.

## Editing Guidance

If you change CLI behavior:

- update [README.md](README.md) when the public command surface changes
- update [SKILL.md](SKILL.md) when the agent workflow contract changes
- update affected `skills/*/SKILL.md` files when a phase boundary or command changes
- update `skills/manifest.json` when the shipped skill inventory changes
- update affected `agents/openai.yaml` files when skill naming, positioning, or default prompts change
- inspect `dist/skill-bundles/` after regeneration when the change should affect exported skill packaging
- rerun the installer when the change should affect installed skill contents
- if you use link mode locally, rerun `npm run export:skills` after changing skill text or metadata so the linked target refreshes in place
- update workflow snippets and entry-point tables in [README.md](README.md) when phase order, conditional gates, or branch behavior changes
- update [ARCHITECTURE.md](ARCHITECTURE.md) when the artifact lifecycle or branch behavior changes
- update [references/architecture.md](references/architecture.md) when install-facing artifact lifecycle or resume semantics change
- update [docs/skills.md](docs/skills.md) and [references/skill-map.md](references/skill-map.md) when skill boundaries or phase inventory change
- keep command examples and next-step prompts aligned with the public interface
- keep the root `SKILL.md` at umbrella-skill scope; push detailed instructions down into phase skills or references when it starts growing again

If you change artifact files:

- update [references/output-contract.md](references/output-contract.md)
- check whether resume semantics changed
- check whether `workflow-state.json` needs a new field or checkpoint
- verify Shopify-specific outputs separately from generic outputs

## Release Checklist

- run `npm run check`
- run `npm test` when changing workflow-state or gate behavior locally before the full check
- confirm new examples use `./event-tracking`
- confirm `README.md`, `ARCHITECTURE.md`, `references/architecture.md`, `SKILL.md`, and `references/output-contract.md` agree on checkpoints, gates, and artifact names
- confirm `docs/skills.md`, `references/skill-map.md`, and `skills/*/SKILL.md` still match the current phase boundaries and phase inventory
- confirm `skills/manifest.json` still matches the actual shipped skill family
- confirm `agents/openai.yaml` files still match skill names and intended invocation mode
- confirm exported bundles under `dist/skill-bundles/` use `event-tracking` rather than `./event-tracking`
- confirm installed bundles land in the intended skills target directory
- confirm any new workflow gate is reflected in both CLI enforcement and `workflow-state.json`
- confirm any branch-specific changes still describe both `generic` and `shopify` behavior accurately
