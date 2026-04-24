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
 * Extract just the business name from a string that may include a tagline.
 * E.g. "Cornish Hernandez Gonzalez, PLLC We Help The Hurt" → "Cornish Hernandez Gonzalez, PLLC"
 * But keeps qualifiers: "PLLC Trust" stays as-is (1-3 words after suffix = qualifier)
 *
 * Uses indexOf-based matching (no regex word boundaries) to avoid
 * template-literal escaping issues.
 */
function extractBusinessName(raw) {
  if (!raw) return '';

  // Step 1: If the text has newlines, split and find the line with the legal suffix
  const suffixWords = ['pllc', 'llc', 'inc', 'corp', 'ltd', 'co', 'company', 'group',
    'associates', 'partners', 'firm', 'enterprises', 'services', 'solutions'];

  if (raw.includes('\n')) {
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
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
  }

  const text = normalizeLedgerName(raw);
  if (!text) return '';

  // Legal suffixes to look for (case-insensitive)
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
      // Verify whole-word match
      const before = idx > 0 ? text[idx - 1] : ' ';
      const afterChar = text[idx + suffix.length] || ' ';
      const isWordBefore = /[\s,]/.test(before) || idx === 0;
      const isWordAfter = /[\s,.]/.test(afterChar) || (idx + suffix.length) === text.length;
      if (isWordBefore && isWordAfter) {
        let end = idx + suffix.length;
        // Include trailing period if present
        if (text[end] === '.') end++;
        if (end > bestEnd) bestEnd = end;
      }
      searchFrom = idx + 1;
    }
  }

  // Decide: 1-3 words after suffix = qualifier (Trust, OLD TRUST) -> KEEP
  //         4+ words after suffix  = tagline (We Help The Hurt) -> STRIP
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

describe('extractBusinessName', () => {
  it('should handle null/undefined/empty', () => {
    assert.equal(extractBusinessName(null), '');
    assert.equal(extractBusinessName(undefined), '');
    assert.equal(extractBusinessName(''), '');
  });

  it('should strip tagline after PLLC (4+ words = tagline)', () => {
    assert.equal(
      extractBusinessName('Cornish Hernandez Gonzalez, PLLC We Help The Hurt'),
      'Cornish Hernandez Gonzalez, PLLC'
    );
  });

  it('should KEEP qualifier "Trust" after PLLC (1 word = qualifier)', () => {
    assert.equal(
      extractBusinessName('Cornish Hernandez Gonzalez, PLLC Trust'),
      'Cornish Hernandez Gonzalez, PLLC Trust'
    );
  });

  it('should KEEP qualifier "OLD TRUST" after PLLC (2 words = qualifier)', () => {
    assert.equal(
      extractBusinessName('Cornish Hernandez Gonzalez, PLLC OLD TRUST'),
      'Cornish Hernandez Gonzalez, PLLC OLD TRUST'
    );
  });

  it('should strip when qualifier + tagline combined exceed threshold', () => {
    // "Trust We Help The Hurt" = 5 words after PLLC -> stripped
    // In practice, the content script uses .active-business textContent
    // which may not combine qualifier + tagline in the same text node.
    assert.equal(
      extractBusinessName('Cornish Hernandez Gonzalez, PLLC Trust We Help The Hurt'),
      'Cornish Hernandez Gonzalez, PLLC'
    );
  });

  it('should strip tagline after LLC (4+ words)', () => {
    assert.equal(
      extractBusinessName('Smith Consulting LLC Your Trusted Partner Today'),
      'Smith Consulting LLC'
    );
  });

  it('should KEEP short qualifier after LLC', () => {
    assert.equal(
      extractBusinessName('Smith Consulting LLC West'),
      'Smith Consulting LLC West'
    );
  });

  it('should strip tagline after Inc (4+ words)', () => {
    assert.equal(
      extractBusinessName('Acme Inc. Making Things Happen Daily'),
      'Acme Inc.'
    );
  });

  it('should return full name when no tagline', () => {
    assert.equal(
      extractBusinessName('Cornish Hernandez Gonzalez, PLLC'),
      'Cornish Hernandez Gonzalez, PLLC'
    );
  });

  it('should return full name when no legal suffix', () => {
    assert.equal(
      extractBusinessName("Joe's Plumbing"),
      "Joe's Plumbing"
    );
  });

  it('should handle long taglines after suffix', () => {
    assert.equal(
      extractBusinessName('My Company LLC A Really Long Tagline That Goes On'),
      'My Company LLC'
    );
  });

  // ── Newline-aware tests (real CheckKeeper DOM structure) ──

  it('should extract business name from newline-separated text (PLLC Trust)', () => {
    assert.equal(
      extractBusinessName('Cornish Hernandez Gonzalez, PLLC Trust\nWe Help the Hurt'),
      'Cornish Hernandez Gonzalez, PLLC Trust'
    );
  });

  it('should extract business name from newline-separated text (PLLC OLD TRUST)', () => {
    assert.equal(
      extractBusinessName('Cornish Hernandez Gonzalez, PLLC OLD TRUST\nWe Help the Hurt'),
      'Cornish Hernandez Gonzalez, PLLC OLD TRUST'
    );
  });

  it('should extract business name from newline-separated text (bare PLLC)', () => {
    assert.equal(
      extractBusinessName('Cornish Hernandez Gonzalez, PLLC\nWe Help the Hurt'),
      'Cornish Hernandez Gonzalez, PLLC'
    );
  });

  it('should handle multi-line with extra whitespace', () => {
    assert.equal(
      extractBusinessName('  Cornish Hernandez Gonzalez, PLLC Trust  \n                We Help the Hurt'),
      'Cornish Hernandez Gonzalez, PLLC Trust'
    );
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
