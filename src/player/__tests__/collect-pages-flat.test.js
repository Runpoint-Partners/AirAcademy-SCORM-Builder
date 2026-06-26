'use strict';

/**
 * collect-pages-flat.test.js — loadCourseData must collect a FLAT contentIndex (test WHAT, not how).
 *
 * Some courses (e.g. the Coulson / old-host Ascent networks) have a FLAT contentIndex: the top-level
 * `contents` entries ARE the pages (id + a real html/quiz type, no folder nesting). The old top-level
 * loop only ever collected `node.children`, so a flat course collected ZERO pages — every such course
 * then tripped the downstream zero-pages gate and "failed" with valid source on disk. The fix walks the
 * top level the same way it walks every level (a node is EITHER a section folder OR a page), mirroring
 * the source adapter's collectPageRefs (the pagesExpected parity source). This test is RED on the old
 * loop (totalPages = 0) and GREEN on the fix (3). A mixed flat+nested fixture guards reading order.
 *
 * Hermetic: writes a throwaway module fixture to a tmp dir; no network, no S3.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadCourseData } = require('../build-player');

const MODULE_ID = 998;

/** Write a fixture whose page files cover EVERY real leaf (flat top-level pages AND nested ones). */
function makeFixture(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorm-builder-flat-'));
  fs.mkdirSync(path.join(dir, 'pages'));
  const writePages = (nodes) => {
    for (const n of nodes || []) {
      if (n.id != null && n.id !== 'null' && n.type && n.type !== 'folder') {
        fs.writeFileSync(
          path.join(dir, 'pages', `${MODULE_ID}_${n.id}.json`),
          JSON.stringify({ content: { html_body: `<p>Page ${n.id}</p>` }, references: [] })
        );
      }
      if (Array.isArray(n.children)) writePages(n.children);
    }
  };
  writePages(contents); // walk from the TOP so flat top-level pages get a file too
  fs.writeFileSync(
    path.join(dir, `module_${MODULE_ID}.json`),
    JSON.stringify({
      courseID: MODULE_ID,
      networkID: 547,
      course_name: 'Flat Course',
      module_version: { contentIndex: { contents } },
    })
  );
  return dir;
}

describe('loadCourseData — FLAT contentIndex (top-level pages, no folders)', () => {
  it('collects every top-level page when there are no folders', () => {
    const dir = makeFixture([
      { name: 'B-737 Fireliner RADS System', id: '13643555', type: 'html', children: [] },
      { name: 'Fireliner RADS System Layout', id: '13643556', type: 'html', children: [] },
      { name: 'Fireliner RADS Actuators', id: '13643557', type: 'html', children: [] },
    ]);
    const cd = loadCourseData(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(cd.totalPages, 3);
    assert.deepEqual(cd.pages.map((p) => p.id), ['13643555', '13643556', '13643557']);
  });

  it('preserves reading order across a flat page, a folder section, then another flat page', () => {
    const dir = makeFixture([
      { name: 'Intro', id: '1', type: 'html', children: [] }, // flat top-level page
      {
        name: 'Section', // folder — its leaves form a section
        children: [
          { name: 'S1', id: '2', type: 'html' },
          { name: 'S2', id: '3', type: 'html' },
        ],
      },
      { name: 'Wrap-up', id: '4', type: 'html', children: [] }, // flat top-level page
    ]);
    const cd = loadCourseData(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(cd.totalPages, 4);
    assert.deepEqual(cd.pages.map((p) => p.id), ['1', '2', '3', '4']);
  });
});
