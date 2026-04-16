# Preview Unexpected Event Rules

Preview verification ignores a small set of unexpected GA4 event names that are commonly auto-collected by GA4 / Google tag and should not be treated as schema drift.

Ignored by default:
- `page_view`
- `scroll`
- `form_start`
- `form_submit`
- `user_engagement`
- `session_start`
- `first_visit`
- `click`
- `file_download`
- `video_start`
- `video_progress`
- `video_complete`
- `view_search_results`

Special handling:
- `page_view\r`
  This is not treated as a real event. Preview now normalizes captured event names with `.trim()`, so carriage-return pollution is removed during parsing.
- `audiences`
  This is ignored in preview drift reporting because it is commonly emitted by Google tag / GA audience processing and is not part of the managed schema. This is an implementation inference based on observed preview traffic, not an official GA4 auto-collected-event classification.

Why this exists:
- Preview reports are meant to catch schema-managed GTM drift.
- GA4 auto/enhanced-measurement events create noise and can cause false positives in preview summaries, tracking health, and upkeep drift reporting.
- These ignored names should not block publish decisions unless they are explicitly added to the managed schema.
