/**
 * Unit tests for ledger detection and debug analysis logic.
 *
 * Run: node --test tests/ledger_detection.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/* ─── Canonical copies of functions under test ─── */

/**
 * Normalize a raw ledger name: trim whitespace, collapse internal whitespace,
 * remove trailing/leading dashes, etc.
 */
function normalizeLedgerName(raw) {
  if (!raw) return '';
  return raw
    .replace(/\s+/g, ' ')       // collapse whitespace
    .replace(/^[\s\-–—]+/, '')  // strip leading dashes/whitespace
    .replace(/[\s\-–—]+$/, '')  // strip trailing dashes/whitespace
    .trim();
}

/**
 * Score a candidate ledger name: higher = more likely to be a real business name.
 * Returns 0 if the candidate is obviously wrong.
 */
function scoreLedgerCandidate(text) {
  if (!text || typeof text !== 'string') return 0;
  const t = text.trim();

  // Too short or too long
  if (t.length < 2 || t.length > 100) return 0;

  // Generic terms that are NOT ledger names
  const genericTerms = [
    'checkeeper', 'dashboard', 'home', 'settings', 'profile', 'help',
    'logout', 'login', 'sign in', 'sign out', 'menu', 'navigation',
    'search', 'notifications', 'account', 'back', 'next', 'previous',
    'page', 'loading', 'welcome', 'check registry', 'registry',
  ];
  if (genericTerms.includes(t.toLowerCase())) return 0;

  let score = 1;

  // Bonus: contains common business suffixes
  const bizSuffixes = ['llc', 'inc', 'corp', 'ltd', 'co', 'company', 'group', 'associates', 'partners', 'firm', 'enterprises', 'services', 'solutions'];
  if (bizSuffixes.some(s => t.toLowerCase().includes(s))) score += 5;

  // Bonus: multiple words (real names tend to be multi-word)
  const wordCount = t.split(/\s+/).length;
  if (wordCount >= 2) score += 2;
  if (wordCount >= 3) score += 1;

  // Bonus: starts with uppercase (proper noun)
  if (/^[A-Z]/.test(t)) score += 1;

  // Penalty: all lowercase
  if (t === t.toLowerCase()) score -= 1;

  // Penalty: looks like a URL or path
  if (/[\/\\:@]/.test(t)) return 0;

  // Penalty: looks like a button label (very short, all caps)
  if (t.length <= 4 && t === t.toUpperCase()) return 0;

  return Math.max(0, score);
}

/**
 * Build a structured page analysis object from raw DOM data.
 * This is the pure-logic portion of debugPageAnalysis().
 */
function buildPageAnalysis(data) {
  const analysis = {
    url: data.url || '',
    title: data.title || '',
    headings: data.headings || [],
    navTexts: data.navTexts || [],
    candidates: [],
  };

  // Score all headings as candidates
  for (const h of analysis.headings) {
    const normalized = normalizeLedgerName(h.text);
    if (!normalized) continue;
    const score = scoreLedgerCandidate(normalized);
    if (score > 0) {
      analysis.candidates.push({ source: `${h.tag}`, text: normalized, score });
    }
  }

  // Score nav texts
  for (const text of analysis.navTexts) {
    const normalized = normalizeLedgerName(text);
    if (!normalized) continue;
    const score = scoreLedgerCandidate(normalized);
    if (score > 0) {
      analysis.candidates.push({ source: 'nav', text: normalized, score });
    }
  }

  // Sort by score descending
  analysis.candidates.sort((a, b) => b.score - a.score);

  return analysis;
}

/* ─── Tests ─── */

describe('normalizeLedgerName', () => {
  it('should handle null/undefined/empty', () => {
    assert.equal(normalizeLedgerName(null), '');
    assert.equal(normalizeLedgerName(undefined), '');
    assert.equal(normalizeLedgerName(''), '');
  });

  it('should trim whitespace', () => {
    assert.equal(normalizeLedgerName('  Acme Corp  '), 'Acme Corp');
  });

  it('should collapse internal whitespace', () => {
    assert.equal(normalizeLedgerName('Acme   Corp   LLC'), 'Acme Corp LLC');
  });

  it('should strip leading/trailing dashes', () => {
    assert.equal(normalizeLedgerName('— Acme Corp —'), 'Acme Corp');
    assert.equal(normalizeLedgerName('- Business Name -'), 'Business Name');
  });

  it('should handle newlines and tabs', () => {
    assert.equal(normalizeLedgerName('Acme\n  Corp'), 'Acme Corp');
  });
});

describe('scoreLedgerCandidate', () => {
  it('should return 0 for null/empty/undefined', () => {
    assert.equal(scoreLedgerCandidate(null), 0);
    assert.equal(scoreLedgerCandidate(undefined), 0);
    assert.equal(scoreLedgerCandidate(''), 0);
  });

  it('should return 0 for generic terms', () => {
    assert.equal(scoreLedgerCandidate('Checkeeper'), 0);
    assert.equal(scoreLedgerCandidate('Dashboard'), 0);
    assert.equal(scoreLedgerCandidate('Settings'), 0);
    assert.equal(scoreLedgerCandidate('Check Registry'), 0);
  });

  it('should score real business names highly', () => {
    const score = scoreLedgerCandidate('Hernandez Law Firm LLC');
    assert.ok(score >= 5, `Expected score >= 5, got ${score}`);
  });

  it('should score multi-word names higher than single words', () => {
    const single = scoreLedgerCandidate('Widget');
    const multi = scoreLedgerCandidate('Widget Factory');
    assert.ok(multi > single, `Multi-word (${multi}) should be > single-word (${single})`);
  });

  it('should return 0 for URLs/paths', () => {
    assert.equal(scoreLedgerCandidate('https://example.com'), 0);
    assert.equal(scoreLedgerCandidate('/dashboard/home'), 0);
  });

  it('should return 0 for very short all-caps labels', () => {
    assert.equal(scoreLedgerCandidate('OK'), 0);
    assert.equal(scoreLedgerCandidate('GO'), 0);
  });

  it('should return 0 for too-short strings', () => {
    assert.equal(scoreLedgerCandidate('A'), 0);
  });

  it('should give bonus to proper nouns', () => {
    const upper = scoreLedgerCandidate('Acme');
    const lower = scoreLedgerCandidate('acme');
    assert.ok(upper > lower, `Uppercase (${upper}) should be > lowercase (${lower})`);
  });
});

