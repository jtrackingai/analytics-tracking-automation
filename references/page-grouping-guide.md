# Page Grouping Guide

Detailed guidance for Step 2 - semantic page grouping.

## Signals to Analyze (per page)

| Signal | What it tells you |
|--------|-------------------|
| `url` | Path structure hints at section; but don't group **solely** by URL |
| `title` | Often the clearest indicator of page purpose |
| `description` | Meta description reflects business intent |
| `elements` | Buttons, forms, CTAs reveal conversion vs informational pages |
| `elements[].parentSection` | Which DOM section the element lives in (`header`, `footer`, `nav`, `main`, `aside`, `article`). Elements with `parentSection` of `header`/`footer`/`nav` that appear across most pages are **shared/global** elements |
| `sectionClasses` | Top-level CSS classes fingerprint the page template — pages with similar class sets share the same layout |
| `cleanedHtml` | Simplified DOM snapshot — use in Step 2 for CSS selector generation and DOM context analysis |

## Content Types

| contentType | Business purpose |
|---|---|
| `landing` | Root homepage — the main entry point |
| `marketing` | Pages designed to explain the product and convert visitors (pricing, features, how-it-works, solutions, use-cases, integrations) |
| `legal` | Pages that disclose obligations or data practices (privacy, terms, compliance, transparency, accessibility) |
| `blog` | Editorial and educational content (articles, news, resources, insights) |
| `case_study` | Customer proof and social validation (case studies, testimonials, success stories) |
| `documentation` | Self-serve technical or usage help (docs, guides, API reference, changelog) |
| `about` | Company identity pages (about, team, careers, contact, press, investors) |
| `global` | **Shared cross-page elements** — header, footer, navigation. A virtual group for elements that appear site-wide |
| `other` | Does not fit any of the above |

## Shared Region Detection — `global_elements` Group

Before creating page-specific groups, identify **cross-page shared elements**:

1. **Scan `parentSection`**: Collect all elements where `parentSection` is `header`, `footer`, or `nav` across every crawled page
2. **Find repeats**: Elements that share the same `selector` + `text` (or `ariaLabel`) across **>= 50% of crawled pages** are shared/global
3. **Create the group**: Add a `global_elements` page group with:
   - `contentType: "global"`
   - `urls`: all crawled URLs
   - `urlPattern: ""` (matches all pages)
   - `representativeHtml`: pick any page's cleaned HTML

Typical site-wide shared elements include login or sign-up buttons in the top navigation, menu links in the header, and social or legal links in the footer. Put them in a single `global_elements` group so the event is generated once and reused site-wide.

**When NOT to create this group**: If the site has fewer than 3 crawled pages, or no elements repeat across pages.

## Coverage Expectations

- **Language**: Groups reflect the site's **main language**. Other language versions may not fully appear because sitemaps usually favor pages in the site's primary language.
- **Business subdomains**: Same registered-domain subdomains that host login, signup, app onboarding, checkout, billing, account, trial, or contact-sales journeys should be grouped when they were discovered or manually verified as reachable. Put them in explicit groups such as `auth_pages`, `checkout_pages`, or `app_pages` rather than hiding them inside generic marketing groups.
- **Unreachable subdomains**: Do not create groups for support/docs/help-center subdomains that are WAF-blocked, timeout, or are not relevant to the tracking goal. Keep them as skipped evidence instead.
- **Can't group what wasn't crawled or verified**: Deep links, gated content, and login-protected pages won't appear unless they were crawled or manually verified and added with enough representative HTML/elements for schema generation.
- **Don't claim completeness**: Groups represent crawled and sampled pages, not every URL on the site.

## Compute urlPattern

After grouping, compute `urlPattern` for each group:
- Single URL with path `/blog` -> `\/blog`
- Multiple paths -> alternation: `\/(privacy|terms|ai-transparency)`
- Root `/` only -> empty string (matches all pages)

**The agent computes urlPattern automatically.** The user adjusts groups by moving pages; the agent recalculates.

## Pick Representative HTML

For each group, select the page with the most interactive elements and copy its `cleanedHtml` into the group's `representativeHtml` field.

## Modifications

If the user requests changes to groups:
- **Rename group**: change `name`, `displayName`, `description`
- **Move page**: remove URL from source group, add to target, recalculate `urlPattern` for both
- **Add group**: append new entry with all required fields
- **Delete group**: move its `urls` into the most semantically similar group, recalculate `urlPattern`

After changes, display updated table and ask for final confirmation.

Once the user approves the current grouping, record that exact snapshot with:

```bash
./event-tracking confirm-page-groups <artifact-dir>/site-analysis.json
```

## Anti-patterns

- Claiming page groups exist when `pageGroups` is empty or crawl returned zero pages
- Putting every crawled URL into its own group — use **meaningful groups**
- Promising 100% URL coverage or all language versions
- Asking the user to hand-write regex for `urlPattern` — the agent computes it
- Ignoring that uncrawled pages cannot be grouped
