---
name: tracking-group
description: Use when the work starts from `site-analysis.json` and the user wants page-group authoring, grouping adjustments, or page-group approval.
---

# Tracking Group

Use this skill when the work starts from `site-analysis.json` and the goal is to produce approved `pageGroups`.

## Inputs

- `<artifact-dir>/site-analysis.json`

## Workflow

1. Read the current `pageGroups` and page inventory.
2. Group pages by business purpose, not just URL shape.
3. Present a concise table with group name, content type, URL pattern, and pages.
4. Ask the user to confirm or adjust the grouping.
5. Record approval with:

```bash
./event-tracking confirm-page-groups <artifact-dir>/site-analysis.json
```

## Required Output

Produce and share:

- updated `<artifact-dir>/site-analysis.json`
- updated `<artifact-dir>/workflow-state.json`

## Stop Boundary

Stop after page-group approval unless the user explicitly asks to continue into schema work.

Useful follow-up:

```bash
./event-tracking prepare-schema <artifact-dir>/site-analysis.json
```

## References

- [../../references/page-grouping-guide.md](../../references/page-grouping-guide.md)
- [../../references/output-contract.md](../../references/output-contract.md)
