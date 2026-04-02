# GTM Troubleshooting

## OAuth Failure

- Ensure GTM API is enabled: https://console.cloud.google.com/apis/library/tagmanager.googleapis.com
- Run `sync` outside the sandbox. The OAuth flow may need to bind a local callback on `127.0.0.1`, which sandboxed environments commonly block.
- If you see an error like `listen EPERM 127.0.0.1`, treat it as an environment issue rather than a GTM configuration problem and rerun the authorization step outside the sandbox.
- Clear cached tokens and retry:
  ```bash
  node dist/cli.js auth-clear --context-file <artifact-dir>/gtm-context.json
  ```
  Or clear every URL-scoped cache under a chosen root:
  ```bash
  node dist/cli.js auth-clear --output-root <output-root>
  ```

## No Events Fire in Preview

- The `preview` command automatically detects whether the target site has GTM installed.
- If the container is not found, it will prompt to either re-sync to the correct container or inject GTM during preview.
- If zero events fire even with injection, verify that the GTM public ID in `gtm-context.json` is correct.
- Confirm the GA4 Measurement ID (`G-XXXXXXXXXX`) in `gtm-config.json` is correct.
- If `eventTrackingMetadata.googleTagId` is present and differs from the measurement ID, remember that the configuration tag targets `configTagTargetId`, while GA4 event tags still use `ga4MeasurementId`.

## Shopify Sites

- Shopify sites do not use the normal automated preview path in this skill.
- After `sync`, install the generated `shopify-custom-pixel.js` in Shopify Admin and connect it.
- Validate with GA4 Realtime and Shopify pixel debugging tools after exercising product, cart, and checkout flows.
- If you re-sync to a different GTM container, regenerate and re-install the Shopify custom pixel so the container ID stays aligned.

## Selector Not Matching

- Use browser DevTools → inspect the element → right-click → Copy selector.
- Update the `elementSelector` field in `event-schema.json`.
- Re-run `generate-gtm` then `sync` to push the corrected trigger.

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
