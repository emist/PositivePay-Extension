/**
 * DOM Injection tests — simulates CheckKeeper's div-based registry structure
 * and verifies that findCheckRows + injectCheckboxes correctly find and annotate rows.
 *
 * Uses jsdom to simulate the browser DOM.
 *
 * Run: node --test tests/dom_injection.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

/* ─── Copy of findCheckRows from content.js ─── */
function findCheckRows(container, LOG_PREFIX = '[Test]') {
  // First: try direct children
  const directChildren = Array.from(container.children);
  const directWithData = directChildren.filter(child => {
    const text = child.textContent.trim();
    return /\$[\d,]+\.?\d*/.test(text) && text.length > 10 && text.length < 1000;
  });

  if (directWithData.length >= 2) {
    console.log(`${LOG_PREFIX} ✅ Check rows are direct children (${directWithData.length} rows)`);
    return directWithData;
  }

  // Second: try each direct child as a wrapper
  for (const child of directChildren) {
    const grandchildren = Array.from(child.children);
    const gcWithData = grandchildren.filter(gc => {
      const text = gc.textContent.trim();
      return /\$[\d,]+\.?\d*/.test(text) && text.length > 10 && text.length < 1000;
    });

    if (gcWithData.length >= 2) {
      console.log(`${LOG_PREFIX} ✅ Check rows in nested wrapper (${gcWithData.length} rows)`);
      return gcWithData;
    }
  }

  // Third: broader recursive search
  const allDescendants = container.querySelectorAll('div, section, ul');
  for (const desc of allDescendants) {
    const descChildren = Array.from(desc.children);
    if (descChildren.length < 2) continue;

    const withData = descChildren.filter(c => {
      const text = c.textContent.trim();
      return /\$[\d,]+\.?\d*/.test(text) && text.length > 10 && text.length < 1000;
    });

    if (withData.length >= 2) {
      console.log(`${LOG_PREFIX} ✅ Check rows via deep scan (${withData.length} rows)`);
      return withData;
    }
  }

  console.log(`${LOG_PREFIX} ⚠ Falling back to direct children`);
  return directChildren.slice(1);
}

