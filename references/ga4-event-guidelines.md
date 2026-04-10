# GA4 Event Naming Guidelines

Reference document for generating consistent, valid GA4 event names and parameters.

## Quality Standard

Industry-standard tracking is not only about valid naming.

When defining events and parameters:

- make each event business-meaningful, not just technically detectable
- choose parameters that support analysis, debugging, and QA
- prefer standard GA4 event names when they already match the intent
- avoid vanity events, redundant events, and low-signal interactions
- keep the schema broad enough to cover key journeys, but disciplined enough to stay maintainable

## Event Name Rules

- Use `snake_case` only — no spaces, hyphens, or camelCase
- Maximum **40 characters**
- Must start with a letter, not a number or underscore
- Avoid reserved GA4 event names (e.g. `session_start`, `first_visit`, `user_engagement`)

## Reserved / Auto-collected Events (Do NOT re-define)

| Event | Trigger |
|-------|---------|
| `page_view` | Each page navigation (can be customized but not duplicated) |
| `session_start` | Start of a new session |
| `first_visit` | First time a user visits |
| `user_engagement` | User is active on page > 10 s |
| `scroll` | User scrolls 90% depth (auto) — do not re-use `scroll` for custom scroll-depth tracking |
| `click` | Outbound link clicks (Enhanced Measurement) |
| `file_download` | File download links (Enhanced Measurement) |
| `form_start` / `form_submit` | Form interactions (Enhanced Measurement) |
| `video_start` / `video_progress` / `video_complete` | YouTube embeds (Enhanced Measurement) |

## Recommended Custom Event Names

| Intent | Suggested Event Name |
|--------|---------------------|
| CTA button click | `cta_click` |
| Sign up initiated | `signup_start` |
| Sign up completed | `signup_complete` |
| Login attempt | `login_attempt` |
| Login success | `login_success` |
| Pricing page view | `pricing_view` |
| Demo request | `demo_request_submit` |
| Search triggered | `search_submit` |
| Video play (non-YouTube) | `video_play` |
| Document download | `document_download` |
| Outbound link click | `outbound_click` |
| Error displayed | `error_shown` |
| Feature used | `feature_used` |

## Standard Parameters

Always include these parameters on every event:

| Parameter | GTM Variable | Notes |
|-----------|-------------|-------|
| `page_location` | `{{Page URL}}` | Full URL |
| `page_title` | `{{Page Title}}` | Document title |
| `page_referrer` | `{{Referrer}}` | Previous page URL |

## Click Event Parameters

| Parameter | GTM Variable / Value | Notes |
|-----------|---------------------|-------|
| `link_text` | `{{Click Text}}` | Visible label of clicked element |
| `link_url` | `{{Click URL}}` | Destination href |
| `link_classes` | `{{Click Classes}}` | CSS classes for debugging |
| `element_id` | `{{Click ID}}` | DOM id if present |

## Form Event Parameters

| Parameter | GTM Variable / Value | Notes |
|-----------|---------------------|-------|
| `form_id` | `{{Form ID}}` | id attribute of the form |
| `form_name` | form name / label | Human-readable form name |
| `form_destination` | `{{Form Target}}` | Submit action URL |

## Optional Custom Scroll-Depth Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `scroll_depth` | `{{Scroll Depth Threshold}}` | 25, 50, 75, or 100 |
| `scroll_units` | `"percent"` | Fixed string |

Only use these when scroll depth is genuinely important. Prefer a distinct custom event name such as `scroll_depth`.

## Priority Levels

| Level | Meaning |
|-------|---------|
| `high` | Core business event — track from day 1 |
| `medium` | Useful for analysis but secondary |
| `low` | Nice-to-have, minimal business impact |

## Trigger Type → GTM Trigger Mapping

| `triggerType` | GTM Trigger Type |
|--------------|-----------------|
| `page_view` | Page View |
| `click` | All Elements (filtered by CSS selector) |
| `form_submit` | Form Submission |
| `scroll` | Scroll Depth |
| `video` | YouTube Video |
| `custom` | Custom Event |

## Deduplication Rule

**Every `eventName` must be unique across the entire schema. No exceptions.**

When two interactions could share the same name, apply this decision tree:

### Can they be merged?

Merge into one event if the interactions are semantically the same action and the difference is only which page it happens on:
- Set `pageUrlPattern: ""` to cover all pages
- Use `page_location` / `page_title` / `link_text` parameters to distinguish in GA4

### Can they NOT be merged?

Keep them separate — but **rename** to reflect the distinct intent. Never leave two events with the same name:

| Situation | Wrong ✗ | Right ✓ |
|-----------|---------|---------|
| Same CTA text, different business intent | `cta_click` (homepage) + `cta_click` (pricing) | `cta_get_started_click` (global) + `pricing_plan_click` (scoped to /pricing) |
| Same trigger type, different context | `form_submit` (newsletter) + `form_submit` (contact) | `newsletter_subscribe` + `contact_form_submit` |
| Same scroll trigger, different depth meaning | `scroll` (blog) + `scroll` (homepage) | One global `scroll_depth` event with `scroll_depth` parameter |

### Checklist before finalizing the schema

Run a mental dedup pass:
1. List all `eventName` values
2. If any name appears more than once → merge or rename
3. After merging, verify the merged event's parameters still carry enough context for analysis
