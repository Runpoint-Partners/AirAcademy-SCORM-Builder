'use strict';

/**
 * manifest-parity.test.js — generateManifest renders from runtime/manifest-template.xml, and its ONLY
 * per-course variables are COURSE_ID + NETWORK_ID (composed into the package identifier). There is no
 * SCO <title> — Docebo inherits the real course name (verified in sandbox) — so courseName is NOT a
 * manifest input. Everything else in the template is constant.
 *
 * The golden fixture pins the exact rendered bytes (LF, no trailing newline — what the SCORM zip
 * carries). Re-bless deliberately on a contract change:
 *   - 2026-06-27 schemaversion 2004 4th → 3rd Edition (Docebo supports 3rd/1.2 only; our launcher uses
 *     only 3rd-edition RTE elements — no adl.data / audio_captioning — so no launcher change).
 *   - 2026-06-27 removed the SCO <title> (COURSE_ID + NETWORK_ID are the only sanctioned variables).
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

describe('generateManifest — declarative template, only COURSE_ID + NETWORK_ID', () => {
  it('renders manifest-plain.golden.xml byte-for-byte', () => {
    assert.equal(generateManifest({ courseId: '100007', networkId: '668' }), read('manifest-plain.golden.xml'));
  });

  it('composes the identifier from courseId + networkId (not hardcoded)', () => {
    const out = generateManifest({ courseId: '141600', networkId: '164' });
    assert.ok(out.includes('identifier="AAA_141600_164"'), 'identifier must be AAA_<courseId>_<networkId>');
  });

  it('depends on ONLY the two sanctioned variables — no <title>, no leftover placeholder', () => {
    const out = generateManifest({ courseId: '1', networkId: '2' });
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(out), 'all placeholders must be substituted');
    assert.ok(!out.includes('<title>'), 'manifest must carry no SCO <title> (Docebo inherits the course name)');
  });

  it('requires courseId + networkId (the only inputs)', () => {
    assert.throws(() => generateManifest({ networkId: '2' }), /courseId is required/);
    assert.throws(() => generateManifest({ courseId: '1' }), /networkId is required/);
  });
});
