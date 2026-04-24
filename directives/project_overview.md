# Project Overview — PositivePay for CheckKeeper

## What It Is
A Chrome Extension (Manifest V3) that injects into `app.checkeeper.com` to let users:
1. Select checks from CheckKeeper's check registry table
2. Map ledgers to bank account numbers
3. Export a **First Citizens Bank Positive Pay CSV** file

## Architecture

### Files
| File | Role |
|---|---|
| `manifest.json` | Extension manifest (MV3). Content script injected on `checkeeper.com/*`. |
| `popup.html/css/js` | Extension popup: connection status, account manager, export trigger. |
| `content.js` | Injected into CheckKeeper: finds registry table, injects checkboxes, generates CSV. |
| `content.css` | Styles for injected UI (checkboxes, floating button, modal, toasts). |
| `icons/` | Extension icons (16, 48, 128px). |

### Data Flow
```
popup.js ──(chrome.tabs.sendMessage)──► content.js
                                          │
content.js reads table rows               │
content.js prompts account selection       │
content.js generates CSV & triggers download
```

### Storage
- `chrome.storage.local` key: `ppay_accounts`
- Value: `{ "Ledger Name": "123456789", ... }`

### CSV Format (First Citizens Positive Pay)
```
AccountNumber,CheckNumber,Amount,Date,IssueIndicator,PayeeName
```
- Date format: `MMDDYYYY`
- IssueIndicator: always `I` (issue)

## Edge Cases & Gotchas
- CheckKeeper is a SPA — content script uses polling + MutationObserver to find the table.
- Column detection uses header text first, then falls back to content-pattern analysis.
- Account picker auto-resolves if only one account is saved.
- Table pagination/sorting clears selected checks (MutationObserver on `<tbody>`).

## Permissions
- `activeTab` — access the current tab
- `storage` — persist ledger→account mappings
