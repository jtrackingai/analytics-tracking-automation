# Event Schema Generation Guide

Detailed rules for Step 3 - generating the GA4 event schema.

## Input Data

Run `confirm-page-groups` after page-group review, then run `prepare-schema` to derive a compact schema context from `site-analysis.json`:
```bash
node dist/cli.js confirm-page-groups <artifact-dir>/site-analysis.json
node dist/cli.js prepare-schema <artifact-dir>/site-analysis.json
```

`prepare-schema` will stop if the current `pageGroups` snapshot has not been explicitly confirmed yet.

Read `<artifact-dir>/schema-context.json` and analyze:
- Detected `platform` metadata (`generic` or `shopify`)
- All groups and their URL patterns
- Deduplicated interactive elements per group (with `occurrences` count)
- Per-group features (`hasSearchForm`, `hasVideoPlayer`)
- `representativeHtml` on each group for DOM context

If the site is Shopify, also read `<artifact-dir>/shopify-schema-template.json`. It contains the baseline ecommerce custom events that should usually be kept unless the storefront truly does not use that part of the funnel.

If `<artifact-dir>/event-schema.json` did not exist yet when `prepare-schema` ran, the CLI will already have initialized it from the Shopify template. In that case, edit that bootstrapped file instead of starting from scratch.

The Shopify bootstrap may also include a small number of inferred selector-based storefront events when the crawl found strong CTA matches. Current high-confidence auto-inferred events are:

- `login_click`
- `signup_click`
- `get_started_click`
- `search_submit`

These are based on real analyzed elements, not placeholders, but they should still be reviewed and validated before publishing.

Also review `<artifact-dir>/shopify-bootstrap-review.md` to see why each baseline or inferred Shopify event was included and which source selector or Shopify standard event it came from.

That review file also gives a recommendation status for each event:

- Keep: usually safe to keep
- Review manually: likely useful, but check business intent and selector scope
- Remove: inferred from a weak or overly generic selector and should usually be removed or rewritten

Also refer to `ga4-event-guidelines.md` for naming conventions and standard parameters.

## Event Generation Rules

- **Deduplication (strict)**: every `eventName` must be unique across the schema. Merge same-name events (broaden `pageUrlPattern` to `""`) or rename to distinguish intent.
- **Global elements first**: Process the `global_elements` group (contentType `global`) **before** other groups. Shared header, footer, and nav elements get `pageUrlPattern: ""` and are generated **exactly once**. Other groups **skip** elements with `parentSection` of `header`, `footer`, or `nav`.
- Do **not** generate default `page_view` or `scroll` events. The GTM configuration tag already sends `page_view`, and `scroll` is usually auto-collected by GA4 Enhanced Measurement.
- Only add a custom scroll-depth event if there is a clear analysis need. If you do, use a distinct custom event name such as `scroll_depth`, not the reserved `scroll`.
- Click events for meaningful buttons: login, signup, CTA, download, share, outbound links
- Form submit events for login/signup/email capture forms
- Custom events for search and video if detected
- Merge events with the same semantic meaning across pages
- Event names: snake_case, max 40 chars, descriptive
- Parameters: always include `page_location: {{Page URL}}` and relevant GTM built-in variables

## Shopify Branch

If `platform.type === "shopify"`, use a mixed strategy:

- Keep selector-based `click` / `form_submit` events only for clear storefront interactions when they are still needed
- Prefer `triggerType: "custom"` for ecommerce funnel events
- Use GA4 ecommerce event names directly so the Shopify custom pixel can push them into `dataLayer` without an extra rename layer

Recommended Shopify ecommerce events:

| Shopify source event | Schema `eventName` | Trigger Type |
|---|---|---|
| `product_viewed` | `view_item` | `custom` |
| `collection_viewed` | `view_item_list` | `custom` |
| `product_added_to_cart` | `add_to_cart` | `custom` |
| `product_removed_from_cart` | `remove_from_cart` | `custom` |
| `cart_viewed` | `view_cart` | `custom` |
| `checkout_started` | `begin_checkout` | `custom` |
| `checkout_address_info_submitted` | `add_shipping_info` | `custom` |
| `payment_info_submitted` | `add_payment_info` | `custom` |
| `checkout_completed` | `purchase` | `custom` |

