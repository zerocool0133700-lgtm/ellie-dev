---
name: browser
description: Live browser automation via Chrome DevTools Protocol — read pages, click elements, take screenshots, execute JavaScript in any tab Dave is logged into
triggers:
  - browse
  - open page
  - screenshot
  - scrape
  - read page
  - click on
  - what does the page say
  - check the website
requirements:
  - Chrome/Chromium must be running with remote debugging enabled
always_on: false
---

# Browser Automation (Chrome CDP)

Access Dave's live Chrome browser session — all logged-in accounts, cookies, and tabs intact. No re-login needed.

## Available Commands

### Page Inspection
- `chrome-cdp list` — List all open tabs (title, URL, type)
- `chrome-cdp snap <tab-id>` — Get accessibility tree (semantic page structure, best for understanding content)
- `chrome-cdp html <tab-id> [selector]` — Get full HTML or scoped to CSS selector
- `chrome-cdp shot <tab-id>` — Take screenshot (saved to PNG)
- `chrome-cdp net <tab-id>` — Network resource timing

### Interaction
- `chrome-cdp click <tab-id> <selector>` — Click element by CSS selector
- `chrome-cdp clickxy <tab-id> <x> <y>` — Click by coordinates
- `chrome-cdp type <tab-id> <text>` — Type text at focused element
- `chrome-cdp nav <tab-id> <url>` — Navigate to URL
- `chrome-cdp open <url>` — Open new tab

### Advanced
- `chrome-cdp eval <tab-id> <js>` — Execute JavaScript in page context
- `chrome-cdp loadall <tab-id> <selector>` — Click "load more" repeatedly until done

## When to Use
- Scraping data from websites Dave is logged into (Plane, Supabase, Grafana, etc.)
- Taking screenshots for visual reports
- Reading page content for context (accessibility tree is most useful)
- Automating form fills or button clicks on web UIs without APIs
- Checking what a page looks like after a deployment

## Best Practices
- Prefer `snap` over `html` — accessibility tree is smaller and more semantic
- Use `shot` for visual verification, not for reading text
- Don't navigate away from pages Dave is actively using
- Never type passwords or sensitive data — Dave's session already has auth
- Check `list` first to find the right tab before acting

## Anti-Patterns
- Don't use for sites with APIs (use the API directly instead)
- Don't automate banking or financial sites
- Don't close tabs that Dave has open
- Don't run `eval` with destructive scripts
