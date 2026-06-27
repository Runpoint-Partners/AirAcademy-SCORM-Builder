'use strict';

/**
 * shared-player-output.test.js — the builder emits a THIN SHARED shell, never an inline player copy.
 *
 * Contract (test WHAT, not how):
 *  - generateIndexHtml(courseData, manifest) references the player from the MANIFEST: every asset is a
 *    `<link>`/`<script src>` against `manifest.base`, in manifest order, with NO inline player code.
 *  - The manifest's asset list is authoritative — adding `aaa-presence.js` to the manifest makes it appear
 *    in the shell with zero edits here (this is the drift the refactor fixed: the old hardcoded shell
 *    emitted 3 of the 4 canonical assets, dropping aaa-presence.js).
 *  - loadPlayerManifest throws LOUDLY when the manifest is absent/malformed or the implementation is
 *    unknown — there is no vendored fallback (that was the whole point of deleting inline mode).
 *
 * Hermetic: generateIndexHtml is pure; loadPlayerManifest is exercised via a `data:` URL through the
 * AAA_PLAYER_MANIFEST_URL override (no network, no S3).
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { generateIndexHtml, loadPlayerManifest } = require('../build-player');

// The canonical 4-asset player set the player repo publishes (player-channels.js → PLAYER_ASSETS).
const BASE = 'https://aaa-courses.s3.us-east-2.amazonaws.com/player/v1';
const ASSETS = ['player.css', 'scorm-client.js', 'aaa-presence.js', 'player.js'];
const MANIFEST = { implementation: 'javascript', version: 'test', base: BASE, assets: ASSETS };

const COURSE = { courseName: 'Test Course', courseId: '123', networkId: '547', totalPages: 2, pages: [] };

describe('generateIndexHtml — thin shared shell (manifest-driven, no inline player)', () => {
  it('references every manifest asset against the manifest base', () => {
    const html = generateIndexHtml(COURSE, MANIFEST);
    assert.match(html, new RegExp(`<link rel="stylesheet" href="${BASE}/player\\.css">`));
    for (const js of ['scorm-client.js', 'aaa-presence.js', 'player.js']) {
      assert.ok(html.includes(`<script src="${BASE}/${js}"></script>`), `missing <script src> for ${js}`);
    }
  });

  it('includes aaa-presence.js (the asset the old hardcoded shell dropped)', () => {
    const html = generateIndexHtml(COURSE, MANIFEST);
    assert.ok(html.includes(`<script src="${BASE}/aaa-presence.js"></script>`), 'aaa-presence.js must be referenced');
  });

  it('emits the JS assets in manifest order, after the inline courseData', () => {
    const html = generateIndexHtml(COURSE, MANIFEST);
    const at = (s) => html.indexOf(s);
    assert.ok(at('var courseData =') < at(`${BASE}/scorm-client.js`), 'courseData must be inlined before the player scripts');
    assert.ok(at(`${BASE}/scorm-client.js`) < at(`${BASE}/aaa-presence.js`), 'scorm-client before aaa-presence');
    assert.ok(at(`${BASE}/aaa-presence.js`) < at(`${BASE}/player.js`), 'aaa-presence before player.js (player boots last)');
  });

  it('embeds NO inline player code — only the courseData script is inline; all player assets are by-reference', () => {
    const html = generateIndexHtml(COURSE, MANIFEST);
    assert.ok(!html.includes('<style'), 'shared shell uses <link>, never an inline <style> player stylesheet');
    // Every <script> is either the courseData inline line or an external src= reference — no player body.
    const scripts = html.match(/<script\b[^>]*>/g) || [];
    for (const tag of scripts) {
      const isExternal = / src=/.test(tag); // external player asset
      const isInlineCourseData = tag === '<script>'; // the lone inline block holds courseData only
      assert.ok(isExternal || isInlineCourseData, `unexpected inline <script>: ${tag}`);
    }
    // The single inline script is exactly the courseData assignment — no inline player logic leaked in.
    assert.ok(html.includes('<script>var courseData ='), 'courseData inline script present');
  });

  it('throws loudly when handed no/malformed manifest (no silent fallback)', () => {
    assert.throws(() => generateIndexHtml(COURSE, undefined), /resolved player manifest/);
    assert.throws(() => generateIndexHtml(COURSE, { base: BASE }), /resolved player manifest/);
    assert.throws(() => generateIndexHtml(COURSE, { assets: ASSETS }), /resolved player manifest/);
  });
});

describe('loadPlayerManifest — reads the deployed manifest, fails loud (no vendored fallback)', () => {
  afterEach(() => { delete process.env.AAA_PLAYER_MANIFEST_URL; });

  it('loads + validates a deployed manifest (via the env override)', async () => {
    const body = JSON.stringify(MANIFEST);
    process.env.AAA_PLAYER_MANIFEST_URL = `data:application/json,${encodeURIComponent(body)}`;
    const m = await loadPlayerManifest('javascript');
    assert.equal(m.base, BASE);
    assert.deepEqual(m.assets, ASSETS);
  });

  it('throws on a malformed manifest (missing assets) — no fallback to a vendored copy', async () => {
    const body = JSON.stringify({ base: BASE }); // no assets[]
    process.env.AAA_PLAYER_MANIFEST_URL = `data:application/json,${encodeURIComponent(body)}`;
    await assert.rejects(loadPlayerManifest('javascript'), /malformed/);
  });

  it('throws on an unknown implementation', async () => {
    delete process.env.AAA_PLAYER_MANIFEST_URL; // force the impl→URL map lookup
    await assert.rejects(loadPlayerManifest('cobol'), /unknown player implementation/);
  });
});
