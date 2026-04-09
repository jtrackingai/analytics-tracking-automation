# Contributing to Event Tracking Skill

Thanks for your interest in contributing.

## Ways to contribute

- Report bugs by opening a Bug Report issue
- Request improvements by opening a Feature Request issue
- Report site-specific failures by opening a Site Compatibility Report issue
- Ask usage questions in Discussions > Q&A
- Share working examples in Discussions > Show and Tell
- Submit a pull request

## Development setup

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

See [DEVELOPING.md](DEVELOPING.md) for maintainer commands, validation, and edit rules.

## Pull request process

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run check`
5. If you changed workflow-state or gate logic, also run `npm test`
6. Open a pull request against `main` with a clear summary of the user-facing impact

## Repository-specific rules

- Use `./event-tracking` in repo-local docs and examples
- Do not edit generated files under `dist/skill-bundles/` directly
- Keep `README.md`, `SKILL.md`, and workflow docs aligned when changing public behavior

## Code of conduct

Please be respectful and constructive. See `CODE_OF_CONDUCT.md`.
