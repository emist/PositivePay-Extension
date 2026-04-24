# Changelog

All notable changes to the PositivePay Extension will be documented in this file.

## [1.2.0] — 2026-04-24

### Added
- **Link Account button**: Detected ledger now shows a "Link" button in the popup that auto-fills the ledger name and focuses the account number input for one-click setup
- **Linked status badge**: When a detected ledger already has a saved account, the popup shows the masked account number and a green "Linked" badge
- **Newline-aware extraction**: `extractBusinessName()` now splits multi-line DOM text (e.g. business name + tagline on separate lines) and picks the line with the legal suffix
- **54 unit tests**: Added 4 new tests for newline-separated business name extraction

### Fixed
- Regex `\b` word boundaries in `extractBusinessName()` were double-escaped in template literals, making suffix matching a no-op — replaced with `indexOf`-based matching
- Ledger display now refreshes when accounts are added or deleted
- `detectLedger()` uses full `.active-business` textContent instead of first child element

---

## [1.1.1] — 2026-04-24

### Added
- **Tagline stripping**: `extractBusinessName()` removes slogans/taglines that follow legal suffixes (e.g. "Cornish Hernandez Gonzalez, PLLC We Help The Hurt" → "Cornish Hernandez Gonzalez, PLLC")
- **Div-based table detection**: `findRegistryTable()` now has 4 strategies — standard `<table>`, content-pattern matching, CSS class-based div grid detection, and broad DOM scan
- **Div-aware column/checkbox injection**: `identifyColumns`, `autoDetectColumns`, and `injectCheckboxes` all handle div-based grid layouts
- **Page structure dump**: When no table is found, logs full body children with tag names, classes, and child counts for remote debugging

### Fixed
- Ledger detection prioritizes `.active-business` element (CheckKeeper-specific)
- Table detection no longer assumes HTML `<table>` elements — CheckKeeper uses div grids

## [1.1.0] — 2026-04-24

### Added
- **Ledger detection**: Content script scans page headings, nav elements, dropdowns, breadcrumbs, and header text to detect the active CheckKeeper business/ledger name
- **Auto-matching**: When detected ledger matches a saved account (exact or partial, case-insensitive), the correct bank account is auto-selected for export — no picker needed
- **Comprehensive debug logging**: All content script and popup operations log to console with `[PositivePay]` prefix for easy filtering
- **PPAY_DEBUG message**: Popup can request a full page analysis dump from the content script for diagnostics
- **Active Ledger display**: Popup now shows the detected ledger name when connected to CheckKeeper
- **46 unit tests**: `normalizeLedgerName`, `extractBusinessName`, `scoreLedgerCandidate`, `buildPageAnalysis`, `matchLedgerToAccount` + original logic tests
- New directive: `directives/ledger_detection.md`

### Fixed
- Content script now initializes ledger detection independently of table detection
- Re-detects ledger on table mutation (handles SPA navigation)
- Logs waiting status and page analysis even when registry table is not found

## [1.0.0] — 2026-04-24

### Added
- Initial release of PositivePay for CheckKeeper Chrome Extension
- Content script injection on `app.checkeeper.com` with automatic table detection
- Checkbox injection into check registry rows with select-all support
- Floating export button with selection badge
- Account picker modal for multi-ledger support
- Popup UI with connection status, export trigger, and account manager
- First Citizens Bank Positive Pay CSV generation and download
- Toast notification system for success/warning/error feedback
- MutationObserver for SPA navigation and table content changes
- AGENTS.md framework instantiated (directives, execution, tests)
