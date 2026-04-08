# Agent Install Guide

Use this guide when you want to install the exported skill bundles into a local agent skills directory.

This is the shared installation path across agent runtimes. Platform-specific notes such as Codex defaults should live in thin supplement pages on top of this guide.

## Recommended Path

This installer path assumes you already cloned this repository locally and are running commands from the repository root.

If you do not want a local checkout, use `npx skills add jtrackingai/event-tracking-skill` on the root skill instead.

From a local checkout:

```bash
git clone https://github.com/jtrackingai/event-tracking-skill.git
cd event-tracking-skill
npm run install:skills
```

That keeps the default install surface minimal by installing only the umbrella skill into the default install target.
You do not need `npm ci` just to install the exported skill bundles.

If you want the full phase-oriented family installed together:

```bash
npm run install:skills -- --with-phases
```

Use that when your agent runtime benefits from loading the phase skills separately.

If you also want the repo-local CLI and development checks prepared in one pass:

```bash
./setup --install-skills --with-phases
```

Use `./setup` only when you also want dependencies, the repo-local CLI, and local development checks.

## Default Install Target

Today the installer resolves the default target like this:

- `$CODEX_HOME/skills` when `CODEX_HOME` is set
- otherwise `~/.codex/skills`

If your agent runtime uses a different skills directory, install directly into it:

```bash
npm run install:skills -- --target-dir /path/to/agent/skills
```

To install the full family into a custom directory:

```bash
npm run install:skills -- --target-dir /path/to/agent/skills --with-phases
```

## Copy vs Link Mode

Copy mode is the default:

```bash
npm run install:skills
```

Use this for normal users.

Copy-mode installs are the recommended auto-update path. The installed skill bundle can check the GitHub `VERSION` file during use and reinstall the same selected bundle set when a newer version is available.

Portable installs such as `npx skills add ...` on the root skill or manual copies of exported bundles can also self-check for updates as long as the installed directory includes `runtime/skill-runtime/`. On the first successful self-update, the updater rewrites that portable install into the repo's normal copy-mode layout.

Link mode keeps the installed skills pointed at `dist/skill-bundles/` inside this repository:

```bash
npm run install:skills -- --mode link
```

Use this during local iteration only. After changing skill text or metadata, rerun:

```bash
npm run export:skills
```

The linked install keeps the same target path, so exported bundle refreshes show up without another copy step.

Link mode intentionally does not auto-update from GitHub and is not the recommended end-user install path.

To link the full phase-oriented family during local iteration:

```bash
npm run install:skills -- --mode link --with-phases
```

## Common Variants

Install into a custom skills directory:

```bash
npm run install:skills -- --target-dir /tmp/agent-skills
```

Install only selected skills:

```bash
npm run install:skills -- --skill event-tracking-skill --skill tracking-schema
```

Install the full skill family explicitly:

```bash
npm run install:skills -- --with-phases
```

Run the full setup and install linked bundles:

```bash
./setup --install-skills --mode link --with-phases
```

Inspect the generated install plan without changing anything:

```bash
npm run install:skills -- --dry-run
```

## Updating

If this repo is already cloned locally:

```bash
git pull
npm run export:skills
```

If your installer-managed copy predates the installed auto-update bootstrap, reinstall once first:

```bash
npm run install:skills
```

If you use copy mode, rerun the installer after exporting:

```bash
npm run install:skills
```

If you use link mode, exporting is usually enough because the installed skills already point at `dist/skill-bundles/`.

After that one-time reinstall, normal copy-mode usage can self-check for updates during skill invocation.

## Verification

Default installs should contain:

- `event-tracking-skill`

If you used `--with-phases`, the installed directory should also contain:

- `tracking-discover`
- `tracking-group`
- `tracking-live-gtm`
- `tracking-schema`
- `tracking-sync`
- `tracking-verify`
- `tracking-shopify`

## Platform Notes

- [README.codex.md](README.codex.md) for Codex-specific defaults, paths, and troubleshooting
