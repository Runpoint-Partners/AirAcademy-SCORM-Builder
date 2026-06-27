'use strict';

/**
 * media-resolver.test.js — behavioral tests of the resolver contract (test WHAT, not how).
 *
 * Encodes the OP-599 defect as a falsifiable hypothesis: a `dual-size-image` `/files/<hash>`
 * thumbnail is fetched from the STALE Ascent host, so the download fails and the resolver
 * SILENTLY leaves a bare root-relative `/files/` ref in the HTML, counted nowhere. The RED
 * tests below fail today; the fix (multi-host fetch + loud artifact contract) flips them green.
 *
 * Hermetic: the I/O ports (downloadHashFile/uploadMedia) are injected, so no network or S3.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  hashFileCandidateUrls,
  findHashFileUrls,
  resolveHashFiles,
  summarizeUnresolved,
  publicAscentRelativePattern,
  publicAscentAbsolutePattern,
} = require('../media-resolver');

const matchAll = (re, html) => { const out = []; let m; while ((m = re.exec(html)) !== null) out.push(m[3]); return out; };

describe('publicAscentRelativePattern — reference_library Module-Header banners (the 28467 broken-media defect)', () => {
  it('MATCHES /files/reference_library/<net>/Module_Headers/<file>.png (was unhandled → shipped bare → 403)', () => {
    const html = '<img src="/files/reference_library/90/Module_Headers/AAA%20purple%20copyright.png">';
    assert.deepEqual(matchAll(publicAscentRelativePattern(), html), ['/files/reference_library/90/Module_Headers/AAA%20purple%20copyright.png']);
  });
  it('STILL matches existing media_library refs (no regression)', () => {
    assert.deepEqual(matchAll(publicAscentRelativePattern(), '<img src="/files/media_library/90/foo.jpg">'), ['/files/media_library/90/foo.jpg']);
  });
  it('does NOT match hash files (handled by the separate hash resolver)', () => {
    assert.deepEqual(matchAll(publicAscentRelativePattern(), '<img src="/files/668-abc123def456.jpg">'), []);
  });
  it('absolute pattern matches an ascent reference_library URL', () => {
    const m = publicAscentAbsolutePattern().exec('<img src="https://ascent.aerostudies.com/files/reference_library/90/Module_Headers/AAA%20purple%20exam.png">');
    assert.ok(m !== null && m[3].includes('reference_library'));
  });
});

// A real failing ref from course 159369 (48-hex hash).
const HASH = '/files/211-1af6ace04078b6e49f4afc53c1d428670f8e03bcfc364e45';
const DUAL = `<a class="dual-size-image" href="${HASH}"><img src="${HASH}"></a>`;
// A bare ROOT-RELATIVE /files/ hash ref inside an attribute (the broken form — resolves to S3 root).
const BARE_FILES_ATTR = /["']\/files\/\d+-[0-9a-f]{20,}["']/;

describe('hashFileCandidateUrls — multi-host after the 2026-05-28 platform migration', () => {
  it('tries the post-migration host (aircrewacademy) as well as the legacy host', () => {
    const urls = hashFileCandidateUrls(HASH);
    assert.ok(
      urls.some((u) => u.includes('aircrewacademy.aerostudies.com')),
      `must try the post-migration host; got ${JSON.stringify(urls)}`,
    );
    assert.ok(urls.some((u) => u.includes('ascent.aerostudies.com')), 'should still try the legacy host');
  });

  it('passes an already-absolute url through unchanged', () => {
    assert.deepEqual(hashFileCandidateUrls('https://x.example/y'), ['https://x.example/y']);
  });
});

describe('findHashFileUrls — the scanner is NOT the bug', () => {
  it('finds the dual-size-image href + img src as ONE deduped hash path', () => {
    assert.deepEqual(findHashFileUrls(DUAL), [HASH]);
  });
});

describe('resolveHashFiles — failure must never silently ship a broken root-relative ref', () => {
  it('leaves NO bare root-relative /files/ ref in the html when the download fails', async () => {
    const failingDownload = async () => {
      throw new Error('HTTP 403 (stale host)');
    };
    const neverUpload = async () => {
      throw new Error('upload must not run for a failed download');
    };

    const { html, entries } = await resolveHashFiles(DUAL, {
      networkId: '211',
      courseId: '159369',
      version: '1',
      ascentCookies: 'x',
      downloadHashFile: failingDownload,
      uploadMedia: neverUpload,
    });

    assert.ok(
      entries.some((e) => e.original === HASH && e.status === 'failed'),
      'the failure must be recorded as a failed entry',
    );
    assert.ok(
      !BARE_FILES_ATTR.test(html),
      'output html must NOT retain a bare root-relative /files/ ref (it 403s at the S3 bucket root)',
    );
  });
});

describe('summarizeUnresolved — a failed bare /files/ ref is counted (so a gate/report can see it)', () => {
  it('counts a failed /files/<hash> ref as an unresolved Ascent asset', () => {
    const { unresolvedAscentAssets } = summarizeUnresolved([
      { original: HASH, status: 'failed', action: 'hash-file-download-to-s3' },
    ]);
    assert.equal(unresolvedAscentAssets.length, 1);
  });
});

describe('resolveHashFiles — success path rewrites BOTH href and src to the uploaded S3 URL', () => {
  it('rewrites the dual-size-image href and img src to the S3 URL', async () => {
    const okDownload = async () => ({ buffer: Buffer.from('x'), contentType: 'image/jpeg', extension: '.jpg' });
    const okUpload = async ({ key }) => `https://aaa-courses.s3.us-east-2.amazonaws.com/${key}`;

    const { html, entries } = await resolveHashFiles(DUAL, {
      networkId: '211',
      courseId: '159369',
      version: '1',
      ascentCookies: 'x',
      downloadHashFile: okDownload,
      uploadMedia: okUpload,
    });

    assert.equal((html.match(/aaa-courses\.s3/g) || []).length, 2, 'both href and src must be rewritten');
    assert.ok(!html.includes(HASH), 'no original /files/ ref may remain');
    assert.equal(entries[0].status, 'resolved');
    assert.match(entries[0].s3Key, /^courses\/211\/159369\/v1\/media\/211-[0-9a-f]+\.jpg$/);
  });
});
