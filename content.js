/**
 * PositivePay for CheckKeeper — Content Script
 * 
 * Injected into CheckKeeper (app.checkeeper.com) to:
 *   1. Detect the check registry table
 *   2. Inject selection checkboxes into each row
 *   3. Provide a floating export button for Positive Pay CSV generation
 *   4. Let user pick which saved account to use when exporting
 */

(function () {
  'use strict';

  /* ─── State ─── */
  const state = {
    selectedChecks: new Map(),   // rowId → { checkNumber, payee, amount, date }
    initialized: false,
    tableObserver: null,
    bodyObserver: null,
  };

  /* ─── Constants ─── */
  const STORAGE_KEY = 'ppay_accounts';   // chrome.storage key for { ledgerName: accountNumber }

  /* ─── Utility: Parse amount string → "123.45" ─── */
  function parseAmount(raw) {
    if (!raw) return '0.00';
    // Remove $, commas, whitespace
    const cleaned = raw.replace(/[$,\s]/g, '');
    const num = parseFloat(cleaned);
    if (isNaN(num)) return '0.00';
    return num.toFixed(2);
  }

  /* ─── Utility: Parse date string → "MMDDYYYY" ─── */
  function parseDate(raw) {
    if (!raw) return '';
    // Try common formats: MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD, "Apr 24, 2026", etc.
    const d = new Date(raw);
    if (isNaN(d.getTime())) {
      // Fallback: try regex for MM/DD/YYYY or M/D/YYYY
      const m = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      if (m) return m[1].padStart(2, '0') + m[2].padStart(2, '0') + m[3];
      return '';
    }
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = String(d.getFullYear());
    return mm + dd + yyyy;
  }

  /* ─── Utility: Sanitize payee name (max 80 chars, no commas) ─── */
  function sanitizePayee(raw) {
    if (!raw) return '';
    // Remove commas (they break CSV), trim, cap at 80
    return raw.replace(/,/g, '').trim().substring(0, 80);
  }

  /* ─── Escape HTML ─── */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* ─── Load all saved accounts ─── */
  function loadAccounts() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (result) => {
        resolve(result[STORAGE_KEY] || {});
      });
    });
  }

  /* ─── Prompt user to pick an account (inline modal) ─── */
  function promptSelectAccount() {
    return new Promise(async (resolve) => {
      const accounts = await loadAccounts();
      const entries = Object.entries(accounts);

      // Remove existing prompt if any
      const existing = document.getElementById('ppay-account-prompt');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'ppay-account-prompt';
      overlay.className = 'ppay-overlay';

      if (entries.length === 0) {
        // No accounts saved — prompt to add one
        overlay.innerHTML = `
          <div class="ppay-modal">
            <div class="ppay-modal-icon">🏦</div>
            <h3 class="ppay-modal-title">No Accounts Configured</h3>
            <p class="ppay-modal-desc">Add a ledger and bank account number in the extension popup before exporting.</p>
            <p class="ppay-modal-desc ppay-modal-hint">Click the PositivePay icon in your toolbar → add a ledger name and account number.</p>
            <div class="ppay-modal-actions">
              <button id="ppay-account-cancel" class="ppay-btn ppay-btn-secondary">OK</button>
            </div>
          </div>
        `;
        document.body.appendChild(overlay);

        document.getElementById('ppay-account-cancel').addEventListener('click', () => {
          overlay.remove();
          resolve(null);
        });

        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) { overlay.remove(); resolve(null); }
        });
        return;
      }

      if (entries.length === 1) {
        // Only one account — use it automatically
        resolve({ ledger: entries[0][0], accountNumber: entries[0][1] });
        return;
      }

      // Multiple accounts — show picker
      const accountsHtml = entries.map(([ledger, num], i) => `
        <button class="ppay-account-option" data-index="${i}" data-ledger="${escapeHtml(ledger)}" data-account="${escapeHtml(num)}">
          <span class="ppay-account-option-name">${escapeHtml(ledger)}</span>
          <span class="ppay-account-option-num">••••${num.slice(-4)}</span>
        </button>
      `).join('');

      overlay.innerHTML = `
        <div class="ppay-modal">
          <div class="ppay-modal-icon">🏦</div>
          <h3 class="ppay-modal-title">Select Account</h3>
          <p class="ppay-modal-desc">Which ledger's bank account should be used for this export?</p>
          <div class="ppay-account-options">
            ${accountsHtml}
          </div>
          <div class="ppay-modal-actions">
            <button id="ppay-account-cancel" class="ppay-btn ppay-btn-secondary">Cancel</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      // Option click handlers
      overlay.querySelectorAll('.ppay-account-option').forEach(btn => {
        btn.addEventListener('click', () => {
          overlay.remove();
          resolve({
            ledger: btn.dataset.ledger,
            accountNumber: btn.dataset.account,
          });
        });
      });

      document.getElementById('ppay-account-cancel').addEventListener('click', () => {
        overlay.remove();
        resolve(null);
      });

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { overlay.remove(); resolve(null); }
      });
    });
  }

  /* ─── Find the check registry table ─── */
  function findRegistryTable() {
    // Strategy 1: Find a table whose headers contain check-related terms
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headers = table.querySelectorAll('th, thead td');
      const headerTexts = Array.from(headers).map(h => h.textContent.toLowerCase().trim());
      const checkKeywords = ['check', 'number', 'payee', 'amount', 'date', 'pay to', 'recipient'];
      const matches = checkKeywords.filter(kw => headerTexts.some(h => h.includes(kw)));
      if (matches.length >= 2) return table;
    }

    // Strategy 2: Look for a table with rows that contain dollar amounts and check numbers
    for (const table of tables) {
      const rows = table.querySelectorAll('tbody tr, tr');
      if (rows.length < 1) continue;
      const firstRow = rows[0];
      const cells = firstRow.querySelectorAll('td');
      if (cells.length >= 3) {
        const texts = Array.from(cells).map(c => c.textContent.trim());
        const hasAmount = texts.some(t => /\$[\d,]+\.?\d*/.test(t));
        const hasNumber = texts.some(t => /^\d{3,10}$/.test(t));
        if (hasAmount || hasNumber) return table;
      }
    }

    return null;
  }

  /* ─── Identify column indices from table headers ─── */
  function identifyColumns(table) {
    const headers = table.querySelectorAll('th, thead td');
    const cols = { checkNumber: -1, payee: -1, amount: -1, date: -1 };

    Array.from(headers).forEach((h, i) => {
      const text = h.textContent.toLowerCase().trim();
      if (text.includes('check') && text.includes('num') || text === 'number' || text === 'check #' || text === 'check no' || text === 'no.' || text === '#') {
        cols.checkNumber = i;
      } else if (text.includes('payee') || text.includes('pay to') || text.includes('recipient') || text.includes('name')) {
        cols.payee = i;
      } else if (text.includes('amount') || text.includes('total') || text.includes('sum')) {
        cols.amount = i;
      } else if (text.includes('date') || text.includes('issued') || text.includes('created')) {
        cols.date = i;
      }
    });

    return cols;
  }

  /* ─── Auto-detect columns by content patterns if header detection failed ─── */
  function autoDetectColumns(table) {
    const rows = table.querySelectorAll('tbody tr');
    if (rows.length === 0) return null;

    const cols = { checkNumber: -1, payee: -1, amount: -1, date: -1 };
    // Sample first few rows
    const sampleRows = Array.from(rows).slice(0, Math.min(5, rows.length));

    for (const row of sampleRows) {
      const cells = Array.from(row.querySelectorAll('td'));
      cells.forEach((cell, i) => {
        const text = cell.textContent.trim();
        // Check number: pure digits, 3-10 digits
        if (cols.checkNumber === -1 && /^\d{3,10}$/.test(text)) {
          cols.checkNumber = i;
        }
        // Amount: has $ or looks like money
        if (cols.amount === -1 && /^\$?[\d,]+\.\d{2}$/.test(text)) {
          cols.amount = i;
        }
        // Date: looks like a date
        if (cols.date === -1 && (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(text) ||
            /[A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4}/.test(text))) {
          cols.date = i;
        }
      });
    }

    // Payee: likely the longest text column that isn't date/amount/checkNumber
    const usedCols = new Set([cols.checkNumber, cols.amount, cols.date]);
    const sampleCells = Array.from(sampleRows[0]?.querySelectorAll('td') || []);
    let maxLen = 0;
    sampleCells.forEach((cell, i) => {
      if (!usedCols.has(i) && cell.textContent.trim().length > maxLen) {
        maxLen = cell.textContent.trim().length;
        cols.payee = i;
      }
    });

    return cols;
  }

  /* ─── Inject checkboxes into table rows ─── */
  function injectCheckboxes(table, cols) {
    // Add checkbox header
    const thead = table.querySelector('thead tr, tr:first-child');
    if (thead && !thead.querySelector('.ppay-th-checkbox')) {
      const th = document.createElement('th');
      th.className = 'ppay-th-checkbox';
      th.innerHTML = `
        <label class="ppay-checkbox-wrap ppay-select-all" title="Select all">
          <input type="checkbox" class="ppay-checkbox ppay-checkbox-all" />
          <span class="ppay-checkmark"></span>
        </label>`;
      thead.insertBefore(th, thead.firstChild);

      // Select-all handler
      th.querySelector('.ppay-checkbox-all').addEventListener('change', (e) => {
        const checked = e.target.checked;
        table.querySelectorAll('.ppay-row-checkbox').forEach(cb => {
          cb.checked = checked;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
    }

    // Add checkboxes to each data row
    const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
    rows.forEach((row, idx) => {
      if (row.querySelector('.ppay-td-checkbox')) return; // Already injected
      if (row.querySelectorAll('td').length < 3) return;  // Skip empty/header rows

      const td = document.createElement('td');
      td.className = 'ppay-td-checkbox';
      const rowId = `ppay-row-${idx}`;
      td.innerHTML = `
        <label class="ppay-checkbox-wrap">
          <input type="checkbox" class="ppay-row-checkbox" data-ppay-row="${rowId}" />
          <span class="ppay-checkmark"></span>
        </label>`;
      row.insertBefore(td, row.firstChild);

      // Checkbox handler
      td.querySelector('.ppay-row-checkbox').addEventListener('change', (e) => {
        const cells = Array.from(row.querySelectorAll('td:not(.ppay-td-checkbox)'));
        if (e.target.checked) {
          row.classList.add('ppay-row-selected');
          state.selectedChecks.set(rowId, {
            checkNumber: cols.checkNumber >= 0 ? cells[cols.checkNumber]?.textContent.trim() : '',
            payee: cols.payee >= 0 ? cells[cols.payee]?.textContent.trim() : '',
            amount: cols.amount >= 0 ? cells[cols.amount]?.textContent.trim() : '',
            date: cols.date >= 0 ? cells[cols.date]?.textContent.trim() : '',
          });
        } else {
          row.classList.remove('ppay-row-selected');
          state.selectedChecks.delete(rowId);
        }
        updateFloatingButton();
      });
    });
  }

  /* ─── Floating Export Button ─── */
  function createFloatingButton() {
    if (document.getElementById('ppay-float-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'ppay-float-btn';
    btn.className = 'ppay-float-btn ppay-hidden';
    btn.innerHTML = `
      <svg class="ppay-float-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      <span class="ppay-float-text">Export Positive Pay</span>
      <span class="ppay-float-badge" id="ppay-badge">0</span>
    `;
    document.body.appendChild(btn);

    btn.addEventListener('click', handleExport);
  }

  /* ─── Update floating button visibility & badge ─── */
  function updateFloatingButton() {
    const btn = document.getElementById('ppay-float-btn');
    const badge = document.getElementById('ppay-badge');
    if (!btn) return;

    const count = state.selectedChecks.size;
    if (count > 0) {
      btn.classList.remove('ppay-hidden');
      btn.classList.add('ppay-visible');
      badge.textContent = count;
    } else {
      btn.classList.remove('ppay-visible');
      btn.classList.add('ppay-hidden');
    }
  }

  /* ─── Generate & download CSV ─── */
  async function handleExport() {
    if (state.selectedChecks.size === 0) {
      showToast('No checks selected', 'error');
      return;
    }

    // Let user pick which account to use
    const selection = await promptSelectAccount();
    if (!selection) return; // User cancelled

    const accountNum = selection.accountNumber;

    // Build CSV lines
    const lines = [];
    for (const [, check] of state.selectedChecks) {
      const acct = accountNum;
      const checkNum = check.checkNumber.replace(/\D/g, ''); // digits only
      const amount = parseAmount(check.amount);
      const date = parseDate(check.date);
      const payee = sanitizePayee(check.payee);

      if (!checkNum) {
        showToast('Missing check number — skipping row', 'warning');
        continue;
      }
      if (!date) {
        showToast(`Invalid date for check #${checkNum}`, 'warning');
        continue;
      }

      // CSV format: AccountNumber,CheckNumber,Amount,Date,IssueIndicator,PayeeName
      lines.push(`${acct},${checkNum},${amount},${date},I,${payee}`);
    }

    if (lines.length === 0) {
      showToast('No valid checks to export', 'error');
      return;
    }

    // Create and download CSV
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    a.href = url;
    a.download = `positive_pay_${today}.csv`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`Exported ${lines.length} check${lines.length > 1 ? 's' : ''} to CSV`, 'success');
  }

  /* ─── Toast notifications ─── */
  function showToast(message, type = 'info') {
    // Remove existing
    const existing = document.getElementById('ppay-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'ppay-toast';
    toast.className = `ppay-toast ppay-toast-${type}`;

    const icons = {
      success: '✓',
      error: '✕',
      warning: '⚠',
      info: 'ℹ',
    };

    toast.innerHTML = `
      <span class="ppay-toast-icon">${icons[type] || icons.info}</span>
      <span class="ppay-toast-msg">${escapeHtml(message)}</span>
    `;
    document.body.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => toast.classList.add('ppay-toast-show'));

    // Auto-dismiss
    setTimeout(() => {
      toast.classList.remove('ppay-toast-show');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  /* ─── Initialize: find table and inject UI ─── */
  function initialize() {
    const table = findRegistryTable();
    if (!table) return false;
    if (table.dataset.ppayInitialized) return true;

    let cols = identifyColumns(table);
    // If header detection failed for most columns, try auto-detect
    const detectedCount = Object.values(cols).filter(v => v >= 0).length;
    if (detectedCount < 2) {
      const auto = autoDetectColumns(table);
      if (auto) cols = auto;
    }

    // Log detected columns for debugging
    console.log('[PositivePay] Detected columns:', cols);

    if (Object.values(cols).filter(v => v >= 0).length < 2) {
      console.warn('[PositivePay] Could not identify enough columns in the table');
      return false;
    }

    injectCheckboxes(table, cols);
    createFloatingButton();
    table.dataset.ppayInitialized = 'true';
    state.initialized = true;

    // Watch for table content changes (pagination, sorting, etc.)
    if (state.tableObserver) state.tableObserver.disconnect();
    state.tableObserver = new MutationObserver(() => {
      // Re-inject checkboxes if rows changed
      state.selectedChecks.clear();
      updateFloatingButton();
      injectCheckboxes(table, cols);
    });
    state.tableObserver.observe(table.querySelector('tbody') || table, {
      childList: true,
      subtree: true,
    });

    console.log('[PositivePay] Extension initialized on CheckKeeper registry');
    return true;
  }

  /* ─── Watch for SPA navigation / dynamic rendering ─── */
  function startObserver() {
    // Try immediately
    if (initialize()) return;

    // Poll periodically + mutation observer on body
    let attempts = 0;
    const maxAttempts = 60; // ~30 seconds
    const pollInterval = setInterval(() => {
      attempts++;
      if (initialize() || attempts >= maxAttempts) {
        clearInterval(pollInterval);
      }
    }, 500);

    // Also observe body for dynamic content
    state.bodyObserver = new MutationObserver(() => {
      if (!state.initialized) {
        initialize();
      }
    });
    state.bodyObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  /* ─── Listen for messages from popup ─── */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PPAY_GET_STATUS') {
      sendResponse({
        onCheckeeper: true,
        selectedCount: state.selectedChecks.size,
        initialized: state.initialized,
      });
    } else if (msg.type === 'PPAY_EXPORT') {
      handleExport();
      sendResponse({ ok: true });
    }
    return true; // async response
  });

  /* ─── Boot ─── */
  startObserver();
})();
