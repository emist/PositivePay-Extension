/**
 * Unit tests for PositivePay pure logic functions.
 *
 * These functions are duplicated from content.js and popup.js since
 * the source files are wrapped in IIFEs and aren't module-exportable.
 * The canonical source is always content.js / popup.js.
 *
 * Run: node --test tests/logic.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/* ─── Canonical copies of pure functions ─── */

function parseAmount(raw) {
  if (!raw) return '0.00';
  const cleaned = raw.replace(/[$,\s]/g, '');
  const num = parseFloat(cleaned);
  if (isNaN(num)) return '0.00';
  return num.toFixed(2);
}

function parseDate(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  if (isNaN(d.getTime())) {
    const m = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) return m[1].padStart(2, '0') + m[2].padStart(2, '0') + m[3];
    return '';
  }
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return mm + dd + yyyy;
}

function sanitizePayee(raw) {
  if (!raw) return '';
  return raw.replace(/,/g, '').trim().substring(0, 80);
}

function maskAccount(num) {
  if (!num || num.length <= 4) return num || '';
  return '•'.repeat(num.length - 4) + num.slice(-4);
}

/* ─── Tests ─── */

describe('parseAmount', () => {
  it('should handle null/undefined', () => {
    assert.equal(parseAmount(null), '0.00');
    assert.equal(parseAmount(undefined), '0.00');
    assert.equal(parseAmount(''), '0.00');
  });

  it('should parse plain numbers', () => {
    assert.equal(parseAmount('100'), '100.00');
    assert.equal(parseAmount('99.5'), '99.50');
    assert.equal(parseAmount('0.01'), '0.01');
  });

  it('should strip dollar signs and commas', () => {
    assert.equal(parseAmount('$1,234.56'), '1234.56');
    assert.equal(parseAmount('$ 100.00'), '100.00');
    assert.equal(parseAmount('$1,000,000.00'), '1000000.00');
  });

  it('should handle non-numeric strings', () => {
    assert.equal(parseAmount('abc'), '0.00');
    assert.equal(parseAmount('N/A'), '0.00');
  });

  it('should handle amounts with no decimals', () => {
    assert.equal(parseAmount('$500'), '500.00');
  });
});

describe('parseDate', () => {
  it('should handle null/undefined/empty', () => {
    assert.equal(parseDate(null), '');
    assert.equal(parseDate(undefined), '');
    assert.equal(parseDate(''), '');
  });

  it('should parse MM/DD/YYYY', () => {
    assert.equal(parseDate('04/24/2026'), '04242026');
    assert.equal(parseDate('1/5/2026'), '01052026');
  });

  it('should parse MM-DD-YYYY', () => {
    assert.equal(parseDate('04-24-2026'), '04242026');
  });

  it('should handle unparseable strings', () => {
    assert.equal(parseDate('not a date'), '');
    assert.equal(parseDate('xyz'), '');
  });
});

describe('sanitizePayee', () => {
  it('should handle null/undefined/empty', () => {
    assert.equal(sanitizePayee(null), '');
    assert.equal(sanitizePayee(undefined), '');
    assert.equal(sanitizePayee(''), '');
  });

  it('should strip commas', () => {
    assert.equal(sanitizePayee('Smith, John'), 'Smith John');
    assert.equal(sanitizePayee('A, B, C'), 'A B C');
  });

  it('should trim whitespace', () => {
    assert.equal(sanitizePayee('  John Doe  '), 'John Doe');
  });

  it('should cap at 80 characters', () => {
    const long = 'A'.repeat(100);
    assert.equal(sanitizePayee(long).length, 80);
  });

  it('should handle normal payee names', () => {
    assert.equal(sanitizePayee('Acme Corp'), 'Acme Corp');
  });
});

describe('maskAccount', () => {
  it('should handle null/undefined/empty', () => {
    assert.equal(maskAccount(null), '');
    assert.equal(maskAccount(undefined), '');
    assert.equal(maskAccount(''), '');
  });

  it('should return short numbers as-is', () => {
    assert.equal(maskAccount('1234'), '1234');
    assert.equal(maskAccount('12'), '12');
  });

  it('should mask all but last 4 digits', () => {
    assert.equal(maskAccount('123456789'), '•••••6789');
    assert.equal(maskAccount('12345'), '•2345');
  });
});
