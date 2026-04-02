# Preview Validation Report Template

Use this as a generic English template when turning raw preview output into a stakeholder-facing validation report. Adapt the placeholders to the current site, page groups, event set, and release scope.

**Site:** `<site-url>`  
**Preview Container:** `<GTM-XXXXXXX>`  
**Preview Started:** `<YYYY-MM-DD HH:mm:ss>`  
**Preview Ended:** `<YYYY-MM-DD HH:mm:ss>`  
**Validation Scope:** `<Homepage / Pricing / Blog / ...>`  
**Environment Notes:** `<optional: excluded pages, injected test container, non-production setup, preview limitations>`

---

## 1. Summary

| Metric | Result |
|---|---|
| Expected Events | `<number>` |
| Automated Validation Result | `<x / y events fired>` |
| Automated Pass Rate | `<percentage>` |
| Current Acceptance Status | `<pass / review / fix breakdown>` |
| High Priority Issues | `<number>` |
| Release Recommendation | `<publish now / fix first / confirm scope first>` |

### Current Blockers And Release Decision

- `<event_name>` — Why it matters: `<business impact or funnel role>`. Current issue: `<selector not found / partially fired / boundary unclear / not in current scope>`. Recommended action: `<fix selector / confirm live CTA status / remove from scope / revisit later>`.
- `<event_name>` — Why it matters: `<business impact or funnel role>`. Current issue: `<...>`. Recommended action: `<...>`.
- `<event_name>` — Current issue: `<...>`. Recommended action: `<...>`.

### If The Reader Only Looks At The Summary

- If the unresolved high-priority events still represent real live conversion entry points, treat them as release blockers and re-run Preview after fixing them.
- If those events are no longer real live entry points or are out of this release scope, remove them from the release decision and reassess based on the remaining results.
- Treat stable page groups as ready for delivery. Treat partially passing groups as event-boundary clarification work unless they represent a live primary conversion path.

### Page Group Overview

| Page Group | Current Status | Business Read | Recommended Action |
|---|---|---|---|
| `<global_elements>` | `<passed / review / fix / n/a>` | `<what this means for delivery>` | `<what to do next>` |
| `<homepage>` | `<...>` | `<...>` | `<...>` |
| `<pricing>` | `<...>` | `<...>` | `<...>` |
| `<group-name>` | `<...>` | `<...>` | `<...>` |

---

## 2. Validation Results

Repeat the following subsection for each page group. Keep the structure consistent so the reader can compare groups quickly.

### 2.1 `<Page Group Name>`

#### Group Purpose

`<What this group is meant to validate. Focus on business behavior, not only page structure.>`

#### Covered Pages

- `/<path>`
- `/<path>`
- `/<path-or-pattern>`

#### Group Conclusion

- `<Short conclusion about what passed>`
- `<Short conclusion about what failed or still needs confirmation>`
- `<Short delivery or release implication>`

| Event Name | Event Description | Trigger Type | Parameters | Pages | Status | Priority | Failure Reason |
|---|---|---|---|---|---|---|---|
| `<event_name>` | `<what the event represents>` | `<click / form_submit / custom>` | `<page_location, page_title, ...>` | `<page list or pattern>` | `✅ Fired` | `<high / medium / low>` | `-` |
| `<event_name>` | `<what the event represents>` | `<click / form_submit / custom>` | `<page_location, page_title, ...>` | `<page list or pattern>` | `❌ Not Fired` | `<high / medium / low>` | `<selector mismatch / config issue / element not visible / scope issue>` |
| `<event_name>` | `<what the event represents>` | `<click / form_submit / custom>` | `<page_location, page_title, ...>` | `<page list or pattern>` | `⚠️ Partially Fired` | `<high / medium / low>` | `<fires on some pages but not others; boundary needs clarification>` |
| `<event_name or placeholder>` | `<why this group currently has no page-specific event>` | `-` | `-` | `<page list or pattern>` | `➖ Not Applicable` | `-` | `<covered only by shared/global events or intentionally out of scope>` |

### 2.2 `<Next Page Group Name>`

Repeat the same structure until all in-scope page groups are covered.

---

## 3. Recommendations

### 3.1 Recommended Next Actions

- Fix high-priority events that still map to real live conversion entry points before publishing.
- Clarify event boundaries for partially passing events, especially when the behavior spans list pages, detail pages, and shared navigation.
- Add page-specific events for educational, support, or content pages when shared navigation coverage alone is not enough for analysis.
- Re-run Preview after fixes before making the final publish decision.

### 3.2 Optional Follow-Up Note

- If needed, add a separate note about broader tracking upgrades, hosted workflows, or more advanced analytics capabilities.
- Keep that note outside the core validation findings and outside the blocker / release decision sections.

---

_This report is typically based on `preview-result.json`, `event-schema.json`, and the selected preview scope. Use it for tracking QA, release decisions, and follow-up implementation work._
