# Changelog

All notable changes to the PositivePay Extension will be documented in this file.

## [1.1.0] — 2026-04-24

### Added
- **Ledger detection**: Content script scans page headings, nav elements, dropdowns, breadcrumbs, and header text to detect the active CheckKeeper business/ledger name
- **Auto-matching**: When detected ledger matches a saved account (exact or partial, case-insensitive), the correct bank account is auto-selected for export — no picker needed
- **Comprehensive debug logging**: All content script and popup operations log to console with `[PositivePay]` prefix for easy filtering
- **PPAY_DEBUG message**: Popup can request a full page analysis dump from the content script for diagnostics
- **Active Ledger display**: Popup now shows the detected ledger name when connected to CheckKeeper
- **22 new unit tests**: `normalizeLedgerName`, `scoreLedgerCandidate`, `buildPageAnalysis`, `matchLedgerToAccount` (39 total tests)
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