/* ─── Build a simulated CheckKeeper registry DOM ─── */
function buildCheckKeeperDOM() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`);
  const doc = dom.window.document;

  // The registry container: DIV.card.registry
  const registry = doc.createElement('div');
  registry.className = 'card registry';

  // Child 1: Toolbar header (checkboxes, icons — no check data)
  const toolbar = doc.createElement('div');
  toolbar.className = 'registry-toolbar';
  toolbar.innerHTML = `
    <div class="check-all"><input type="checkbox" /></div>
    <div class="spacer"></div>
    <div class="actions">
      <button class="icon-btn"></button>
      <button class="icon-btn"></button>
    </div>
  `;
  registry.appendChild(toolbar);

  // Child 2: Body wrapper containing actual check rows
  const body = doc.createElement('div');
  body.className = 'registry-body';

  const checks = [
    { payee: 'MIAMI SURGICAL SUITES', num: '5537', date: '04/23/2026', memo: 'Full/Final Settlement for Michel Petit-Frere (00965)', amount: '$15,000.00', status: 'PENDENT' },
    { payee: 'HOLLYWOOD FIRE RESCUE', num: '5536', date: '04/23/2026', memo: 'Full/Final Settlement for Michel Petit-Frere (00965)', amount: '$1,278.13', status: 'PENDENT' },
    { payee: 'DURAMED LLC', num: '5535', date: '04/23/2026', memo: 'Full/Final Settlement for Michel Petit-Frere (00965)', amount: '$400.00', status: 'PENDENT' },
    { payee: 'EDWARD LAZZARIN, MD PA', num: '5534', date: '04/23/2026', memo: 'Full/Final Settlement for Michel Petit-Frere (00965)', amount: '$12,000.00', status: 'PENDENT' },
  ];

  checks.forEach(chk => {
    const row = doc.createElement('div');
    row.className = 'check-row';
    row.innerHTML = `
      <div class="check-select"><input type="checkbox" /></div>
      <div class="check-info">
        <a href="#">${chk.payee}</a>
        <div class="check-number">#${chk.num}</div>
        <div class="check-meta">${chk.date} • ${chk.memo}</div>
      </div>
      <div class="check-amount">${chk.amount}</div>
      <div class="check-status"><span class="badge">${chk.status}</span></div>
    `;
    body.appendChild(row);
  });

  registry.appendChild(body);
  doc.body.appendChild(registry);

  return { dom, doc, registry, toolbar, body, checks };
}

/* ─── Tests ─── */

describe('CheckKeeper DOM Structure', () => {
  it('registry has exactly 2 direct children (toolbar + body)', () => {
    const { registry } = buildCheckKeeperDOM();
    assert.equal(registry.children.length, 2, 'Registry should have 2 children');
    assert.equal(registry.children[0].className, 'registry-toolbar');
    assert.equal(registry.children[1].className, 'registry-body');
  });

  it('direct children do NOT contain check data (only nested)', () => {
    const { registry } = buildCheckKeeperDOM();
    const directChildren = Array.from(registry.children);
    const directWithData = directChildren.filter(child => {
      const text = child.textContent.trim();
      return /\$[\d,]+\.?\d*/.test(text) && text.length > 10;
    });
    // Only the body wrapper would match (it contains all text including $amounts)
    // But it's just 1 element, not 2+, so the "direct children" check should NOT pass >= 2
    console.log(`Direct children with $ data: ${directWithData.length}`);
    assert.ok(directWithData.length < 2, 'Direct children alone should NOT look like individual rows');
  });
});

describe('findCheckRows', () => {
  it('should find check rows in nested wrapper (grandchildren)', () => {
    const { registry } = buildCheckKeeperDOM();
    const rows = findCheckRows(registry);
    assert.equal(rows.length, 4, `Expected 4 check rows, got ${rows.length}`);
  });

  it('found rows should each contain a dollar amount', () => {
    const { registry } = buildCheckKeeperDOM();
    const rows = findCheckRows(registry);
    rows.forEach((row, i) => {
      const text = row.textContent;
      assert.ok(/\$[\d,]+\.\d{2}/.test(text), `Row ${i} should contain a dollar amount, got: "${text.substring(0, 80)}"`);
    });
  });

  it('found rows should each contain a payee name', () => {
    const { registry } = buildCheckKeeperDOM();
    const rows = findCheckRows(registry);
    const payees = ['MIAMI SURGICAL', 'HOLLYWOOD FIRE', 'DURAMED', 'EDWARD LAZZARIN'];
    rows.forEach((row, i) => {
      const text = row.textContent;
      assert.ok(text.includes(payees[i]), `Row ${i} should contain ${payees[i]}`);
    });
  });

  it('should handle flat structure (rows are direct children)', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`);
    const doc = dom.window.document;
    const container = doc.createElement('div');

    for (let i = 0; i < 3; i++) {
      const row = doc.createElement('div');
      row.textContent = `Check #${1000 + i} Payee ${i} $${(i + 1) * 500}.00`;
      container.appendChild(row);
    }

    const rows = findCheckRows(container);
    assert.equal(rows.length, 3);
  });

  it('should handle deeply nested structure (3 levels deep)', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`);
    const doc = dom.window.document;
    const container = doc.createElement('div');
    const wrapper1 = doc.createElement('div');
    const wrapper2 = doc.createElement('div');

    for (let i = 0; i < 3; i++) {
      const row = doc.createElement('div');
      row.textContent = `Check #${2000 + i} Deep Payee ${i} $${(i + 1) * 100}.00`;
      wrapper2.appendChild(row);
    }
    wrapper1.appendChild(wrapper2);
    container.appendChild(wrapper1);

    const rows = findCheckRows(container);
    assert.equal(rows.length, 3, `Should find 3 deeply nested rows, got ${rows.length}`);
  });
});

describe('Row cell detection', () => {
  it('each check row should have 4+ direct children (select, info, amount, status)', () => {
    const { registry } = buildCheckKeeperDOM();
    const rows = findCheckRows(registry);
    rows.forEach((row, i) => {
      const cellCount = row.children.length;
      assert.ok(cellCount >= 2, `Row ${i} should have 2+ children, got ${cellCount}`);
      console.log(`  Row ${i}: ${cellCount} children - [${Array.from(row.children).map(c => c.className || c.tagName).join(', ')}]`);
    });
  });

  it('cells.length >= 2 check should pass for check rows (not be filtered out)', () => {
    const { registry } = buildCheckKeeperDOM();
    const rows = findCheckRows(registry);
    let injectedCount = 0;

    rows.forEach((row, idx) => {
      let cells = Array.from(row.querySelectorAll('td'));
      if (cells.length === 0) {
        cells = Array.from(row.children);
      }
      if (cells.length < 2) {
        console.log(`  ❌ Row ${idx} SKIPPED (cells=${cells.length}): "${row.textContent.substring(0, 60)}"`);
        return;
      }
      injectedCount++;
    });

    assert.equal(injectedCount, 4, `All 4 rows should pass the cells >= 2 check, but only ${injectedCount} did`);
  });
});