For Shopify custom events, prefer `dataLayer` variables pushed by the custom pixel bridge instead of DOM built-ins:

- `page_location: {{page_location}}`
- `page_title: {{page_title}}`
- `page_referrer: {{page_referrer}}`
- `currency: {{currency}}`
- `value: {{value}}`
- `items: {{items}}`
- `transaction_id: {{transaction_id}}`
- `shipping_tier: {{shipping_tier}}`
- `payment_type: {{payment_type}}`

## Selector Format

Use standard CSS selectors in `elementSelector`. The crawler may produce `:contains("text")` pseudo-selectors — these are **not supported by GTM**. The `generate-gtm` command automatically strips `:contains()` and converts to **Click Text matching**. This may fail if text is dynamically rendered or has extra whitespace. Prefer `data-testid`, `id`, or `class`-based selectors when available.

Selectors generated with `:contains()` are automatically converted into Click Text matching, but that can be unreliable when text is dynamically rendered. Prefer `data-testid`, `id`, or `class` selectors when available.

## Output Format

Write to `<artifact-dir>/event-schema.json`:
```json
{
  "siteUrl": "<rootUrl>",
  "generatedAt": "<ISO timestamp>",
  "events": [
    {
      "eventName": "cta_click",
      "description": "User clicks the primary CTA button.",
      "triggerType": "click",
      "pageUrlPattern": "...",
      "elementSelector": "button.primary-cta",
      "parameters": [
        { "name": "page_title", "value": "{{Page Title}}", "description": "Page title" },
        { "name": "link_text", "value": "{{Click Text}}", "description": "Clicked CTA label" }
      ],
      "priority": "high"
    }
  ]
}
```

`triggerType` must be one of: `page_view` | `click` | `form_submit` | `scroll` | `video` | `custom`

`page_view` and `scroll` are accepted only for legacy schemas. New schemas should omit the auto-collected `page_view` / `scroll` event names.

## Validation

After writing the schema, validate it with selector checking enabled (default):
```bash
node dist/cli.js validate-schema <artifact-dir>/event-schema.json --check-selectors
```

The `--check-selectors` flag launches a browser and verifies each CSS selector actually matches a DOM element on the live site. **Always use it** — it catches selector mismatches before they silently fail in production.

If the site requires login to access some pages (and those selectors can't be verified), note which events are behind auth walls and manually verify them during the preview step.

For Shopify schemas, selector checking still applies to `click` and `form_submit` events, but it does **not** validate `custom` ecommerce events. The CLI explicitly reports those events as skipped and reminds the user that they are verified only after the generated Shopify custom pixel is installed.

For lightweight syntax-only validation (no browser):
```bash
node dist/cli.js validate-schema <artifact-dir>/event-schema.json
```

The `generate-gtm` command also runs validation automatically.

## User Review Gate

After the schema validates successfully, stop and present the event list to the user before moving to GTM generation.

The review must include both:

- the events themselves
- the parameters / properties attached to each event

Users may want to adjust parameter names, GTM variable values, or descriptions before implementation. Treat parameter review as part of the required approval gate.

Minimum review view:

| Event Name | Trigger Type | Page Pattern | Priority |
|------------|-------------|--------------|----------|

Also show, for each event:

- `elementSelector` when applicable
- the full `parameters` list with parameter name, GTM value, and description
- any `notes` field when present

Preferred display style for parameters:

- group parameters under each event instead of using one flat table for all events
- when a table is used, show the event name once per grouped block rather than repeating it on every parameter row
- optimize for readability in chat / terminal output, not spreadsheet-style normalization

Also share the generated `event-spec.md` when available.

This is a required approval gate:

- do not continue to `generate-gtm`
- do not continue to `sync`
- do not continue to `preview`
- do not continue to `publish`

Only proceed once the user explicitly confirms that both the event schema and the event parameters are correct.

## Anti-patterns

- Generating the same event in `global_elements` **and** in another group — global group owns shared elements exclusively
- Ignoring `parentSection` and treating every element as page-specific
- Creating a global event for an element that only appears on 1-2 pages — `parentSection: "nav"` alone is not enough; the element must actually repeat across pages
- Re-defining `page_view` or `scroll` as custom schema events when the default configuration already covers them
- Continuing to GTM generation or sync before the user has reviewed and approved the generated event list
