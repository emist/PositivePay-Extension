/**
 * PositivePay Popup Script
 * 
 * Manages extension popup: status display, account number per ledger,
 * export trigger, and account management.
 * 
 * Accounts are always manageable from the popup regardless of whether
 * we're connected to CheckKeeper or not.
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'ppay_accounts';

  /* ─── DOM refs ─── */
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const statusDetail = document.getElementById('status-detail');
  const exportSection = document.getElementById('export-section');
  const exportBtn = document.getElementById('export-btn');
  const exportBtnText = document.getElementById('export-btn-text');
  const ledgerInput = document.getElementById('ledger-input');
  const accountInput = document.getElementById('account-input');
  const addAccountBtn = document.getElementById('add-account-btn');
  const accountStatus = document.getElementById('account-status');
  const accountsList = document.getElementById('accounts-list');

  let currentTabId = null;

  const LOG_PREFIX = '[PositivePay Popup]';

  // DOM refs for detected ledger display
  const statusLedger = document.getElementById('status-ledger');
  const statusLedgerName = document.getElementById('status-ledger-name');

  /* ─── Mask account number for display ─── */
  function maskAccount(num) {
    if (!num || num.length <= 4) return num || '';
    return '•'.repeat(num.length - 4) + num.slice(-4);
  }

  /* ─── Check if we're on CheckKeeper ─── */
  async function checkStatus() {
    console.log(`${LOG_PREFIX} checkStatus() called`);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        console.log(`${LOG_PREFIX} No active tab found`);
        setInactive('No active tab');
        return;
      }

      currentTabId = tab.id;
      console.log(`${LOG_PREFIX} Active tab: id=${tab.id}, url=${tab.url || '(no url access)'}`);

      // The content script is only injected on checkeeper.com (via manifest matches).
      // If it responds, we know we're on CheckKeeper. If the message fails,
      // either we're not on CheckKeeper or the page needs a refresh.
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'PPAY_GET_STATUS' });
        console.log(`${LOG_PREFIX} Status response:`, response);

        if (response && response.onCheckeeper) {
          setActive(response);
        } else {
          console.log(`${LOG_PREFIX} Content script responded but not on CheckKeeper`);
          setInactive('Navigate to app.checkeeper.com to select checks');
        }
      } catch (err) {
        // Content script not reachable
        console.log(`${LOG_PREFIX} Content script unreachable:`, err.message);
        setInactive('Navigate to app.checkeeper.com to select checks');
        statusDetail.textContent = 'If already on CheckKeeper, try refreshing the page';
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} checkStatus error:`, err);
      setInactive('Unable to connect');
    }
  }

  /* ─── Set active status ─── */
  async function setActive(status) {
    console.log(`${LOG_PREFIX} setActive():`, status);
    statusDot.className = 'status-dot active';
    statusText.textContent = 'Connected to CheckKeeper';

    // Show detected ledger if available
    if (status.detectedLedger) {
      statusLedger.style.display = 'flex';
      statusLedgerName.textContent = status.detectedLedger;
      console.log(`${LOG_PREFIX} Detected ledger: "${status.detectedLedger}"`);
    } else {
      statusLedger.style.display = 'none';
      console.log(`${LOG_PREFIX} No ledger detected from page`);
    }

    if (status.selectedCount > 0) {
      statusDetail.textContent = `${status.selectedCount} check${status.selectedCount > 1 ? 's' : ''} selected`;
    } else {
      statusDetail.textContent = 'Select checks from the registry to export';
    }

    // Show export section
    exportSection.style.display = 'flex';
    if (status.selectedCount > 0) {
      exportBtn.disabled = false;
      exportBtnText.textContent = `Export ${status.selectedCount} Check${status.selectedCount > 1 ? 's' : ''} to CSV`;
    } else {
      exportBtn.disabled = true;
      exportBtnText.textContent = 'Export Positive Pay CSV';
    }
  }

  /* ─── Set inactive status ─── */
  function setInactive(msg) {
    console.log(`${LOG_PREFIX} setInactive(): ${msg}`);
    statusDot.className = 'status-dot inactive';
    statusText.textContent = 'Not Connected';
    statusDetail.textContent = msg;
    statusLedger.style.display = 'none';
    exportSection.style.display = 'none';
  }

  /* ─── Show account status message ─── */
  function showAccountStatus(msg, type) {
    accountStatus.textContent = msg;
    accountStatus.className = `account-status ${type}`;
    if (type !== 'error') {
      setTimeout(() => {
        accountStatus.textContent = '';
        accountStatus.className = 'account-status';
      }, 3000);
    }
  }

  /* ─── Load all accounts ─── */
  function loadAccounts() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (result) => {
        resolve(result[STORAGE_KEY] || {});
      });
    });
  }

  /* ─── Save account ─── */
  function saveAccount(ledger, accountNum) {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (result) => {
        const accounts = result[STORAGE_KEY] || {};
        accounts[ledger] = accountNum;
        chrome.storage.local.set({ [STORAGE_KEY]: accounts }, resolve);
      });
    });
  }

  /* ─── Delete account ─── */
  function deleteAccount(ledger) {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (result) => {
        const accounts = result[STORAGE_KEY] || {};
        delete accounts[ledger];
        chrome.storage.local.set({ [STORAGE_KEY]: accounts }, resolve);
      });
    });
  }

  /* ─── Render accounts list ─── */
  async function renderAccountsList() {
    const accounts = await loadAccounts();
    const entries = Object.entries(accounts);

    if (entries.length === 0) {
      accountsList.innerHTML = '<div class="accounts-empty">No accounts saved yet. Add a ledger and account above.</div>';
      return;
    }

    accountsList.innerHTML = entries.map(([ledger, num]) => `
      <div class="account-item" data-ledger="${escapeAttr(ledger)}">
        <div class="account-item-info">
          <span class="account-item-ledger">${escapeHtml(ledger)}</span>
          <span class="account-item-number">${maskAccount(num)}</span>
        </div>
        <div class="account-item-actions">
          <button class="account-item-edit" data-ledger="${escapeAttr(ledger)}" data-number="${escapeAttr(num)}" title="Edit">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
              <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button class="account-item-delete" data-ledger="${escapeAttr(ledger)}" title="Remove">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
              <path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    `).join('');

    // Attach edit handlers
    accountsList.querySelectorAll('.account-item-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        ledgerInput.value = btn.dataset.ledger;
        accountInput.value = btn.dataset.number;
        accountInput.type = 'text';
        ledgerInput.focus();
        showAccountStatus('Editing — modify and click Add to update', 'info');
      });
    });

    // Attach delete handlers
    accountsList.querySelectorAll('.account-item-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ledger = btn.dataset.ledger;
        await deleteAccount(ledger);
        renderAccountsList();
        showAccountStatus(`Removed "${ledger}"`, 'saved');
      });
    });
  }

  /* ─── Escape HTML ─── */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ─── Event Handlers ─── */

  // Add account
  addAccountBtn.addEventListener('click', async () => {
    const ledger = ledgerInput.value.trim();
    const account = accountInput.value.trim();

    if (!ledger) {
      showAccountStatus('Enter a ledger name', 'error');
      ledgerInput.focus();
      return;
    }
    if (!account) {
      showAccountStatus('Enter an account number', 'error');
      accountInput.focus();
      return;
    }

    await saveAccount(ledger, account);
    showAccountStatus(`Saved "${ledger}" ✓`, 'saved');

    // Clear inputs
    ledgerInput.value = '';
    accountInput.value = '';
    accountInput.type = 'text';

    // Refresh list
    renderAccountsList();

    // Notify content script if we're connected
    if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, {
        type: 'PPAY_UPDATE_ACCOUNT',
        accountNumber: account,
      }).catch(() => {});
    }
  });

  // Enter key to submit in either input
  ledgerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (accountInput.value.trim()) {
        addAccountBtn.click();
      } else {
        accountInput.focus();
      }
    }
  });

  accountInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addAccountBtn.click();
  });

  // Export button
  exportBtn.addEventListener('click', async () => {
    if (!currentTabId) return;
    try {
      await chrome.tabs.sendMessage(currentTabId, { type: 'PPAY_EXPORT' });
      exportBtnText.textContent = 'Exported!';
      setTimeout(() => window.close(), 1000);
    } catch (err) {
      exportBtnText.textContent = 'Export failed';
    }
  });

  /* ─── Init ─── */
  checkStatus();
  renderAccountsList(); // Always render accounts list on open
})();
