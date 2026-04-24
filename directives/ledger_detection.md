# Ledger Detection Directive

## Goal
Detect which CheckKeeper ledger/business is currently active on the page so the extension can auto-match the correct bank account number.

## Background
CheckKeeper allows users to manage multiple businesses/ledgers. The URL (`app.checkeeper.com`) stays the same — the active business is selected through a UI switcher. Previous auto-detection logic guessed at CSS selectors and fell back to `document.title` (which just returned "Checkeeper"), so it was removed.

## Strategy

### Phase 1: Debug Logging (Current)
Add comprehensive console debug output to understand CheckKeeper's DOM:
- Page URL and title
- All heading elements (h1-h6) and their text
- Navigation/sidebar text
- Business switcher or dropdown elements
- Any data attributes that might contain business/ledger identifiers
- Breadcrumb text

### Phase 2: Detection (After DOM Analysis)
Once we understand the DOM structure from debug output, implement targeted detection.

### Phase 3: Auto-Match
When a ledger is detected, auto-match to saved accounts for seamless export.

## Tools/Scripts
- `content.js` — `debugPageAnalysis()` function outputs structured page info to console
- `content.js` — `detectLedger()` function returns the best-guess ledger name
- `tests/logic.test.js` — Unit tests for ledger name normalization

## Edge Cases
- Cloudflare protection blocks automated access — must rely on injected content script
- CheckKeeper is a SPA — ledger name may change without page reload
- Page title is generic ("Checkeeper") — cannot rely on it
- Multiple businesses may use similar naming patterns
