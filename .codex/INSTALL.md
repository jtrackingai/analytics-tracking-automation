After cloning this repository and entering its root, install the default umbrella skill into Codex with:

```bash
npm run install:skills
```

This copy-mode install is also the path that enables installed auto-update checks.

You do not need `npm ci` just to install the exported skill bundles.

If you want the full phase-oriented skill family installed together, use:

```bash
npm run install:skills -- --with-phases
```

For a development-friendly install that stays pointed at this repository's exported bundles, use:

```bash
npm run install:skills -- --mode link
```

Link mode is for local iteration only and does not auto-update from GitHub.

The installer targets `$CODEX_HOME/skills` when `CODEX_HOME` is set, otherwise `~/.codex/skills`.

For the shared install flow, see [`docs/README.install.md`](../docs/README.install.md).
For Codex-specific defaults and troubleshooting, see [`docs/README.codex.md`](../docs/README.codex.md).
