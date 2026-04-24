# CSV Export Directive

## Goal
Generate a First Citizens Bank Positive Pay CSV from selected checks.

## Inputs
- Selected checks (Map of `rowId → { checkNumber, payee, amount, date }`)
- Bank account number (selected by user from saved accounts)

## CSV Format
```
AccountNumber,CheckNumber,Amount,Date,IssueIndicator,PayeeName
```

### Field Rules
| Field | Format | Notes |
|---|---|---|
| AccountNumber | Raw digits | From saved account mapping |
| CheckNumber | Digits only | Strip non-digit characters |
| Amount | `###.##` | Two decimal places, no `$` or commas |
| Date | `MMDDYYYY` | Eight digits, zero-padded |
| IssueIndicator | `I` | Always "I" for issued checks |
| PayeeName | Text, no commas | Max 80 chars, commas stripped |

## Output
- Downloaded file: `positive_pay_YYYY-MM-DD.csv`
- No header row
- One line per check

## Validation
- Skip rows with missing check number (show warning toast)
- Skip rows with unparseable date (show warning toast)
- If no valid rows remain after filtering, show error toast and abort

## Edge Cases
- If user cancels account picker → abort silently
- If only one account saved → auto-select it (no modal)
- If zero accounts saved → show "configure in popup" modal