describe('buildPageAnalysis', () => {
  it('should handle empty data', () => {
    const result = buildPageAnalysis({});
    assert.deepEqual(result.candidates, []);
    assert.equal(result.url, '');
    assert.equal(result.title, '');
  });

  it('should score headings and rank by score', () => {
    const result = buildPageAnalysis({
      url: 'https://app.checkeeper.com',
      title: 'Checkeeper',
      headings: [
        { tag: 'h1', text: 'Checkeeper' },        // generic → score 0
        { tag: 'h2', text: 'Hernandez Law LLC' },  // business name → high score
        { tag: 'h3', text: 'Check Registry' },     // generic → score 0
      ],
      navTexts: ['Dashboard', 'Settings', 'MyBiz Inc'],
    });

    // "Hernandez Law LLC" should be the top candidate
    assert.ok(result.candidates.length >= 1, 'Should have at least 1 candidate');
    assert.equal(result.candidates[0].text, 'Hernandez Law LLC');

    // Generic terms should be filtered out
    const genericCandidates = result.candidates.filter(c =>
      ['Checkeeper', 'Check Registry', 'Dashboard', 'Settings'].includes(c.text)
    );
    assert.equal(genericCandidates.length, 0, 'Generic terms should be excluded');
  });

  it('should include nav text candidates', () => {
    const result = buildPageAnalysis({
      headings: [],
      navTexts: ['Smith Associates Group'],
    });

    assert.ok(result.candidates.length >= 1);
    assert.equal(result.candidates[0].text, 'Smith Associates Group');
    assert.equal(result.candidates[0].source, 'nav');
  });
});

/* ─── Auto-match logic (mirrors promptSelectAccount in content.js) ─── */

/**
 * Match a detected ledger name against saved account entries.
 * Returns the matched [ledger, accountNumber] pair or null.
 */
function matchLedgerToAccount(detectedLedger, entries) {
  if (!detectedLedger || !entries || entries.length === 0) return null;
  const detected = detectedLedger.toLowerCase();

  // Exact match (case-insensitive)
  const exact = entries.find(([ledger]) => ledger.toLowerCase() === detected);
  if (exact) return { ledger: exact[0], accountNumber: exact[1], matchType: 'exact' };

  // Partial match
  const partial = entries.find(([ledger]) =>
    detected.includes(ledger.toLowerCase()) || ledger.toLowerCase().includes(detected)
  );
  if (partial) return { ledger: partial[0], accountNumber: partial[1], matchType: 'partial' };

  return null;
}

describe('matchLedgerToAccount', () => {
  const accounts = [
    ['Hernandez Law PLLC', '123456789'],
    ['Smith Consulting LLC', '987654321'],
    ['Joe\'s Plumbing', '555555555'],
  ];

  it('should return null for empty inputs', () => {
    assert.equal(matchLedgerToAccount(null, accounts), null);
    assert.equal(matchLedgerToAccount('', accounts), null);
    assert.equal(matchLedgerToAccount('Test', []), null);
    assert.equal(matchLedgerToAccount('Test', null), null);
  });

  it('should exact match (case-insensitive)', () => {
    const result = matchLedgerToAccount('Hernandez Law PLLC', accounts);
    assert.equal(result.ledger, 'Hernandez Law PLLC');
    assert.equal(result.accountNumber, '123456789');
    assert.equal(result.matchType, 'exact');
  });

  it('should exact match regardless of case', () => {
    const result = matchLedgerToAccount('hernandez law pllc', accounts);
    assert.equal(result.ledger, 'Hernandez Law PLLC');
    assert.equal(result.matchType, 'exact');
  });

  it('should partial match when detected name contains saved name', () => {
    // E.g., page shows "Hernandez Law PLLC - Check Registry" but saved as "Hernandez Law PLLC"
    const result = matchLedgerToAccount('Hernandez Law PLLC - Check Registry', accounts);
    assert.ok(result !== null, 'Should find a partial match');
    assert.equal(result.ledger, 'Hernandez Law PLLC');
    assert.equal(result.matchType, 'partial');
  });

  it('should partial match when saved name contains detected name', () => {
    // E.g., page only shows "Hernandez Law" but saved as "Hernandez Law PLLC"
    const result = matchLedgerToAccount('Hernandez Law', accounts);
    assert.ok(result !== null, 'Should find a partial match');
    assert.equal(result.ledger, 'Hernandez Law PLLC');
    assert.equal(result.matchType, 'partial');
  });

  it('should return null when no match exists', () => {
    const result = matchLedgerToAccount('Totally Different Business', accounts);
    assert.equal(result, null);
  });
});
