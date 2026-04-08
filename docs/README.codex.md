# Codex Install Guide

Use this guide when you want Codex-specific defaults, paths, and troubleshooting for the exported skill family.

The generic installer flow now lives in [README.install.md](README.install.md). This guide only covers the Codex-specific layer on top of that shared install path.

## Fast Path

This installer path assumes you already cloned this repository locally and are running commands from the repository root.

If you do not want a local checkout, use `npx skills add jtrackingai/event-tracking-skill` instead.

From a local checkout:

```bash
git clone https://github.com/jtrackingai/event-tracking-skill.git
cd event-tracking-skill
npm run install:skills
```

That installs only `event-tracking-skill` into the default Codex skills directory so the first install stays minimal.
You do not need `npm ci` just to install the exported skill bundles.

If you want the full phase-oriented family installed together:

```bash
npm run install:skills -- --with-phases
```

Default target resolution:

- `$CODEX_HOME/skills` when `CODEX_HOME` is set
- otherwise `~/.codex/skills`

## Copy vs Link Mode

Copy mode is the default:

```bash
npm run install:skills
```

Use this when you want a self-contained installed copy that does not depend on the repo after installation.

Copy-mode installs are the recommended auto-update path. The installed skill bundle can check the GitHub `VERSION` file during use and reinstall the same selected bundle set when a newer version is available.

Portable Codex installs such as `npx skills add ...` on the root skill can also self-check for updates. After the first successful self-update, that portable install is rewritten into the normal copy-mode layout.

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

To link the full family during local iteration:

```bash
npm run install:skills -- --mode link --with-phases
```

## Common Variants

Install into a custom skills directory:

```bash
npm run install:skills -- --target-dir /tmp/codex-skills
```

Install only selected skills:

```bash
npm run install:skills -- --skill event-tracking-skill --skill tracking-schema
```

Install the full skill family:

```bash
npm run install:skills -- --with-phases
```

Run the full setup and install linked bundles:

```bash
./setup --install-skills --mode link --with-phases
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

## Verify Discovery

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

You can also inspect the generated install plan without changing anything:

```bash
npm run install:skills -- --dry-run
```

## Troubleshooting

- In Codex environments, run Playwright-backed commands such as `./event-tracking analyze ...` and `./event-tracking preview ...` outside the sandbox from the start. Do not burn a first sandbox attempt before rerunning outside it.
- Treat `./event-tracking sync ...` the same way when OAuth may need a local callback on `127.0.0.1`.
- Link-mode installs do not auto-update.
- Older installer-managed copies need one reinstall before they gain the installed auto-update bootstrap.
- Portable root-skill installs can self-check for updates, but direct phase-skill copies that omit `runtime/skill-runtime/` cannot.
- If the skills are missing, run `npm run export:skills` and then reinstall.
- If Codex does not pick up newly installed skills immediately, restart the Codex session after installation.
- If linked installs appear stale, confirm that `dist/skill-bundles/` was regenerated after the last skill-text change.
- If installation fails because `dist/skill-bundles/manifest.json` is missing, run `npm run export:skills` first.
