'use strict';

/**
 * collect-pages.test.js — the page-collection contract for loadCourseData (test WHAT, not how).
 *
 * Pins the P-RNAV truncation defect as a falsifiable hypothesis: the Ascent contentIndex nests most
 * pages under id-BEARING "section/trip" folders (id != null, empty/'folder' type). The old loop only
 * recursed null-id sub-folders and mis-read an id-bearing folder as a (missing) page, dropping its
 * ENTIRE subtree (~80% page loss). The fix mirrors the source adapter's collectPageRefs — a page is
 * id + a real non-folder type, and we ALWAYS recurse into children. These tests are RED on the old
 * code (totalPages = 2 below) and GREEN on the fix (4). The vanilla case guards against the inverse
 * risk — over-collecting on normal courses.
 *
 * Hermetic: writes a throwaway module fixture to a tmp dir; no network, no S3.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadCourseData } = require('../build-player');

const MODULE_ID = 999;

/** Write a throwaway module fixture (module JSON + a page file per real leaf) and return its dir. */
function makeFixture(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorm-builder-collect-'));
  fs.mkdirSync(path.join(dir, 'pages'));
  const writePages = (nodes) => {
    for (const n of nodes || []) {
      // a real leaf page → has its content file on disk (a container/folder has none)
      if (n.id != null && n.id !== 'null' && n.type && n.type !== 'folder') {
        fs.writeFileSync(
          path.join(dir, 'pages', `${MODULE_ID}_${n.id}.json`),
          JSON.stringify({ content: { html_body: `<p>Page ${n.id}</p>` }, references: [] })
        );
      }
      if (Array.isArray(n.children)) writePages(n.children);
    }
  };
  writePages(contents.flatMap((f) => f.children || []));
  fs.writeFileSync(
    path.join(dir, `module_${MODULE_ID}.json`),
    JSON.stringify({
      courseID: MODULE_ID,
      networkID: 1,
      course_name: 'Test Course',
      module_version: { contentIndex: { contents } },
    })
  );
  return dir;
}

describe('loadCourseData — page collection', () => {
  it('collects pages nested under an id-BEARING section folder (P-RNAV) AND a null-id sub-folder (OP-580)', () => {
    const dir = makeFixture([
      {
        name: 'Section A',
        children: [
          { name: 'Page 1', id: '10', type: 'html' }, // leaf page
          {
            name: 'Trip', id: '11', type: '', // id-BEARING folder — the defect: old code dropped its subtree
            children: [
              { name: 'Nested 1', id: '20', type: 'html' },
              { name: 'Nested 2', id: '21', type: 'html' },
            ],
          },
          {
            name: 'NullFolder', id: null, type: 'folder', // null-id sub-folder — the OP-580 case
            children: [{ name: 'Sub Page', id: '30', type: 'html' }],
          },
        ],
      },
    ]);
    const cd = loadCourseData(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    // Four real leaf pages; the id-bearing folder (11) is a container, not a page.
    assert.equal(cd.totalPages, 4);
    assert.deepEqual(cd.pages.map((p) => p.id), ['10', '20', '21', '30']);
  });

  it('a vanilla course (leaf pages only) is unchanged — no over-collection', () => {
    const dir = makeFixture([
      {
        name: 'Section',
        children: [
          { name: 'P1', id: '1', type: 'html' },
          { name: 'P2', id: '2', type: 'html' },
          { name: 'P3', id: '3', type: 'html' },
        ],
      },
    ]);
    const cd = loadCourseData(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(cd.totalPages, 3);
    assert.deepEqual(cd.pages.map((p) => p.id), ['1', '2', '3']);
  });
});
