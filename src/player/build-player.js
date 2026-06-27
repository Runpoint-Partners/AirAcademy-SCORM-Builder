#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '..', '.env') });
const {
  resolveMedia,
  loginToAscent,
  downloadHashFile,
  cachedDownloadHashFile,
  uploadMediaToS3,
  uploadReferenceToS3,
  deleteStaleRefFiles,
  findReusableReferenceSource,
  findSharedReferenceSource,
  uploadSharedReferenceToS3,
  copyReferenceFromS3,
  withSharedAssetLock,
} = require('./media-resolver');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_MODULE_DIR = path.join(PROJECT_ROOT, 'data', 'module_100007');
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'build', 'player');
const PAGE_RESOLUTION_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.PLAYER_PAGE_RESOLUTION_CONCURRENCY || '4', 10) || 1
);

/**
 * Strip HTML tags from a string (used to clean page titles for header display).
 */
function stripTags(html) {
  return html.replace(/<[^>]*>/g, '');
}

function formatIso8601Duration(ms) {
  var durationMs = Number(ms);
  if (!isFinite(durationMs) || durationMs < 0) durationMs = 0;
  durationMs = Math.round(durationMs);

  var hours = Math.floor(durationMs / 3600000);
  durationMs -= hours * 3600000;
  var minutes = Math.floor(durationMs / 60000);
  durationMs -= minutes * 60000;
  var seconds = Math.floor(durationMs / 1000);
  var milliseconds = durationMs - seconds * 1000;

  var result = 'PT';
  if (hours > 0) result += hours + 'H';
  if (minutes > 0) result += minutes + 'M';
  if (seconds > 0 || milliseconds > 0 || result === 'PT') {
    if (milliseconds > 0) {
      var fractionalSeconds = String(seconds) + '.' + String(milliseconds).padStart(3, '0').replace(/0+$/, '');
      result += fractionalSeconds + 'S';
    } else {
      result += seconds + 'S';
    }
  }
  return result;
}

async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await tasks[index]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * Build course data from module JSON + page files.
 * Reuses the same data-extraction logic as archive/demo/build-scorm.js.
 */