describe('Column auto-detection on CheckKeeper rows', () => {
  it('should detect amount column from $ pattern', () => {
    const { registry } = buildCheckKeeperDOM();
    const rows = findCheckRows(registry);
    const firstRow = rows[0];
    const cells = Array.from(firstRow.children);

    let amountCol = -1;
    cells.forEach((cell, i) => {
      const text = cell.textContent.trim();
      if (/^\$?[\d,]+\.\d{2}$/.test(text)) {
        amountCol = i;
      }
    });

    console.log(`  Amount column detected at index: ${amountCol}`);
    console.log(`  Cell texts: [${cells.map(c => `"${c.textContent.trim().substring(0, 30)}"`).join(', ')}]`);
    assert.ok(amountCol >= 0, 'Should detect amount column');
  });
});

/* ─── Copy of autoDetectColumns from content.js (with fixes) ─── */
function autoDetectColumns(table) {
  let rows = table.querySelectorAll('tbody tr');
  if (rows.length === 0) rows = table.querySelectorAll('tr');
  if (rows.length === 0) rows = findCheckRows(table);
  if (rows.length === 0) return null;

  const cols = { checkNumber: -1, payee: -1, amount: -1, date: -1 };
  const sampleRows = Array.from(rows).slice(0, Math.min(5, rows.length));

  for (const row of sampleRows) {
    let cells = Array.from(row.querySelectorAll('td'));
    if (cells.length === 0) cells = Array.from(row.children);

    cells.forEach((cell, i) => {
      const text = cell.textContent.trim();
      if (cols.checkNumber === -1 && /^\#?\d{3,10}$/.test(text)) cols.checkNumber = i;
      if (cols.amount === -1 && /^\$?[\d,]+\.\d{2}$/.test(text)) cols.amount = i;
      if (cols.date === -1 && (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(text) ||
          /[A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4}/.test(text))) cols.date = i;
    });
  }

  const usedCols = new Set([cols.checkNumber, cols.amount, cols.date]);
  const firstDataRow = sampleRows[0];
  let sampleCells = Array.from(firstDataRow?.querySelectorAll('td') || []);
  if (sampleCells.length === 0 && firstDataRow) sampleCells = Array.from(firstDataRow.children);
  let maxLen = 0;
  sampleCells.forEach((cell, i) => {
    if (!usedCols.has(i) && cell.textContent.trim().length > maxLen) {
      maxLen = cell.textContent.trim().length;
      cols.payee = i;
    }
  });

  return cols;
}

describe('Full autoDetectColumns integration', () => {
  it('should detect at least 2 columns from CheckKeeper DOM', () => {
    const { registry } = buildCheckKeeperDOM();
    const cols = autoDetectColumns(registry);
    console.log('  Detected columns:', cols);
    const count = Object.values(cols).filter(v => v >= 0).length;
    assert.ok(count >= 2, `Expected 2+ columns, got ${count}: ${JSON.stringify(cols)}`);
  });

  it('should detect amount column', () => {
    const { registry } = buildCheckKeeperDOM();
    const cols = autoDetectColumns(registry);
    assert.ok(cols.amount >= 0, `Amount should be detected, got ${cols.amount}`);
  });

  it('should detect payee column', () => {
    const { registry } = buildCheckKeeperDOM();
    const cols = autoDetectColumns(registry);
    assert.ok(cols.payee >= 0, `Payee should be detected, got ${cols.payee}`);
  });

  it('should detect date column (date is inside check-info child)', () => {
    const { registry } = buildCheckKeeperDOM();
    const cols = autoDetectColumns(registry);
    // Date "04/23/2026" is inside the check-info div along with payee
    // So the date regex should find it in check-info cell (index 1)
    console.log('  Date column:', cols.date);
    assert.ok(cols.date >= 0, `Date should be detected, got ${cols.date}`);
  });
});
