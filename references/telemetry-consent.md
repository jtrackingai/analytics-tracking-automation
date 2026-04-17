# Telemetry Consent Interaction

This reference defines the single-source interaction contract for the telemetry consent gate.

Use it whenever the workflow reaches the diagnostics consent prompt and the user has not already made a recorded choice.

## Purpose

Telemetry consent is a user-choice checkpoint, not an implementation detail.

The agent must explain the decision in user-facing language before asking for the choice:

- what telemetry is for: improving workflow quality and product reliability
- what `yes` does: stores local consent and enables high-level anonymous diagnostics for future runs
- what `no` does: stores local decline and continues the workflow normally without diagnostics
- what is not sent: full URLs, page paths, query strings, file paths, GTM or GA IDs, selectors, OAuth data, raw errors, and page content
- remaining privacy tradeoff: the site hostname and broad workflow metadata may still reveal which domain was worked on and the rough type of work performed

## Required Asking Style

When the telemetry gate is reached, ask in plain language for the user's decision.

Recommended shape:

1. one short sentence on purpose
2. one short sentence on what `yes` does
3. one short sentence on what `no` does
4. one direct choice prompt asking the user to reply `yes` or `no`

Recommended wording pattern:

> Before continuing, I need your choice on whether to enable anonymous diagnostics for this workflow.
> `yes` stores consent in local config and enables high-level anonymous usage diagnostics for future runs so the workflow can be improved and kept reliable.
> `no` also stores your choice in local config, and the workflow continues normally without sending those diagnostics.
> These diagnostics do not include full URLs, page content, selectors, GTM or GA IDs, OAuth data, or raw errors, but they do include the site hostname and broad workflow metadata. Reply `yes` or `no`.

The exact wording can vary, but all of the points above must remain present.

## Required Behaviors

- stop when the gate appears and wait for the user's explicit answer
- keep the explanation concise and user-facing
- treat `yes` and `no` as equally valid workflow outcomes
- once the user answers, continue through the interactive CLI prompt so the local telemetry config is written by the tool itself

## Prohibited Behaviors

- do not paste the raw CLI prompt to the user without explanation
- do not ask only "`yes` or `no`?" with no context
- do not frame `yes` as the preferred or expected answer
- do not answer the prompt on the user's behalf
- do not suggest config-file hacks, env overrides, or pre-seeding consent outside the intended prompt
- do not continue to the next workflow command before consent is explicitly chosen