function loadCourseData(moduleDir) {
  const moduleFile = fs.readdirSync(moduleDir).find(f => f.match(/^module_\d+\.json$/));
  if (!moduleFile) throw new Error('No module JSON found in ' + moduleDir);

  const moduleData = JSON.parse(fs.readFileSync(path.join(moduleDir, moduleFile), 'utf8'));
  const contentIndex = moduleData.module_version.contentIndex.contents;
  const moduleId = moduleData.courseID;

  // Build ordered page list from contentIndex.
  //
  // A node with a null id is a SUB-FOLDER, not a page. Trip-scenario sections
  // (e.g. "KTEB to EKCH Trip") nest their pages one level deeper inside such
  // sub-folders (Planning / Preflight / Takeoff and Climb Out / ...). The original
  // flat loop skipped EVERY null-id node, silently dropping the entire nested
  // section (OP-580: 227 pages lost, learner reached the exam early). Recurse into
  // sub-folders so their leaf pages are collected into the parent section,
  // preserving reading order. Only a null-id node with NO children is a genuine
  // malformed entry worth warning about.
  const sections = [];
  const pageOrder = [];
  // Collect leaf PAGES in reading order. A node is a PAGE iff it has a real id AND a real, non-folder
  // content type (html/quiz/selftest/…). Everything else — a `null`-id sub-folder OR an id-BEARING
  // section folder (id present, empty/'folder' type, e.g. the P-RNAV "trip" sections) — is a CONTAINER:
  // not a page itself, but its children must still be collected.
  //
  // This MIRRORS the source adapter's `collectPageRefs` (the parity source of truth that produces
  // `pagesExpected`), so the embedded page count can never silently diverge from it. The previous loop
  // only recursed `null`-id containers and treated EVERY id-bearing node as a page — so an id-bearing
  // section folder was mis-read as a (missing) page and its ENTIRE subtree was dropped (P-RNAV courses
  // lost ~80% of pages). OP-580 fixed the null-id case; this generalizes it to ALWAYS recurse.
  function collectPages(children, sectionName) {
    const collected = [];
    for (const child of children || []) {
      const hasChildren = Array.isArray(child.children) && child.children.length > 0;
      const isPage = child.id != null && child.id !== 'null' && child.type && child.type !== 'folder';
      if (isPage) {
        const pageFile = path.join(moduleDir, 'pages', `${moduleId}_${child.id}.json`);
        if (fs.existsSync(pageFile)) {
          const pageData = JSON.parse(fs.readFileSync(pageFile, 'utf8'));
          collected.push({
            id: child.id,
            pageNumber: child.pageNumber,
            name: child.name,
            type: child.type,
            data: pageData
          });
        } else {
          console.warn(`  [warning] Page file missing: ${pageFile}, skipping`);
        }
      } else if (!hasChildren) {
        // A non-page leaf with no children is a genuine malformed entry worth surfacing (OP-580).
        console.warn(`  [warning] Skipping non-page leaf (id=${child.id}, type=${child.type}) in section "${sectionName}" of module ${moduleId}`);
      }
      // ALWAYS recurse: section containers (null-id sub-folders AND id-bearing section folders) hold
      // their pages as children, preserving reading order.
      if (hasChildren) {
        for (const nested of collectPages(child.children, sectionName)) collected.push(nested);
      }
    }
    return collected;
  }
  // Walk the TOP level the same way collectPages walks every level: a top node is EITHER a section
  // FOLDER (has children → its leaf pages form a named section, recursing sub-folders) OR a PAGE in
  // its own right (a FLAT contentIndex — top-level entries ARE the pages, no folder nesting). The
  // previous loop only ever collected `folder.children`, so a flat course collected ZERO pages and
  // failed the downstream zero-pages gate (the Coulson / old-host courses: contentIndex.contents is
  // a flat list of html pages, no folders). Collecting a flat top-level page here mirrors the source
  // adapter's collectPageRefs — the pagesExpected parity source — so the embedded page count matches
  // what materialize fetched. Nested courses are unchanged (they take the `hasChildren` branch).
  const flatLeafPages = [];
  for (const node of contentIndex) {
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    if (hasChildren) {
      const sectionPages = collectPages(node.children, node.name);
      for (const pageInfo of sectionPages) pageOrder.push(pageInfo);
      sections.push({ name: node.name, pages: sectionPages });
    } else {
      // No children: a flat top-level PAGE (collectPages loads its content file) or a malformed leaf
      // (collectPages emits the standard warning and collects nothing). Either way, reuse the exact
      // page-classifying path rather than special-casing it here.
      const leaf = collectPages([node], node.name);
      for (const pageInfo of leaf) {
        pageOrder.push(pageInfo);
        flatLeafPages.push(pageInfo);
      }
    }
  }
  // Group any flat top-level pages into one default (unnamed) section so navigation still renders.
  if (flatLeafPages.length > 0) sections.push({ name: '', pages: flatLeafPages });

  // Extract quiz options
  const quizPage = pageOrder.find(function (p) { return p.type === 'quiz'; });
  const requiredScore = quizPage ? parseInt(quizPage.data.options.required_score || '80', 10) : 80;

  // Extract timer from module JSON
  const minimumTimeSeconds = moduleData.minimum_required_course_time_seconds || 0;

  // Build course data JSON for embedding
  const pages = pageOrder.map(function (p) {
    const base = {
      id: p.id,
      pageNumber: p.pageNumber,
      title: stripTags(String(p.name || '')),
      type: p.type
    };

    if (p.type === 'html') {
      let rawHtml = p.data.content.html_body || p.data.content.body || '';
      // Strip inline width styles from td elements inside autofit-right-table
      // to prevent source data widths (e.g. 5.6%) from overriding our CSS layout
      rawHtml = rawHtml.replace(/(class="[^"]*autofit-right-table[^"]*"[^>]*>[\s\S]*?<\/table>)/gi, function(table) {
        return table.replace(/(<td[^>]*)\s+style="[^"]*width:\s*[\d.]+%[^"]*"/gi, '$1');
      });
      // Remove defunct "Ask Instructor" reference — button doesn't exist in Docebo
      // Handles variants: with/without <p> tags, <strong> tags, &nbsp;, "any" optional
      const WS = '(?:\\s|&nbsp;)*'; // whitespace or &nbsp;
      const askInstructorCore = `If you have${WS}(?:any${WS})?questions,${WS}click the`;
      const withStrong = `${askInstructorCore}${WS}<strong>${WS}(?:&#39;)?${WS}Ask${WS}(?:the\\s+)?Instructor${WS}(?:&#39;)?${WS}<\\/strong>${WS}button[^<]*`;
      const withoutStrong = `${askInstructorCore}(?:\\s|&nbsp;)+Ask(?:\\s|&nbsp;)+(?:the(?:\\s|&nbsp;)+)?Instructor(?:\\s|&nbsp;)+button[^<]*`;
      // Wrapped in <p> tags
      rawHtml = rawHtml.replace(new RegExp(`<p>${WS}(?:${withStrong}|${withoutStrong})<\\/p>\\s*`, 'gi'), '');
      // Bare text (no <p> wrapper)
      rawHtml = rawHtml.replace(new RegExp(withStrong, 'gi'), '');
      rawHtml = rawHtml.replace(new RegExp(withoutStrong, 'gi'), '');
      // Variant: "use the 'Ask Instructor' feature" (network 118 phrasing)
      rawHtml = rawHtml.replace(/<p>(?:\s|&nbsp;)*If you have(?:\s|&nbsp;)*(?:any(?:\s|&nbsp;)*)?questions,(?:\s|&nbsp;)*use the(?:\s|&nbsp;)*(?:<strong>)?(?:\s|&nbsp;)*(?:&#39;)?(?:\s|&nbsp;)*Ask(?:\s|&nbsp;)+Instructor(?:\s|&nbsp;)*(?:&#39;)?(?:\s|&nbsp;)*(?:<\/strong>)?(?:\s|&nbsp;)*feature[^<]*<\/p>\s*/gi, '');
      base.htmlBody = rawHtml;
    } else if (p.type === 'selftest') {
      base.question = p.data.content.question;
      base.answers = p.data.content.ContentSelftestAnswer.map(function (a) {
        return {
          id: a.answerID,
          text: a.answer,
          correct: a.correct === '1',
          hint: a.hint || ''
        };
      });
      if (p.data.content.ref_page_id) {
        base.refPageId = p.data.content.ref_page_id;
      }
    } else if (p.type === 'quiz') {
      // Get question bank data if present on this quiz page
      const qbQuestions = p.data.qbQuestions || {};

      base.questions = p.data.content.map(function (q) {
        if (q.question_type === 'random' && q.question_bank_ids) {
          // Random question from question bank — build a pool for client-side selection
          var bankIds = [];
          try { bankIds = JSON.parse(q.question_bank_ids); } catch (e) { /* ignore */ }

          var pool = [];
          for (var bi = 0; bi < bankIds.length; bi++) {
            var qbId = String(bankIds[bi][0]);
            // Per-bank refPageId lives at bankIds[bi][1] in Ascent's shape —
            // NOT on the qbQuestion itself and NOT on the parent quiz question.
            var bankRefId = bankIds[bi][1];
            var qbEntry = qbQuestions[qbId];
            if (qbEntry && qbEntry.ContentQuestionBankQuestion && qbEntry.ContentQuestionBankAnswer) {
              var poolEntry = {
                id: qbEntry.ContentQuestionBankQuestion.questionID || qbId,
                question: qbEntry.ContentQuestionBankQuestion.question || '',
                answers: qbEntry.ContentQuestionBankAnswer.map(function (a) {
                  return {
                    id: a.answerID,
                    text: a.answer,
                    correct: a.correct === '1' || a.correct === 1
                  };
                })
              };
              if (bankRefId && String(bankRefId) !== '0') {
                poolEntry.refPageId = String(bankRefId);
              }
              pool.push(poolEntry);
            }
          }

          var randomEntry = {
            id: q.questionID,
            questionType: 'random',
            pool: pool
          };
          if (q.ref_page_id && String(q.ref_page_id) !== '0') randomEntry.refPageId = q.ref_page_id;
          return randomEntry;
        }

        // Direct (mc) question — embed as-is
        var directQ = {
          id: q.questionID,
          question: q.question,
          answers: q.ContentQuizAnswer.map(function (a) {
            return {
              id: a.answerID,
              text: a.answer,
              correct: a.correct === '1'
            };
          })
        };
        if (q.ref_page_id && String(q.ref_page_id) !== '0') directQ.refPageId = q.ref_page_id;
        return directQ;
      });
      base.requiredScore = requiredScore;
      base.allowRetake = quizPage.data.options.allow_retake === '1';
      base.retakeLimit = parseInt(quizPage.data.options.retake_limit || '0', 10) || null;
    }

    // Include references (downloadable attachments) if present
    if (p.data.references && p.data.references.length > 0) {
      base.references = p.data.references.map(function (ref) {
        return {
          name: ref.reference_name || 'Download',
          url: ref.reference_url || ref.reference_file || '',
          file: ref.reference_file || '',
        };
      }).filter(function (ref) { return ref.url || ref.file; });
    }

    return base;
  });

  const sects = sections.map(function (s) {
    return {
      name: s.name,
      pageIds: s.pages.map(function (p) { return p.id; })
    };
  });

  return {
    courseId: moduleData.courseID,
    networkId: moduleData.networkID,
    courseName: moduleData.course_name.replace(/^\[Admin\]\s*/, ''),
    navigationLock: true, // All courses locked — Alvin confirmed Mar 24. 98% of source data has lock=1, remaining 10 courses were outliers.
    totalPages: pageOrder.length,
    requiredScore: requiredScore,
    minimumTimeSeconds: minimumTimeSeconds,
    sections: sects,
    pages: pages,
  };
}

// ── PLAYER MANIFEST ────────────────────────────────────────────────────────────────────────────
// The builder NEVER vendors player code. A built course is a thin shell that references the player
// deployed centrally to S3 by the player repo (AirAcademyOWS); that deploy publishes a
// `player-manifest.json` next to the assets. The builder reads it for the base URL + the CANONICAL
// asset list, so a player asset added/renamed in the player repo flows here with zero edits (no more
// hand-synced `runtime/` copies that drift). JS=player/v1 (default), Vue=player/v2.
const PLAYER_MANIFEST_URLS = Object.freeze({
  javascript: 'https://aaa-courses.s3.us-east-2.amazonaws.com/player/v1/player-manifest.json',
  vue: 'https://aaa-courses.s3.us-east-2.amazonaws.com/player/v2/player-manifest.json',
});
const DEFAULT_PLAYER_IMPL = 'javascript';
const _playerManifestCache = new Map();

/**
 * Fetch the player manifest the player repo published to S3 (public; no creds). Cached per URL.
 * Throws LOUDLY when absent/malformed — there is NO vendored fallback (that is the whole point).
 *
 * @param {string} [implementation='javascript']  'javascript' (player/v1) or 'vue' (player/v2).
 *   `AAA_PLAYER_MANIFEST_URL` env overrides the URL (sandbox/test).
 * @returns {Promise<{base:string, assets:string[], implementation?:string, version?:string}>}
 */
async function loadPlayerManifest(implementation) {
  const impl = implementation || DEFAULT_PLAYER_IMPL;
  const url = process.env.AAA_PLAYER_MANIFEST_URL || PLAYER_MANIFEST_URLS[impl];
  if (!url) {
    throw new Error(`unknown player implementation '${impl}' (known: ${Object.keys(PLAYER_MANIFEST_URLS).join(', ')})`);
  }
  if (_playerManifestCache.has(url)) return _playerManifestCache.get(url);
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (e) {
    throw new Error(`player manifest unreachable at ${url}: ${e.message}. Deploy the player (publishes player-manifest.json) first — no vendored fallback.`);
  }
  if (!res.ok) {
    throw new Error(`player manifest HTTP ${res.status} at ${url}. Deploy the player (publishes player-manifest.json) first — no vendored fallback.`);
  }
  const manifest = await res.json();
  if (!manifest || typeof manifest.base !== 'string' || !Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new Error(`player manifest at ${url} is malformed — expected {base:string, assets:string[]}`);
  }
  _playerManifestCache.set(url, manifest);
  return manifest;
}

/**
 * Generate the course player index.html — a thin shell that references the shared player assets named
 * by the deployed manifest. Only the course data is embedded inline. (Inline-player mode was removed:
 * baking a frozen player copy into a course defeats central player updates.)
 *
 * @param {Object} courseData  Course data from loadCourseData
 * @param {{base:string, assets:string[]}} manifest  Resolved player manifest (see loadPlayerManifest)
 */
function generateIndexHtml(courseData, manifest) {
  if (!manifest || typeof manifest.base !== 'string' || !Array.isArray(manifest.assets)) {
    throw new Error('generateIndexHtml(courseData, manifest): a resolved player manifest ({base, assets[]}) is required — call buildPlayer, or pass loadPlayerManifest() output');
  }
  return generateSharedPlayerHtml(courseData, JSON.stringify(courseData), manifest);
}

/**
 * Generate a thin-shell index.html that references shared player assets on S3.
 * The CSS, scorm-client.js, and player.js are loaded from player/v1/ on S3.
 * Only the course data (JSON) is embedded inline.
 */
function generateSharedPlayerHtml(courseData, courseDataJson, manifest) {
  // Emit a <link>/<script> per asset NAMED BY THE MANIFEST — so the deployed asset set (incl. additions
  // like aaa-presence.js) is reflected with zero edits here. Order follows the manifest's assets array
  // (the player repo pins it: player.css, scorm-client.js, aaa-presence.js, player.js).
  const base = String(manifest.base).replace(/\/$/, '');
  const cssTags = manifest.assets.filter((a) => a.endsWith('.css'))
    .map((a) => `<link rel="stylesheet" href="${base}/${a}">`).join('\n');
  const jsTags = manifest.assets.filter((a) => a.endsWith('.js'))
    .map((a) => `<script src="${base}/${a}"></script>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${courseData.courseName}</title>
${cssTags}
</head>
<body>
<div id="sidebar">
  <div id="sidebar-header">
    <h2>COURSE NAVIGATION</h2>
    <div class="course-title" id="course-title-sidebar"></div>
  </div>
  <div id="sidebar-nav"></div>
  <div id="progress-bar">
    <div class="bar"><div class="fill" id="progress-fill"></div></div>
    <div class="text" id="progress-text">0 of 0 pages</div>
  </div>
</div>
<div id="main">
  <div id="toolbar">
    <div>
      <div class="page-info" id="page-info"></div>
      <div class="page-title" id="page-title-bar"></div>
    </div>
    <span id="timer-display"></span>
  </div>
  <div id="content-area">
    <div id="content-inner"></div>
  </div>
  <div id="nav-buttons">
    <button class="nav-btn" id="prev-btn" onclick="prevPage()">&#9664; Previous</button>
    <div class="nav-center-group">
      <button id="refs-btn" class="nav-secondary-btn" onclick="openRefsModal()" title="Reference Documents" style="display:none"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V8h4.5L14 3.5zM8 13h8v1.5H8V13zm0 3h8v1.5H8V16zm0-6h5v1.5H8V10z"/></svg><span>Reference Documents</span></button>
      <button id="feedback-btn" class="nav-secondary-btn" onclick="toggleFeedback()" title="Ask an Instructor"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5C4 4.12 5.12 3 6.5 3h11C18.88 3 20 4.12 20 5.5v7c0 1.38-1.12 2.5-2.5 2.5H10l-4.6 4.22c-.8.73-2.1.16-2.1-.92V5.5z"/><circle cx="9" cy="9" r="1.4"/><circle cx="12" cy="9" r="1.4"/><circle cx="15" cy="9" r="1.4"/></svg><span>Ask an Instructor</span></button>
    </div>
    <button class="nav-btn" id="next-btn" onclick="nextPage()">Next &#9654;</button>
  </div>
  <div id="selftest-gate-msg">Please answer the review question before continuing.</div>
  <div id="timer-gate-msg">You must spend the minimum required time in this course before it can be marked complete.</div>
</div>
<div id="lightbox-overlay"><button id="lightbox-close" onclick="closeLightbox()" title="Close">&times;</button><img id="lightbox-img" src="" alt=""><div id="lightbox-hint">Click outside image or press Escape to close</div></div>
<div id="ref-page-overlay" onclick="if(event.target===this)closeRefPageModal()"><div id="ref-page-modal"><div class="ref-title-bar"><h3 id="ref-page-title">Reference Page</h3><button class="ref-close-btn" onclick="closeRefPageModal()" title="Close">&times;</button></div><div class="ref-body" id="ref-page-body"></div></div></div>
<div id="refs-modal-overlay" onclick="if(event.target===this)closeRefsModal()"><div id="refs-modal"><div class="ref-title-bar"><h3>Reference Documents</h3><button class="ref-close-btn" onclick="closeRefsModal()" title="Close">&times;</button></div><div id="refs-modal-body"></div></div></div>
<div id="submit-modal-overlay" onclick="if(event.target===this)this.classList.remove(‘active’)"><div id="submit-modal"></div></div>

<div id="diag-overlay" onclick="if(event.target===this)closeDiagPanel()">
  <div id="diag-panel">
    <div class="diag-header"><h3>Flight Recorder</h3><button class="diag-close" onclick="closeDiagPanel()">&times;</button></div>
    <div class="diag-tabs">
      <button class="diag-tab active" onclick="showDiagTab(‘log’)">Event Log</button>
      <button class="diag-tab" onclick="showDiagTab(‘state’)">SCORM State</button>
      <button class="diag-tab" onclick="showDiagTab(‘suspend’)">Suspend Data</button>
    </div>
    <div id="diag-body"></div>
    <div class="diag-actions">
      <button class="diag-btn" onclick="copyDiagLog()">Copy Log</button>
      <button class="diag-btn" onclick="refreshDiagPanel()">Refresh</button>
    </div>
  </div>
</div>

<div id="feedback-panel">
  <div class="fp-header">Ask an Instructor</div>
  <div class="fp-body">
    <div class="fp-context" id="fp-context"></div>
    <textarea id="fp-message" placeholder="What’s your question about this page?"></textarea>
    <div class="fp-actions">
      <button class="fp-btn" onclick="toggleFeedback()">Cancel</button>
      <button class="fp-btn primary" id="fp-submit" onclick="submitFeedback()">Submit</button>
    </div>
    <div class="fp-status" id="fp-status"></div>
  </div>
</div>

<script>var courseData = ${courseDataJson}; courseData.navigationLock = true;</script>
${jsTags}
</body>
</html>`;
}

/**
 * Resolve all media URLs in the courseData pages using the media-resolver module.
 *
 * Processes htmlBody on html pages, question on selftest pages, and question
 * on quiz pages. Mutates the courseData.pages array in place.
 *
 * @param {Object} courseData  The course data object from loadCourseData
 * @param {string} ascentCookies  Ascent session cookies for authenticated downloads
 * @returns {Promise<{ totalResolved: number, totalFailed: number, allResolved: Array, allFailed: Array }>}
 */
async function resolveAllMedia(courseData, ascentCookies) {
  const networkId = String(courseData.networkId);
  const courseId = String(courseData.courseId);
  const version = '1';

  const resolveOpts = { networkId, courseId, version, ascentCookies };
  const pageTasks = courseData.pages.map(page => async () => {
    const pageResolved = [];
    const pageFailed = [];

    if (page.type === 'html' && page.htmlBody) {
      const result = await resolveMedia({ html: page.htmlBody, ...resolveOpts });
      page.htmlBody = result.html;
      pageResolved.push(...result.report.resolved);
      pageFailed.push(...result.report.failed);
    } else if (page.type === 'selftest' && page.question) {
      const result = await resolveMedia({ html: page.question, ...resolveOpts });
      page.question = result.html;
      pageResolved.push(...result.report.resolved);
      pageFailed.push(...result.report.failed);
    } else if (page.type === 'quiz' && page.questions) {
      for (const q of page.questions) {
        if (q.question) {
          const result = await resolveMedia({ html: q.question, ...resolveOpts });
          q.question = result.html;
          pageResolved.push(...result.report.resolved);
          pageFailed.push(...result.report.failed);
        }
        // Resolve media in question bank pool questions
        if (q.pool && Array.isArray(q.pool)) {
          for (const poolQ of q.pool) {
            if (poolQ.question) {
              const result = await resolveMedia({ html: poolQ.question, ...resolveOpts });
              poolQ.question = result.html;
              pageResolved.push(...result.report.resolved);
              pageFailed.push(...result.report.failed);
            }
          }
        }
      }
    }

    // Resolve reference file attachments
    if (page.references && page.references.length > 0) {
      for (const ref of page.references) {
        const refPath = ref.url || ref.file;
        if (!refPath) continue;
        const safeName = (ref.name || 'reference').replace(/[^a-zA-Z0-9_-]/g, '_');
        const refsPrefix = `courses/${resolveOpts.networkId}/${resolveOpts.courseId}/refs/`;

        try {
          const referenceSource = await withSharedAssetLock(`reference:${refPath}`, async () => {
            const reusable = await findReusableReferenceSource(refPath) || await findSharedReferenceSource(refPath);
            if (reusable) return { reusable };

            const downloaded = await cachedDownloadHashFile(refPath, ascentCookies);
            await uploadSharedReferenceToS3({
              refPath,
              buffer: downloaded.buffer,
              contentType: downloaded.contentType,
              extension: downloaded.extension,
            }).catch((err) => {
              console.warn(`    [reference] Warning: shared reference cache failed for ${ref.name}: ${err.message}`);
            });
            return { downloaded };
          });

          if (referenceSource.reusable) {
            const reusable = referenceSource.reusable;
            const fullS3Key = `${refsPrefix}${safeName}${reusable.extension}`;
            const directUrl = await copyReferenceFromS3({ sourceKey: reusable.key, key: fullS3Key });
            await deleteStaleRefFiles(refsPrefix, safeName, reusable.extension);

            ref.url = directUrl;
            ref.resolved = true;
            pageResolved.push({
              original: refPath,
              action: 'reference-reused-s3',
              s3Key: fullS3Key,
              sourceS3Key: reusable.key,
            });
            console.log(`    [reference] ${ref.name} → reused S3 source ${reusable.key}`);
            continue;
          }

          const { buffer, contentType, extension } = referenceSource.downloaded;
          const fullS3Key = `${refsPrefix}${safeName}${extension}`;

          // Force-upload (no idempotency skip) to overwrite any stale login-page
          // HTML that a previous failed run may have placed at this key.
          const directUrl = await uploadReferenceToS3({ buffer, key: fullS3Key, contentType });

          // Clean up stale files with the wrong extension (e.g. .html from a
          // previous run when the correct file is .pdf).
          await deleteStaleRefFiles(refsPrefix, safeName, extension);

          ref.url = directUrl;
          ref.resolved = true;
          pageResolved.push({ original: refPath, action: 'reference-uploaded', s3Key: fullS3Key });
          console.log(`    [reference] ${ref.name} → S3 (${buffer.length} bytes, ${contentType})`);
        } catch (err) {
          // Keep original Ascent URL as fallback
          ref.url = `https://ascent.aerostudies.com${refPath}`;
          ref.resolved = false;
          pageFailed.push({ original: refPath, action: 'reference-failed', error: err.message });
          console.log(`    [reference] FAILED: ${ref.name} — ${err.message}`);
        }
      }
    }
    return { resolved: pageResolved, failed: pageFailed };
  });

  const pageReports = await runWithConcurrency(pageTasks, PAGE_RESOLUTION_CONCURRENCY);
  const allResolved = [];
  const allFailed = [];
  for (const report of pageReports) {
    allResolved.push(...report.resolved);
    allFailed.push(...report.failed);
  }

  return {
    totalResolved: allResolved.length,
    totalFailed: allFailed.length,
    allResolved,
    allFailed,
  };
}

/**
 * Build the player index.html from module data.
 *
 * @param {Object} [options]
 * @param {string} [options.moduleDir]  Path to module data directory
 * @param {string} [options.outputDir]  Path to output directory
 * @returns {Promise<{ outputPath: string, courseData: Object, mediaReport: Object }>}
 */
async function buildPlayer(options) {
  options = options || {};
  const moduleDir = options.moduleDir || DEFAULT_MODULE_DIR;
  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;

  const courseData = loadCourseData(moduleDir);

  // Login to Ascent and resolve all media URLs. Phase runners may pass a
  // shared cookie string so a process does not log in once per course.
  let ascentCookies = options.ascentCookies || '';
  if (ascentCookies) {
    console.log('  Reusing Ascent session.');
  } else {
    console.log('  Logging in to Ascent...');
    ascentCookies = await loginToAscent();
    console.log('  Ascent login successful.');
  }

  console.log(
    '  Resolving media URLs across ' +
    courseData.pages.length +
    ' pages (page concurrency ' +
    PAGE_RESOLUTION_CONCURRENCY +
    ')...'
  );
  const mediaReport = await resolveAllMedia(courseData, ascentCookies);

  // Resolve the central player from its deployed manifest (default = JavaScript / player/v1; pass
  // options.playerImpl='vue' for player/v2). Throws loudly if the manifest is not deployed.
  const playerManifest = await loadPlayerManifest(options.playerImpl);
  const indexHtml = generateIndexHtml(courseData, playerManifest);

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, 'index.html');
  fs.writeFileSync(outputPath, indexHtml, 'utf8');

  // Persist a durable build-time artifact: broken media assets + broken/missing pages. The build
  // COMPLETES regardless (no hard block) — this is the observable record so a failed asset is never
  // silently dropped (repo I7). Consumed by the deploy gate / the content verifier.
  const brokenOrMissingPages = courseData.pages
    .map((p, i) => ({ p: p, i: i }))
    .filter(function (x) {
      const p = x.p;
      if (p.type === 'html') return !p.htmlBody || !String(p.htmlBody).trim();
      if (p.type === 'selftest') return !p.question || !String(p.question).trim();
      if (p.type === 'quiz') return !Array.isArray(p.questions) || p.questions.length === 0;
      return false;
    })
    .map(function (x) {
      return { index: x.i, id: x.p.id, type: x.p.type, title: x.p.title || null };
    });
  const mediaReportArtifact = {
    courseId: String(courseData.courseId),
    networkId: String(courseData.networkId),
    resolved: mediaReport.totalResolved,
    failed: mediaReport.totalFailed,
    brokenAssets: mediaReport.allFailed.map(function (e) {
      return {
        original: e.original || null,
        action: e.action || null,
        error: e.error || null,
        rootRelative: Boolean(e.unresolvedRootRelative),
      };
    }),
    brokenOrMissingPages: brokenOrMissingPages,
  };
  fs.writeFileSync(
    path.join(outputDir, 'media-report.json'),
    JSON.stringify(mediaReportArtifact, null, 2),
    'utf8'
  );

  return { outputPath: outputPath, courseData: courseData, mediaReport: mediaReport };
}

// CLI execution
if (require.main === module) {
  (async function () {
    const result = await buildPlayer();
    console.log('Player built: ' + result.outputPath);
    console.log('Course: ' + result.courseData.courseName);
    console.log('Pages: ' + result.courseData.totalPages);
    console.log('Sections: ' + result.courseData.sections.length);
    const quizPage = result.courseData.pages.find(function (p) { return p.type === 'quiz'; });
    if (quizPage) {
      console.log('Quiz questions: ' + quizPage.questions.length);
      console.log('Required score: ' + quizPage.requiredScore + '%');
    }

    // Print media resolution report
    console.log('');
    console.log('=== Media Resolution Report ===');
    console.log('Resolved: ' + result.mediaReport.totalResolved);
    console.log('Failed:   ' + result.mediaReport.totalFailed);
    if (result.mediaReport.allResolved.length > 0) {
      console.log('');
      console.log('Resolved items:');
      for (const item of result.mediaReport.allResolved) {
        console.log('  [OK] ' + item.action + ': ' + (item.original || '').substring(0, 80));
        if (item.s3Key) console.log('       -> s3://' + (process.env.S3_BUCKET || 'aaa-courses') + '/' + item.s3Key);
      }
    }
    if (result.mediaReport.allFailed.length > 0) {
      console.log('');
      console.log('FAILED items:');
      for (const item of result.mediaReport.allFailed) {
        console.log('  [FAIL] ' + item.action + ': ' + (item.original || '').substring(0, 80));
        if (item.error) console.log('         Error: ' + item.error);
      }
    }
  })().catch(function (err) {
    console.error('Build failed:', err.message || err);
    process.exit(1);
  });
}

module.exports = {
  buildPlayer: buildPlayer,
  loadCourseData: loadCourseData,
  generateIndexHtml: generateIndexHtml,
  loadPlayerManifest: loadPlayerManifest,
  formatIso8601Duration: formatIso8601Duration
};
