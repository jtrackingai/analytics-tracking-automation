# Crawl Guide

Detailed guidance for Step 1 - website crawling and analysis.

## Coverage Expectations

Set these expectations with the user before crawling:

- The crawler **prioritizes** navigation links (`<nav>` / `<header>`) and then follows links up to 2 levels deep
- Per section (path prefix), at most 5 pages are sampled; similar template pages (e.g. `/blog/post-1`, `/blog/post-2`) are **deduplicated** under the same path pattern
- Only a limited number of child pages are sampled within the same section or path, so deeper links may not be captured
- Large sites may hit the **40-page total cap**; partial coverage is normal
- **E-commerce sites** trigger smarter URL ordering — category/listing pages before product pages
- Same registered-domain subdomains are in scope when they carry business-critical journeys. Prioritize linked subdomains such as `app.example.com`, `account.example.com`, `auth.example.com`, checkout/billing/payment hosts, login, signup, trial, pricing, contact-sales, and password-reset pages before broad blog or resource sampling.
- Do not blindly deep-crawl every subdomain. Support/docs/help-center subdomains, WAF-protected pages, and unrelated operational hosts should be listed as skipped or grouped separately only when they are reachable and relevant to the tracking goal.

## Partial Mode Rules

- All URLs must belong to the same registered domain as the root `<URL>`; subdomains such as `app.example.com/login` are valid when they share the root registered domain.
- Maximum 20 URLs per call — split into batches or use full-site mode for more

## Execution Environment

- `analyze` launches a real Chromium via Playwright and fetches the target site over HTTP. Run it in an environment that permits outbound network and local browser execution.
- Environments that restrict either tend to cause Playwright to hang or fail silently; empty crawls, timeouts, and incomplete page loads are common symptoms.

## Crawl Outcomes

| Outcome | Guidance |
|---------|----------|
| **Success with new pages** | Summarize pages analyzed; **proceed** to next step rather than only acknowledging crawl success. |
| **Some pages blocked (WAF)** | Show `crawlWarnings`. Suggest allowlisting the crawler user-agent or IP. |
| **Zero pages returned** | Likely WAF blocking. Suggest: (1) verify URL uses HTTPS, (2) allowlist crawler IP, (3) check site returns real HTML (not JS-only shell). |
| **Failure / generic error** | Ask user to retry later; don't invent technical root causes. |
| **Invalid content / off-domain redirect** | Verify URL and that site serves HTML. |

## What to Show the User

- How many pages were analyzed
- Any skipped URLs and why (login pages, WAF blocks, errors)
- Any same-domain business subdomains that were analyzed or intentionally skipped, especially app/login/signup/checkout flows
- Any `crawlWarnings`
- Detected platform (`generic` or `shopify`) and detection signals when available
- **Detected dataLayer events** — if the site already pushes events via `dataLayer.push()` (e.g. e-commerce `purchase`, `add_to_cart`), list them. These can be leveraged as `custom` triggerType events in Step 2 instead of re-instrumenting with click triggers.

## Anti-patterns

- Calling partial mode with **no URLs** or **mixed-domain URLs**
- Implying **100% URL enumeration** — always set realistic coverage expectations
- Ignoring a **zero-page** result without actionable next steps
- Re-running the same crawl repeatedly without addressing the root cause
