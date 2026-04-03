Install this skill family into Codex from the repository root with:

```bash
./setup --install-skills
```

For a development-friendly install that stays pointed at this repository's exported bundles, use:

```bash
./setup --install-skills --mode link
```

The installer targets `$CODEX_HOME/skills` when `CODEX_HOME` is set, otherwise `~/.codex/skills`.

For detailed install, update, and troubleshooting notes, see [`docs/README.codex.md`](../docs/README.codex.md).
