# Shopify Workflow

Reference document for the Shopify branch of the event-tracking workflow.

Use this when `site-analysis.json` reports:

```json
{
  "platform": {
    "type": "shopify"
  }
}
```

## High-Level Difference

Shopify uses the same crawl and grouping flow as generic sites, but differs in three places:

1. Schema authoring starts from a Shopify-aware bootstrap
2. Ecommerce events are primarily `triggerType: "custom"`
3. Verification depends on Shopify custom pixel installation rather than the normal automated GTM preview flow

## Shopify Artifacts

During `prepare-schema`, a Shopify run generates:

- `shopify-schema-template.json`
- `shopify-bootstrap-review.md`
- `event-schema.json` if that file does not already exist

During `sync`, a Shopify run also generates:

- `shopify-custom-pixel.js`
- `shopify-install.md`

## Bootstrap Schema Expectations

Baseline ecommerce events usually include:

- `view_item`
- `view_item_list`
- `add_to_cart`
- `remove_from_cart`
- `view_cart`
- `begin_checkout`
- `add_shipping_info`
- `add_payment_info`
- `purchase`

The bootstrap may also infer storefront events when strong selector matches exist:

- `login_click`
- `signup_click`
- `get_started_click`
- `search_submit`

## Review Checklist

Always read `shopify-bootstrap-review.md` before accepting the schema.

The file classifies events into three recommendation buckets:

- Keep
- Review manually
- Remove

Interpret them as follows:

- Keep: safe default; keep unless the storefront genuinely does not use this flow
- Review manually: useful candidate, but confirm business intent and selector scope
- Remove: inferred from a weak or overly generic selector; remove or rewrite before publishing

The CLI also prints the same summary immediately after `prepare-schema`.

## Event Authoring Rules

For Shopify:

- Keep ecommerce funnel events primarily as `custom`
- Prefer direct GA4 ecommerce event names
- Prefer custom pixel `dataLayer` values such as:
  - `{{page_location}}`
  - `{{page_title}}`
  - `{{page_referrer}}`
  - `{{currency}}`
  - `{{value}}`
  - `{{items}}`
  - `{{transaction_id}}`
- Only use selector-based `click` / `form_submit` events for clear storefront CTA or search interactions

## Validation Rules

`validate-schema --check-selectors` behaves differently for Shopify:

- `custom` ecommerce events are skipped during selector checking
- selector-based `click` / `form_submit` events are still validated against the DOM

This means selector validation is still valuable, but it is not the validation method for Shopify ecommerce events.

## Install + Verification

After `sync`:

1. Install `shopify-custom-pixel.js` in Shopify Admin -> Settings -> Customer events
2. Save and connect the pixel
3. Publish the GTM workspace
4. Validate in GA4 Realtime and Shopify pixel debugging tools

The normal browser-style automated GTM preview path is not the source of truth for Shopify custom pixels.

## Common Review Decisions

Typical examples:

- `login_click` pointing to `/account/login`: usually Keep
- `get_started_click`: often Review manually
- `search_submit` with selector `form`: usually Remove

## When To Edit The Bootstrap

Edit the Shopify bootstrap schema when:

- your storefront does not use account login or registration
- the inferred CTA text does not match your actual business intent
- the inferred selector is too broad
- the store uses custom purchase or upsell flows that need additional tracking

## Safe Default Approach

If unsure:

1. Keep the baseline Shopify ecommerce events
2. Keep only high-confidence inferred selector events
3. Delete weak inferred selectors
4. Add any missing storefront CTAs manually
