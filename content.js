/**
 * PositivePay for CheckKeeper — Content Script
 * 
 * Injected into CheckKeeper (app.checkeeper.com) to:
 *   1. Detect the active ledger/business name
 *   2. Detect the check registry table
 *   3. Inject selection checkboxes into each row
 *   4. Provide a floating export button for Positive Pay CSV generation
 *   5. Let user pick which saved account to use when exporting
 */

(function () {
  'use strict';

  /* ─── State ─── */
  const state = {
    selectedChecks: new Map(),   // rowId → { checkNumber, payee, amount, date }
    initialized: false,
    detectedLedger: null,        // best-guess ledger/business name from the page
    lastDebugAnalysis: null,     // last debug analysis result for diagnostics
    tableObserver: null,
    bodyObserver: null,
  };

  /* ─── Constants ─── */
  const STORAGE_KEY = 'ppay_accounts';   // chrome.storage key for { ledgerName: accountNumber }
  const LOG_PREFIX = '[PositivePay]';

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

  /* ═══════════════════════════════════════════════════════════════
   *  LEDGER DETECTION & DEBUG ANALYSIS
   * ═══════════════════════════════════════════════════════════════ */

  /** Normalize a raw ledger name */
  function normalizeLedgerName(raw) {
    if (!raw) return '';
    return raw
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—]+/, '')
      .replace(/[\s\-–—]+$/, '')
      .trim();
  }

  /**
   * Extract just the business name from text that may include a tagline.
   * E.g. "PLLC Trust\nWe Help The Hurt" → "...PLLC Trust"
   * Handles newlines (separate DOM elements), then word-count qualifier logic.
   * Uses indexOf instead of regex to avoid template-literal escaping issues.
   */
  function extractBusinessName(raw) {
    if (!raw) return '';

    // Step 1: If the text has newlines, split and find the line with the legal suffix
    const suffixWords = ['pllc', 'llc', 'inc', 'corp', 'ltd', 'co', 'company', 'group',
      'associates', 'partners', 'firm', 'enterprises', 'services', 'solutions'];

    if (raw.includes('\n')) {
      const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      // Find the line containing a legal suffix
      const bizLine = lines.find(line => {
        const lower = line.toLowerCase();
        return suffixWords.some(s => {
          const idx = lower.indexOf(s);
          if (idx === -1) return false;
          const before = idx > 0 ? lower[idx - 1] : ' ';
          const after = lower[idx + s.length] || ' ';
          return (/[\s,]/.test(before) || idx === 0) && (/[\s,.]/.test(after) || (idx + s.length) === lower.length);
        });
      });
      if (bizLine) {
        return normalizeLedgerName(bizLine);
      }
      // No suffix line found, fall through to full-text processing
    }

    const text = normalizeLedgerName(raw);
    if (!text) return '';

    const suffixes = [
      'PLLC', 'P.L.L.C.', 'P.A.', 'P.A',
      'LLC', 'L.L.C.', 'L.L.C',
      'Inc.', 'Inc', 'Corp.', 'Corp', 'Ltd.', 'Ltd',
      'Co.', 'Co',
      'Company', 'Group', 'Associates', 'Partners', 'Firm',
      'Enterprises', 'Services', 'Solutions',
      'P.C.', 'P.C',
    ];

    // Find the LAST (rightmost) suffix occurrence using indexOf
    const textLower = text.toLowerCase();
    let bestEnd = -1;
    for (const suffix of suffixes) {
      const suffixLower = suffix.toLowerCase();
      let searchFrom = 0;
      while (true) {
        const idx = textLower.indexOf(suffixLower, searchFrom);
        if (idx === -1) break;
        const before = idx > 0 ? text[idx - 1] : ' ';
        const afterChar = text[idx + suffix.length] || ' ';
        const isWordBefore = /[\s,]/.test(before) || idx === 0;
        const isWordAfter = /[\s,.]/.test(afterChar) || (idx + suffix.length) === text.length;
        if (isWordBefore && isWordAfter) {
          let end = idx + suffix.length;
          if (text[end] === '.') end++;
          if (end > bestEnd) bestEnd = end;
        }
        searchFrom = idx + 1;
      }
    }

    // Decide: 1-3 words after suffix = qualifier (Trust, OLD TRUST) → keep
    //         4+ words after suffix  = tagline (We Help The Hurt) → strip
    if (bestEnd > 0 && bestEnd < text.length) {
      const afterSuffix = text.substring(bestEnd).trim();
      if (afterSuffix.length > 0) {
        const wordCount = afterSuffix.split(/\s+/).length;
        if (wordCount >= 4) {
          const extracted = text.substring(0, bestEnd).trim();
          if (extracted.length >= 3) return extracted;
        }
      }
    }

    return text;
  }

  /** Score a candidate ledger name: higher = more likely real business name */
  function scoreLedgerCandidate(text) {
    if (!text || typeof text !== 'string') return 0;
    const t = text.trim();
    if (t.length < 2 || t.length > 100) return 0;

    const genericTerms = [
      'checkeeper', 'dashboard', 'home', 'settings', 'profile', 'help',
      'logout', 'login', 'sign in', 'sign out', 'menu', 'navigation',
      'search', 'notifications', 'account', 'back', 'next', 'previous',
      'page', 'loading', 'welcome', 'check registry', 'registry',
      'checks', 'print', 'send', 'history', 'reports', 'contacts',
      'recipients', 'templates', 'billing', 'support', 'upgrade',
    ];
    if (genericTerms.includes(t.toLowerCase())) return 0;

    let score = 1;
    const bizSuffixes = ['llc', 'inc', 'corp', 'ltd', 'co', 'company', 'group', 'associates', 'partners', 'firm', 'enterprises', 'services', 'solutions', 'pllc', 'pa', 'pc'];
    if (bizSuffixes.some(s => t.toLowerCase().includes(s))) score += 5;
    const wordCount = t.split(/\s+/).length;
    if (wordCount >= 2) score += 2;
    if (wordCount >= 3) score += 1;
    if (/^[A-Z]/.test(t)) score += 1;
    if (t === t.toLowerCase()) score -= 1;
    if (/[\/\\:@]/.test(t)) return 0;
    if (t.length <= 4 && t === t.toUpperCase()) return 0;
    return Math.max(0, score);
  }

  /**
   * Comprehensive page analysis — dumps everything useful to console.
   * Returns a structured object for diagnostics.
   */
  function debugPageAnalysis() {
    const analysis = {
      timestamp: new Date().toISOString(),
      url: window.location.href,
      title: document.title,
      headings: [],
      navTexts: [],
      dropdownTexts: [],
      breadcrumbTexts: [],
      selectedDropdownValues: [],
      dataAttributes: [],
      candidates: [],
    };

    // 1. All headings
    document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(el => {
      const text = el.textContent.trim();
      if (text) {
        analysis.headings.push({
          tag: el.tagName.toLowerCase(),
          text,
          classes: el.className,
          id: el.id || null,
        });
      }
    });

    // 2. Nav / sidebar text
    document.querySelectorAll('nav, [role="navigation"], .sidebar, .nav, .sidenav, [class*="sidebar"], [class*="nav-"]').forEach(el => {
      const text = el.textContent.trim().substring(0, 200);
      if (text) analysis.navTexts.push(text);
    });

    // 3. Dropdowns / selects (business switcher likely here)
    document.querySelectorAll('select, [role="listbox"], [role="combobox"]').forEach(el => {
      const selected = el.value || el.textContent.trim().substring(0, 100);
      if (selected) analysis.selectedDropdownValues.push(selected);
    });

    // 4. Elements that look like a business switcher
    document.querySelectorAll('[class*="business"], [class*="company"], [class*="org"], [class*="tenant"], [class*="workspace"], [class*="ledger"], [class*="entity"], [class*="switcher"], [class*="brand"], [data-business], [data-company], [data-org], [data-ledger]').forEach(el => {
      const text = el.textContent.trim().substring(0, 100);
      if (text) {
        analysis.dropdownTexts.push({
          text,
          tag: el.tagName.toLowerCase(),
          classes: el.className,
          id: el.id || null,
        });
      }
      // Check data attributes
      for (const attr of el.attributes) {
        if (attr.name.startsWith('data-') && attr.value) {
          analysis.dataAttributes.push({ attr: attr.name, value: attr.value, element: el.tagName });
        }
      }
    });

    // 5. Breadcrumbs
    document.querySelectorAll('[class*="breadcrumb"], [aria-label*="breadcrumb"], .breadcrumbs, nav ol').forEach(el => {
      const text = el.textContent.trim().substring(0, 200);
      if (text) analysis.breadcrumbTexts.push(text);
    });

    // 6. Look for prominent text near the top of the page (likely business name)
    const topElements = document.querySelectorAll('header, [class*="header"], [class*="topbar"], [class*="top-bar"], [class*="appbar"], [class*="toolbar"]');
    topElements.forEach(el => {
      // Look for text that isn't in a button/link/input
      el.querySelectorAll('span, div, p, strong, b').forEach(child => {
        if (child.closest('button, a, input, select, textarea')) return;
        const text = child.textContent.trim();
        if (text && text.length > 2 && text.length < 80) {
          const normalized = normalizeLedgerName(text);
          const score = scoreLedgerCandidate(normalized);
          if (score > 0) {
            analysis.candidates.push({
              source: 'header-element',
              text: normalized,
              score,
              tag: child.tagName.toLowerCase(),
              classes: child.className,
            });
          }
        }
      });
    });

    // 7. Score all headings as candidates
    for (const h of analysis.headings) {
      const normalized = normalizeLedgerName(h.text);
      if (!normalized) continue;
      const score = scoreLedgerCandidate(normalized);
      if (score > 0) {
        analysis.candidates.push({ source: h.tag, text: normalized, score });
      }
    }

    // 8. Score dropdown/switcher texts
    for (const d of analysis.dropdownTexts) {
      const normalized = normalizeLedgerName(d.text);
      if (!normalized) continue;
      const score = scoreLedgerCandidate(normalized);
      if (score > 0) {
        analysis.candidates.push({ source: `switcher(${d.tag}.${d.classes})`, text: normalized, score: score + 3 }); // +3 bonus for being in a business-related element
      }
    }

    // 9. Score selected dropdown values
    for (const val of analysis.selectedDropdownValues) {
      const normalized = normalizeLedgerName(val);
      if (!normalized) continue;
      const score = scoreLedgerCandidate(normalized);
      if (score > 0) {
        analysis.candidates.push({ source: 'select-value', text: normalized, score: score + 2 }); // +2 bonus for being a selected value
      }
    }

    // Sort candidates by score descending
    analysis.candidates.sort((a, b) => b.score - a.score);

    // Log everything
    console.group(`${LOG_PREFIX} 🔍 Page Analysis`);
    console.log(`URL: ${analysis.url}`);
    console.log(`Title: ${analysis.title}`);
    console.log(`Headings (${analysis.headings.length}):`, analysis.headings);
    console.log(`Nav texts (${analysis.navTexts.length}):`, analysis.navTexts);
    console.log(`Dropdowns/switchers (${analysis.dropdownTexts.length}):`, analysis.dropdownTexts);
    console.log(`Selected values (${analysis.selectedDropdownValues.length}):`, analysis.selectedDropdownValues);
    console.log(`Breadcrumbs (${analysis.breadcrumbTexts.length}):`, analysis.breadcrumbTexts);
    console.log(`Data attributes (${analysis.dataAttributes.length}):`, analysis.dataAttributes);
    console.log('─── Candidates (ranked by score) ───');
    if (analysis.candidates.length === 0) {
      console.warn(`${LOG_PREFIX} ⚠ No ledger name candidates found`);
    } else {
      analysis.candidates.forEach((c, i) => {
        console.log(`  #${i + 1} [score=${c.score}] "${c.text}" (source: ${c.source})`);
      });
    }
    console.groupEnd();

    state.lastDebugAnalysis = analysis;
    return analysis;
  }

  /**
   * Detect the current ledger/business name from the page.
   * Returns the best candidate or null.
   */
  function detectLedger() {
    const analysis = debugPageAnalysis();

    // Special high-priority: .active-business element (CheckKeeper-specific)
    const activeBiz = document.querySelector('.active-business');
    if (activeBiz) {
      // Use full textContent — qualifiers like "Trust" may be in child spans
      const rawText = activeBiz.textContent.trim();
      const extracted = extractBusinessName(rawText);
      if (extracted && scoreLedgerCandidate(extracted) > 0) {
        console.log(`${LOG_PREFIX} ✅ Detected ledger from .active-business: "${extracted}" (raw: "${rawText}")`);
        state.detectedLedger = extracted;
        return extracted;
      }
    }

    if (analysis.candidates.length > 0) {
      const best = analysis.candidates[0];
      const extracted = extractBusinessName(best.text);
      console.log(`${LOG_PREFIX} ✅ Detected ledger: "${extracted}" (raw: "${best.text}", score=${best.score}, source=${best.source})`);
      state.detectedLedger = extracted;
      return extracted;
    }
    console.warn(`${LOG_PREFIX} ⚠ Could not detect ledger name — user will pick manually during export`);
    state.detectedLedger = null;
    return null;
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
        console.log(`${LOG_PREFIX} Auto-selecting only account: "${entries[0][0]}"`);
        resolve({ ledger: entries[0][0], accountNumber: entries[0][1] });
        return;
      }

      // Multiple accounts — try to auto-match by detected ledger
      if (state.detectedLedger) {
        const detected = state.detectedLedger.toLowerCase();
        console.log(`${LOG_PREFIX} Attempting auto-match for detected ledger: "${state.detectedLedger}"`);

        // Exact match (case-insensitive)
        const exactMatch = entries.find(([ledger]) => ledger.toLowerCase() === detected);
        if (exactMatch) {
          console.log(`${LOG_PREFIX} ✅ Exact match found: "${exactMatch[0]}"`);
          resolve({ ledger: exactMatch[0], accountNumber: exactMatch[1] });
          return;
        }

        // Partial match (detected contains saved name, or saved name contains detected)
        const partialMatch = entries.find(([ledger]) =>
          detected.includes(ledger.toLowerCase()) || ledger.toLowerCase().includes(detected)
        );
        if (partialMatch) {
          console.log(`${LOG_PREFIX} ✅ Partial match found: "${partialMatch[0]}" ↔ "${state.detectedLedger}"`);
          resolve({ ledger: partialMatch[0], accountNumber: partialMatch[1] });
          return;
        }

        console.log(`${LOG_PREFIX} ⚠ No match found for "${state.detectedLedger}" among saved accounts:`, entries.map(e => e[0]));
      } else {
        console.log(`${LOG_PREFIX} No detected ledger — showing account picker`);
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
    // Strategy 1: Find a <table> whose headers contain check-related terms
    const tables = document.querySelectorAll('table');
    console.log(`${LOG_PREFIX} 🔍 findRegistryTable: Found ${tables.length} <table> elements`);

    for (const table of tables) {
      const headers = table.querySelectorAll('th, thead td');
      const headerTexts = Array.from(headers).map(h => h.textContent.toLowerCase().trim());
      console.log(`${LOG_PREFIX}   Table headers: [${headerTexts.join(', ')}]`);
      const checkKeywords = ['check', 'number', 'payee', 'amount', 'date', 'pay to', 'recipient'];
      const matches = checkKeywords.filter(kw => headerTexts.some(h => h.includes(kw)));
      if (matches.length >= 2) {
        console.log(`${LOG_PREFIX}   ✅ Matched table by headers: [${matches.join(', ')}]`);
        return table;
      }
    }

    // Strategy 2: Look for a <table> with rows containing dollar amounts or check numbers
    for (const table of tables) {
      const rows = table.querySelectorAll('tbody tr, tr');
      if (rows.length < 1) continue;
      const firstRow = rows[0];
      const cells = firstRow.querySelectorAll('td');
      if (cells.length >= 3) {
        const texts = Array.from(cells).map(c => c.textContent.trim());
        console.log(`${LOG_PREFIX}   Table first-row cells: [${texts.join(', ')}]`);
        const hasAmount = texts.some(t => /\$[\d,]+\.?\d*/.test(t));
        const hasNumber = texts.some(t => /^\d{3,10}$/.test(t));
        if (hasAmount || hasNumber) {
          console.log(`${LOG_PREFIX}   ✅ Matched table by content: amount=${hasAmount}, number=${hasNumber}`);
          return table;
        }
      }
    }

    // Strategy 3: CheckKeeper may use div-based layouts instead of <table>
    // Look for repeating row-like structures with check data patterns
    const gridSelectors = [
      '[class*="registry"]', '[class*="check-list"]', '[class*="check_list"]',
      '[class*="checks"]', '[class*="ledger"]', '[class*="transaction"]',
      '[class*="table"]', '[class*="grid"]', '[class*="list-view"]',
      '[class*="data-table"]', '[class*="row-container"]',
      '[role="table"]', '[role="grid"]',
      '.table', '.grid', '.list',
    ];

    for (const selector of gridSelectors) {
      const candidates = document.querySelectorAll(selector);
      for (const container of candidates) {
        // Skip tiny containers
        if (container.children.length < 2) continue;

        // Look for child rows that contain check-like data
        const childTexts = Array.from(container.children).slice(0, 5).map(child => {
          return child.textContent.trim().substring(0, 200);
        });

        const hasCheckData = childTexts.some(t =>
          /\$[\d,]+\.?\d*/.test(t) || // dollar amount
          /\b\d{3,10}\b/.test(t) ||    // check number
          /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(t)  // date
        );

        if (hasCheckData) {
          console.log(`${LOG_PREFIX}   ✅ Found div-based table: ${selector} (${container.tagName}.${container.className})`);
          console.log(`${LOG_PREFIX}   Children: ${container.children.length}, Sample text: "${childTexts[0]?.substring(0, 80)}"`);
          return container;
        }
      }
    }

    // Strategy 4: Broad scan — any container with 3+ repeating children that have check data
    const allContainers = document.querySelectorAll('div, section, main, article');
    let scannedCount = 0;
    for (const container of allContainers) {
      // Only check elements with several child elements (likely rows)
      if (container.children.length < 3 || container.children.length > 200) continue;

      // Check if children have similar structure (like table rows)
      const firstChild = container.children[0];
      const secondChild = container.children[1];
      if (!firstChild || !secondChild) continue;

      // Both children should be the same tag type
      if (firstChild.tagName !== secondChild.tagName) continue;

      scannedCount++;
      // Check content patterns in first few children
      const sampleTexts = Array.from(container.children).slice(0, 5).map(c => c.textContent.trim());
      const checksFound = sampleTexts.filter(t =>
        (/\$[\d,]+\.?\d*/.test(t) || /\b\d{4,10}\b/.test(t)) &&
        t.length > 10 && t.length < 500
      ).length;

      if (checksFound >= 2) {
        console.log(`${LOG_PREFIX}   ✅ Found potential table (broad scan): ${container.tagName}.${container.className}`);
        console.log(`${LOG_PREFIX}   Children: ${container.children.length}, Checks found: ${checksFound}`);
        return container;
      }
    }
    console.log(`${LOG_PREFIX}   Broad scan checked ${scannedCount} containers, no match`);

    // Log page structure for debugging
    console.log(`${LOG_PREFIX} 📋 Page structure dump for debugging:`);
    const bodyChildren = Array.from(document.body.children).slice(0, 20);
    bodyChildren.forEach((el, i) => {
      const desc = `${el.tagName}${el.id ? '#' + el.id : ''}.${el.className.toString().substring(0, 50)}`;
      const childCount = el.children.length;
      const textSample = el.textContent.trim().substring(0, 80);
      console.log(`${LOG_PREFIX}   body>[${i}] ${desc} (${childCount} children) "${textSample}"`);
    });

    return null;
  }

  /* ─── Identify column indices from table headers ─── */
  function identifyColumns(table) {
    // Try standard table headers first
    let headers = table.querySelectorAll('th, thead td');

    // For div-based tables, try the first child's children as "headers"
    if (headers.length === 0) {
      const firstChild = table.children[0];
      if (firstChild) {
        headers = firstChild.children;
        console.log(`${LOG_PREFIX} Using div-based header detection (first child's ${headers.length} children)`);
      }
    }

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
    // Try standard table rows first, then div-based rows
    let rows = table.querySelectorAll('tbody tr');
    if (rows.length === 0) {
      rows = table.querySelectorAll('tr');
    }
    if (rows.length === 0) {
      // Div-based: use smart row finder (handles nested wrappers)
      rows = typeof findCheckRows === 'function' ? findCheckRows(table) : Array.from(table.children);
      console.log(`${LOG_PREFIX} Auto-detecting columns using div-based rows (${rows.length} rows found)`);
    }
    if (rows.length === 0) return null;

    const cols = { checkNumber: -1, payee: -1, amount: -1, date: -1 };
    // Sample first few rows
    // For div-based (findCheckRows), all rows are data — no header to skip
    // For HTML tables, first row might be header but we still detect patterns
    const sampleRows = Array.from(rows).slice(0, Math.min(5, rows.length));

    for (const row of sampleRows) {
      // Get cells: try td first, then direct children (for divs)
      let cells = Array.from(row.querySelectorAll('td'));
      if (cells.length === 0) {
        cells = Array.from(row.children);
      }

      cells.forEach((cell, i) => {
        const text = cell.textContent.trim();
        // Check number: digits with optional # prefix, 3-10 digits
        if (cols.checkNumber === -1 && /^\#?\d{3,10}$/.test(text)) {
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
    const firstDataRow = sampleRows[0];
    let sampleCells = Array.from(firstDataRow?.querySelectorAll('td') || []);
    if (sampleCells.length === 0 && firstDataRow) {
      sampleCells = Array.from(firstDataRow.children);
    }
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
  /**
   * SVG icons for toggle pills (inline to avoid external dependencies)
   */
  const PPAY_ICON_SHIELD = `<svg class="ppay-toggle-icon ppay-toggle-shield" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5l5.5 2v4.5c0 3.5-2.5 5.5-5.5 7-3-1.5-5.5-3.5-5.5-7V3.5L8 1.5z" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const PPAY_ICON_CHECK = `<svg class="ppay-toggle-icon ppay-toggle-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8.5l3 3 5-6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  /**
   * Find actual check row elements in a div-based table.
   * CheckKeeper nests rows inside wrappers, e.g.:
   *   DIV.card.registry > DIV (toolbar) + DIV (body) > DIV (check row) ...
   * This function finds the container whose children look like check rows
   * (i.e., they contain dollar amounts, check numbers, dates).
   */
  function findCheckRows(container) {
    // First: try direct children
    const directChildren = Array.from(container.children);
    const directWithData = directChildren.filter(child => {
      const text = child.textContent.trim();
      return /\$[\d,]+\.?\d*/.test(text) && text.length > 10 && text.length < 1000;
    });

    if (directWithData.length >= 2) {
      console.log(`${LOG_PREFIX} ✅ Check rows are direct children of table container (${directWithData.length} rows)`);
      return directWithData;
    }

    // Second: try each direct child as a wrapper — look for their children
    for (const child of directChildren) {
      const grandchildren = Array.from(child.children);
      const gcWithData = grandchildren.filter(gc => {
        const text = gc.textContent.trim();
        return /\$[\d,]+\.?\d*/.test(text) && text.length > 10 && text.length < 1000;
      });

      if (gcWithData.length >= 2) {
        console.log(`${LOG_PREFIX} ✅ Check rows found in nested wrapper: ${child.tagName}.${child.className.toString().substring(0, 40)} (${gcWithData.length} rows)`);
        return gcWithData;
      }
    }

    // Third: broader recursive search — find any descendant container with 2+ check-data children
    const allDescendants = container.querySelectorAll('div, section, ul');
    for (const desc of allDescendants) {
      const descChildren = Array.from(desc.children);
      if (descChildren.length < 2) continue;

      const withData = descChildren.filter(c => {
        const text = c.textContent.trim();
        return /\$[\d,]+\.?\d*/.test(text) && text.length > 10 && text.length < 1000;
      });

      if (withData.length >= 2) {
        console.log(`${LOG_PREFIX} ✅ Check rows found via deep scan: ${desc.tagName}.${desc.className.toString().substring(0, 40)} (${withData.length} rows)`);
        return withData;
      }
    }

    // Fallback: return direct children minus first (original behavior)
    console.log(`${LOG_PREFIX} ⚠ Could not find check rows — falling back to direct children`);
    return directChildren.slice(1);
  }

  function injectCheckboxes(table, cols) {
    const isHtmlTable = table.tagName === 'TABLE';

    // Add "Select All" toggle in a header area
    let headerRow;
    if (isHtmlTable) {
      headerRow = table.querySelector('thead tr, tr:first-child');
    } else {
      headerRow = table.children[0];
    }

    if (headerRow && !headerRow.querySelector('.ppay-th-toggle')) {
      const th = document.createElement(isHtmlTable ? 'th' : 'div');
      th.className = 'ppay-th-toggle';
      const toggle = document.createElement('span');
      toggle.className = 'ppay-toggle ppay-select-all';
      toggle.setAttribute('role', 'button');
      toggle.setAttribute('tabindex', '0');
      toggle.setAttribute('title', 'Select all for Positive Pay export');
      toggle.innerHTML = `${PPAY_ICON_SHIELD}${PPAY_ICON_CHECK}<span>ALL</span>`;
      th.appendChild(toggle);
      headerRow.appendChild(th);

      // Select-all handler
      toggle.addEventListener('click', () => {
        const isSelected = toggle.classList.contains('ppay-selected');
        if (isSelected) {
          // Deselect all
          toggle.classList.remove('ppay-selected');
          table.querySelectorAll('.ppay-toggle[data-ppay-row]').forEach(t => {
            if (t.classList.contains('ppay-selected')) {
              t.click();
            }
          });
        } else {
          // Select all
          toggle.classList.add('ppay-selected');
          table.querySelectorAll('.ppay-toggle[data-ppay-row]').forEach(t => {
            if (!t.classList.contains('ppay-selected')) {
              t.click();
            }
          });
        }
      });
    }

    // Add toggle pills to each data row
    let rows;
    if (isHtmlTable) {
      rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
    } else {
      // For div-based: find actual check rows (may be nested deeper)
      // Look for elements that contain dollar amounts or check numbers
      rows = findCheckRows(table);
      console.log(`${LOG_PREFIX} 🔍 Found ${rows.length} check rows for toggle injection`);
    }

    Array.from(rows).forEach((row, idx) => {
      if (row.querySelector('.ppay-td-toggle')) return; // Already injected

      // Get cells: try td, then direct children
      let cells = Array.from(row.querySelectorAll('td'));
      if (cells.length === 0) {
        cells = Array.from(row.children);
      }
      if (cells.length < 2) return; // Skip empty/sparse rows

      const td = document.createElement(isHtmlTable ? 'td' : 'div');
      td.className = 'ppay-td-toggle';

      const rowId = `ppay-row-${idx}`;
      const toggle = document.createElement('span');
      toggle.className = 'ppay-toggle';
      toggle.setAttribute('role', 'button');
      toggle.setAttribute('tabindex', '0');
      toggle.setAttribute('data-ppay-row', rowId);
      toggle.setAttribute('title', 'Select for Positive Pay export');
      toggle.innerHTML = `${PPAY_ICON_SHIELD}${PPAY_ICON_CHECK}<span>PP</span>`;
      td.appendChild(toggle);
      row.appendChild(td);

      // Toggle handler
      toggle.addEventListener('click', (e) => {
        e.stopPropagation(); // Don't trigger CheckKeeper's row click

        // Re-query cells excluding our injected toggle cell
        let dataCells = Array.from(row.querySelectorAll('td:not(.ppay-td-toggle)'));
        if (dataCells.length === 0) {
          dataCells = Array.from(row.children).filter(c => !c.classList.contains('ppay-td-toggle'));
        }

         if (toggle.classList.contains('ppay-selected')) {
          // Deselect
          toggle.classList.remove('ppay-selected');
          row.classList.remove('ppay-row-selected');
          state.selectedChecks.delete(rowId);
        } else {
          // Select — extract check data from the row
          toggle.classList.add('ppay-selected');
          row.classList.add('ppay-row-selected');

          // Try column-index extraction first; fall back to pattern-based
          let checkNumber = cols.checkNumber >= 0 ? dataCells[cols.checkNumber]?.textContent.trim() : '';
          let payee = cols.payee >= 0 ? dataCells[cols.payee]?.textContent.trim() : '';
          let amount = cols.amount >= 0 ? dataCells[cols.amount]?.textContent.trim() : '';
          let date = cols.date >= 0 ? dataCells[cols.date]?.textContent.trim() : '';

          // Pattern-based fallback for missing fields
          const rowText = row.textContent;

          if (!checkNumber) {
            // Look for #NNNNN or standalone 3-10 digit numbers
            const numMatch = rowText.match(/#(\d{3,10})/);
            if (numMatch) checkNumber = numMatch[1];
          }
          if (!amount) {
            // Look for $X,XXX.XX pattern
            const amtMatch = rowText.match(/\$[\d,]+\.\d{2}/);
            if (amtMatch) amount = amtMatch[0];
          }
          if (!date) {
            // Look for MM/DD/YYYY or MM-DD-YYYY
            const dateMatch = rowText.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/);
            if (dateMatch) date = dateMatch[0];
          }
          if (!payee) {
            // Use the first link text in the row as payee (CheckKeeper links payee names)
            const payeeLink = row.querySelector('a');
            if (payeeLink) {
              payee = payeeLink.textContent.trim();
            } else {
              // Fall back to longest text segment
              const texts = Array.from(row.querySelectorAll('*')).map(el => el.textContent.trim())
                .filter(t => t.length > 3 && !/^\$/.test(t) && !/^\d+$/.test(t) && !/^\d{1,2}\//.test(t));
              if (texts.length > 0) payee = texts.reduce((a, b) => a.length > b.length ? a : b);
            }
          }

          console.log(`${LOG_PREFIX} Selected row ${idx}: #${checkNumber} | ${payee} | ${amount} | ${date}`);

          state.selectedChecks.set(rowId, { checkNumber, payee, amount, date });
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

      // CSV format: "AccountNumber","CheckNumber","Amount","Date","IssueIndicator","PayeeName"
      // Fields are double-quoted for Centrix/ExactTMS ParseLineDelimited compatibility
      const q = '"';
      lines.push(q+acct+q+','+q+checkNum+q+','+q+amount+q+','+q+date+q+','+q+'I'+q+','+q+payee+q);
    }

    if (lines.length === 0) {
      showToast('No valid checks to export', 'error');
      return;
    }

    // Create and download CSV (use \r\n for Windows/bank system compatibility)
    const csv = lines.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
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
    console.log(`${LOG_PREFIX} 🚀 initialize() called — scanning page...`);

    // Always run ledger detection (even before table is found)
    detectLedger();

    const table = findRegistryTable();
    if (!table) {
      console.log(`${LOG_PREFIX} ⏳ No check registry table found yet`);
      return false;
    }
    if (table.dataset.ppayInitialized) {
      console.log(`${LOG_PREFIX} ✓ Table already initialized`);
      return true;
    }

    // Column detection — used for CSV export, NOT for toggle injection
    // Toggle pills are injected regardless of column detection success
    let cols = identifyColumns(table);
    const detectedCount = Object.values(cols).filter(v => v >= 0).length;
    console.log(`${LOG_PREFIX} Column detection (headers): ${detectedCount}/4 found`, cols);

    if (detectedCount < 2) {
      console.log(`${LOG_PREFIX} Falling back to auto-detect by content patterns...`);
      const auto = autoDetectColumns(table);
      if (auto) {
        cols = auto;
        const autoCount = Object.values(cols).filter(v => v >= 0).length;
        console.log(`${LOG_PREFIX} Auto-detect found ${autoCount}/4 columns`, cols);
      }
    }

    const finalCount = Object.values(cols).filter(v => v >= 0).length;
    if (finalCount < 2) {
      console.warn(`${LOG_PREFIX} ⚠ Column detection limited (${finalCount}/4) — toggle pills will still inject, but export may need manual mapping`);
    }

    // Inject toggle pills into every check row — this does NOT require column detection
    console.log(`${LOG_PREFIX} ✅ Injecting toggle pills into registry...`);
    injectCheckboxes(table, cols);
    createFloatingButton();
    table.dataset.ppayInitialized = 'true';
    state.initialized = true;

    // Watch for table content changes (pagination, sorting, etc.)
    if (state.tableObserver) state.tableObserver.disconnect();
    state.tableObserver = new MutationObserver(() => {
      state.selectedChecks.clear();
      updateFloatingButton();
      injectCheckboxes(table, cols);
      // Re-detect ledger on table changes (might indicate SPA navigation)
      detectLedger();
    });
    state.tableObserver.observe(table.querySelector('tbody') || table, {
      childList: true,
      subtree: true,
    });

    console.log(`${LOG_PREFIX} ✅ Extension initialized on CheckKeeper registry (ledger: ${state.detectedLedger || 'unknown'})`);
    return true;
  }

  /* ─── Watch for SPA navigation / dynamic rendering ─── */
  function startObserver() {
    console.log(`${LOG_PREFIX} 🔄 startObserver() — watching for CheckKeeper registry...`);

    // Try immediately
    if (initialize()) return;

    // Poll periodically + mutation observer on body
    let attempts = 0;
    const maxAttempts = 60; // ~30 seconds
    const pollInterval = setInterval(() => {
      attempts++;
      if (attempts % 10 === 0) {
        console.log(`${LOG_PREFIX} ⏳ Still waiting for registry table... (attempt ${attempts}/${maxAttempts})`);
      }
      if (initialize() || attempts >= maxAttempts) {
        clearInterval(pollInterval);
        if (attempts >= maxAttempts && !state.initialized) {
          console.warn(`${LOG_PREFIX} ⚠ Gave up waiting for registry table after ${maxAttempts * 0.5}s`);
          // Still run page analysis so debug info is available
          debugPageAnalysis();
        }
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
    console.log(`${LOG_PREFIX} 📩 Message received:`, msg.type);

    if (msg.type === 'PPAY_GET_STATUS') {
      // Re-detect ledger fresh (user may have switched ledgers in this SPA)
      const previousLedger = state.detectedLedger;
      const activeBizEl = document.querySelector('.active-business');
      const rawActiveBizText = activeBizEl ? activeBizEl.textContent.trim() : '(no .active-business found)';
      console.log(`${LOG_PREFIX} 🔄 Re-detecting ledger... (was: "${previousLedger}")`);
      console.log(`${LOG_PREFIX} 🔄 Current .active-business text: "${rawActiveBizText}"`);
      detectLedger();
      console.log(`${LOG_PREFIX} 🔄 Fresh detection result: "${state.detectedLedger}"`);
      if (previousLedger !== state.detectedLedger) {
        console.log(`${LOG_PREFIX} ✅ Ledger CHANGED: "${previousLedger}" → "${state.detectedLedger}"`);
      }
      const status = {
        onCheckeeper: true,
        selectedCount: state.selectedChecks.size,
        initialized: state.initialized,
        detectedLedger: state.detectedLedger,
      };
      console.log(`${LOG_PREFIX} 📤 Sending status:`, status);
      sendResponse(status);
    } else if (msg.type === 'PPAY_EXPORT') {
      handleExport();
      sendResponse({ ok: true });
    } else if (msg.type === 'PPAY_DEBUG') {
      // Run a fresh page analysis and return it
      const analysis = debugPageAnalysis();
      sendResponse({
        analysis,
        state: {
          initialized: state.initialized,
          detectedLedger: state.detectedLedger,
          selectedCount: state.selectedChecks.size,
        },
      });
    }
    return true; // async response
  });

  /* ─── Boot ─── */
  console.log(`${LOG_PREFIX} 🟢 Content script loaded on ${window.location.href}`);
  startObserver();
})();
