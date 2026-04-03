# Codex Install Guide

Use this guide when you want to install the exported skill family into a local Codex skills directory.

## Fast Path

From the repository root:

```bash
./setup --install-skills
```

That installs dependencies, builds the CLI, runs the basic environment checks, exports the skill bundles, and copies them into the default skills directory.

Default target resolution:

- `$CODEX_HOME/skills` when `CODEX_HOME` is set
- otherwise `~/.codex/skills`

## Copy vs Link Mode

Copy mode is the default:

```bash
npm run install:skills
```

Use this when you want a self-contained installed copy that does not depend on the repo after installation.

Link mode keeps the installed skills pointed at `dist/skill-bundles/` inside this repository:

```bash
npm run install:skills -- --mode link
```

Use this during local iteration. After changing skill text or metadata, rerun:

```bash
npm run export:skills
```

The linked install keeps the same target path, so exported bundle refreshes show up without another copy step.

## Common Variants

Install into a custom skills directory:

```bash
npm run install:skills -- --target-dir /tmp/codex-skills
```

Install only selected skills:

```bash
npm run install:skills -- --skill event-tracking-skill --skill tracking-schema
```

Run the full setup and install linked bundles:

```bash
./setup --install-skills --mode link
```

## Updating

If this repo is already cloned locally:

```bash
git pull
npm run export:skills
```

If you use copy mode, rerun the installer after exporting:

```bash
npm run install:skills
```

If you use link mode, exporting is usually enough because the installed skills already point at `dist/skill-bundles/`.

## Verify Discovery

Check that the installed directory contains the expected skill folders, for example:

- `event-tracking-skill`
- `tracking-discover`
- `tracking-group`
- `tracking-schema`
- `tracking-sync`
- `tracking-verify`
- `tracking-shopify`

You can also inspect the generated install plan without changing anything:

```bash
npm run install:skills -- --dry-run
```

## Troubleshooting

- If the skills are missing, run `npm run export:skills` and then reinstall.
- If Codex does not pick up newly installed skills immediately, restart the Codex session after installation.
- If linked installs appear stale, confirm that `dist/skill-bundles/` was regenerated after the last skill-text change.
- If installation fails because `dist/skill-bundles/manifest.json` is missing, run `npm run export:skills` first.
