# Testing Directive

## Goal
Ensure all PositivePay logic is covered by automated tests following Red-Green TDD.

## Strategy
Since this is a Chrome Extension, we split testing into two tiers:

### Tier 1: Pure Logic (Unit Tests)
Functions that don't depend on the DOM or Chrome APIs can be tested directly:
- `parseAmount(raw)` → returns `"123.45"` formatted string
- `parseDate(raw)` → returns `"MMDDYYYY"` string
- `sanitizePayee(raw)` → returns cleaned payee string (no commas, max 80 chars)
- `maskAccount(num)` → returns masked display string

**Tool:** Node.js test runner (`node --test`) — no external dependencies needed.

**How to extract:** These functions live inside IIFEs in `content.js` and `popup.js`. To test them, extract into a shared `lib/` module or duplicate the logic in test files with the canonical source documented.

### Tier 2: Integration (Manual / Browser)
- Checkbox injection into a mock table
- CSV generation with known inputs
- Popup ↔ content script messaging

**Tool:** Manual verification or Puppeteer/Playwright if added later.

## Running Tests
```bash
node --test tests/
```

## Edge Cases to Cover
- Empty/null inputs to all parse functions
- Amounts with no decimals, extra commas, negative values
- Dates in various formats: `MM/DD/YYYY`, `YYYY-MM-DD`, `Apr 24, 2026`
- Payee names with commas, special chars, 100+ char names
- Account numbers shorter than 4 digits
