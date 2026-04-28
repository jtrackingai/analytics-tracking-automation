# GTM Troubleshooting

## Selection Safety Rule

- Never auto-pick a GTM account, container, or workspace for the user
- At each selection step, show the available options and wait for explicit user confirmation
- Do not infer the right choice only from a matching domain, environment name, or the fact that one option "looks production"
- If a wrong selection was made or the previous sync was interrupted, rerun `sync` and confirm each step again before proceeding

## Execution Environment

- `analyze`, `validate-schema --check-selectors`, and `preview` each launch a real Chromium via Playwright and need outbound HTTP plus local browser execution.
- `sync` calls Google's official GTM API via interactive OAuth and needs outbound HTTP plus a local loopback callback on `127.0.0.1` to receive Google's consent redirect.
- If any of those commands behaves oddly in an environment that restricts one of those capabilities, rerun it in an environment that provides them before debugging the site or GTM setup itself.
- Run prompt-driven `sync` in an interactive TTY from the start. If the command cannot use a TTY, provide all target IDs explicitly with `--account-id`, `--container-id`, and `--workspace-id`; non-interactive invocation will otherwise fail at the first prompt.

## OAuth Failure

- Ensure GTM API is enabled: https://console.cloud.google.com/apis/library/tagmanager.googleapis.com
- The OAuth flow binds a local callback on `127.0.0.1` to receive Google's consent redirect. Environments that restrict local port binding will block this step.
- If you see an error like `listen EPERM 127.0.0.1`, treat it as an environment capability issue rather than a GTM configuration problem and rerun the authorization step in an environment that permits local loopback binding.
- Clear cached tokens and retry:
  ```bash
  ./event-tracking auth-clear --context-file <artifact-dir>/gtm-context.json
  ```
  Or clear every URL-scoped cache under a chosen root:
  ```bash
  ./event-tracking auth-clear --output-root <output-root>
  ```

## No Events Fire in Preview

- Confirm `preview` was run in an environment that permits outbound HTTP and local browser execution before investigating selectors or GTM config.
- The `preview` command automatically detects whether the target site has GTM installed.
- If the container is not found, it will prompt to either re-sync to the correct container or inject GTM during preview.
- If zero events fire even with injection, verify that the GTM public ID in `gtm-context.json` is correct.
- Confirm the GA4 Measurement ID (`G-XXXXXXXXXX`) in `gtm-config.json` is correct.
- If `eventTrackingMetadata.googleTagId` is present and differs from the measurement ID, remember that the configuration tag targets `configTagTargetId`, while GA4 event tags still use `ga4MeasurementId`.

Before declaring a click event to be a GTM configuration failure, rule out preview false negatives:

- same-origin SPA links may fire the business event only after router or history changes
- root URLs with and without a trailing slash should be treated as the same page during preview analysis
- external links, `_blank` links, and `mailto:` links may still require preview-safe handling to avoid losing browser context

Preview `no hit` is therefore **not automatically equivalent** to "broken GTM config". For navigation-heavy sites, first confirm whether the event fires in manual GTM preview / Tag Assistant before rewriting triggers.

## Shopify Sites

- Shopify sites do not use the normal automated preview path in this skill.
- After `sync`, install the generated `shopify-custom-pixel.js` in Shopify Admin and connect it.
- Validate with GA4 Realtime and Shopify pixel debugging tools after exercising product, cart, and checkout flows.
- If you re-sync to a different GTM container, regenerate and re-install the Shopify custom pixel so the container ID stays aligned.

## Selector Not Matching

- Use browser DevTools → inspect the element → right-click → Copy selector.
- Update the `elementSelector` field in `event-schema.json`.
- Re-run `generate-gtm` then `sync` to push the corrected trigger.

Do not approve selectors that only work because of crawler-only `:contains("...")` syntax. GTM does not execute `:contains()` in CSS selector triggers.

If the schema still contains selectors like:

- `a:contains("Pricing")`
- `button:contains("Get Started")`
- `a.group.flex:contains("Introduction")`

then treat them as unresolved discovery hints, not production-ready selectors. Replace them with `id`, stable `href`, `data-*`, `aria-*`, or another structural selector before shipping.

## Duplicate Tags After Re-sync

- `sync` now automatically cleans up stale `[JTracking]` managed entities and migrates legacy skill-managed names when possible.

## GTM API Rate Limit Errors

- Wait 60 seconds and retry the sync command.

## Firing Rate Below 80%

| Trigger Type | Likely Cause |
|---|---|
| Click | Selector doesn't match any visible element, or the element requires login |
| Form submit | reCAPTCHA or login-protected forms can't be submitted by automated browser — mark as expected failure |
| GTM not loading | Site doesn't have GTM installed — re-run preview with the injection option |
