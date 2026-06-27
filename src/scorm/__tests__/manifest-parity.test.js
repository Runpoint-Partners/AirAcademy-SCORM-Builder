'use strict';

/**
 * manifest-parity.test.js — the template-based generateManifest must render BYTE-IDENTICAL to the
 * pre-refactor imperative output (Tier 0 = pure refactor, zero behavior change).
 *
 * The golden fixtures were captured from the OLD imperative manifest.js BEFORE the template
 * extraction (LF line endings, no trailing newline — exactly what the JS template literal emitted).
 * If this test is ever RED, the refactor changed the shipped bytes — which existing live SCORM
 * packages + the validator depend on — and must be reverted or the fixtures consciously re-blessed.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { generateManifest } = require('../manifest');

const FIX = path.join(__dirname, 'fixtures');
// Normalize CRLF→LF on read so a Windows checkout (core.autocrlf) can't false-fail this test — the
// canonical golden is LF (what the zip actually carries). .gitattributes also pins these to LF.
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8').replace(/\r\n/g, '\n');

const CASES = [
  {
    golden: 'manifest-plain.golden.xml',
    opts: { courseId: '100007', networkId: '668', courseName: 'Basic Indoctrination' },
  },
  {
    golden: 'manifest-xmlspecial.golden.xml',
    opts: { courseId: '141600', networkId: '164', courseName: 'Crew & "Safety" <Ops> \'Manual\'' },
  },
];

describe('generateManifest — byte-identical to the pre-template golden', () => {
  for (const { golden, opts } of CASES) {
    it(`renders ${golden} byte-for-byte`, () => {
      const out = generateManifest(opts);
      assert.equal(out, read(golden));
    });
  }

  it('leaves no unfilled {{PLACEHOLDER}} in the rendered manifest', () => {
    const out = generateManifest({ courseId: '1', networkId: '2', courseName: 'X' });
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(out), 'all placeholders must be substituted');
  });

  it('XML-escapes the title (the lone bit of non-template logic)', () => {
    const out = generateManifest({ courseId: '1', networkId: '2', courseName: 'A & B <c> "d" \'e\'' });
    assert.ok(out.includes('<title>A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;</title>'));
    assert.ok(!out.includes('<title>A & B'), 'raw ampersand must not survive into the XML');
  });

  it('still requires courseId / networkId / courseName', () => {
    assert.throws(() => generateManifest({ networkId: '2', courseName: 'X' }), /courseId is required/);
    assert.throws(() => generateManifest({ courseId: '1', courseName: 'X' }), /networkId is required/);
    assert.throws(() => generateManifest({ courseId: '1', networkId: '2' }), /courseName is required/);
  });
});
