// ScormClient instance
// Any genuine LMS read/write failure (timeout or success:false), across every
// Docebo endpoint, trips the sticky degraded-mode warning. aaaShowDegraded is a
// hoisted declaration below; it self-guards so repeat failures are a no-op.
var scorm = new ScormClient({
  onSendError: function (action, err) { aaaShowDegraded(); }
});
var scormReady = false;

function enforceProductionDefaults(courseData) {
  if (!courseData || typeof courseData !== 'object') return courseData;
  // Production behavior: navigation is locked unless preview explicitly requests otherwise.
  if (courseData.previewUnlockNavigation) {
    courseData.navigationLock = false;
  } else {
    courseData.navigationLock = true;
  }
  delete courseData.previewUnlockNavigation;
  return courseData;
}

// Course data
var courseData = enforceProductionDefaults({{COURSE_DATA_JSON}});
var currentPage = Math.max(0, Math.min((courseData.previewStartPage || 0), Math.max((courseData.pages || []).length - 1, 0)));
var isPreviewMode = Boolean(courseData.previewMode);
var visitedPages = new Set();
var highestVisited = 0;
var quizSubmitted = false;
var quizScore = 0;
var quizAnswers = {};
var quizAttemptCount = 0;
var hasQuiz = courseData.pages.some(function(p) { return p.type === 'quiz'; });
var selftestAnswered = {};
var timerElapsed = 0;
var timerInterval = null;
var timerMetFired = false; // fire the time-gate completion check once (guards against throttled-tick skips)
var quizResolvedQuestions = {};
var quizQuestionStartTimes = {};
var courseCompleted = false;

// ===================================================================
// FLIGHT RECORDER — structured logging for player diagnostics
// ===================================================================
var flightLog = [];
var FLIGHT_LOG_MAX = 500;

function logEvent(category, action, detail) {
  var entry = {
    ts: new Date().toISOString(),
    cat: category,
    act: action,
    ok: true
  };
  if (detail !== undefined) entry.detail = detail;
  if (flightLog.length >= FLIGHT_LOG_MAX) flightLog.shift();
  flightLog.push(entry);
  aaaTeeTelemetry(entry);
  return entry;
}

function logError(category, action, detail) {
  var entry = logEvent(category, action, detail);
  entry.ok = false;
  return entry;
}

window.__aaaPlayerLog = flightLog;

// ===================================================================
// TELEMETRY BEACON — tee the flight recorder to the studio ingest so
// in-the-field failures (lost time, dropped commits, orphaned sessions)
// become observable server-side instead of dying in the closed tab.
// Purely additive: it mirrors the local flight log out over HTTP and
// MUST NEVER throw into the player. Backend: course-editor
// POST /api/telemetry (public, CORS *, body {events:[<=500]}).
// ===================================================================
var AAA_TELEMETRY_ENDPOINT = 'https://editor.aircrewacademy.com/api/telemetry';
var AAA_TELEMETRY_FLUSH_MS = 15000;
var AAA_TELEMETRY_MAX_QUEUE = 1500;
var aaaLearnerId = 'anonymous';
var aaaTelemetryQueue = [];
var aaaTelemetrySeq = 0;
var aaaTelemetryInFlight = false;
var aaaLauncherSeen = 0;
var aaaSessionId = (function () {
  try { if (window.crypto && window.crypto.randomUUID) return 'sess-' + window.crypto.randomUUID(); } catch (e) {}
  return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
})();

// Wall-clock moment the learner opened the book this session (fresh on every page
// load = every "open"). The Course Record shows this alongside "now" so a learner
// can see how long this sitting has run, independent of the active-time timer.
var aaaSessionOpenedAt = new Date();

// Queue the LIVE flight-log entry by reference, so a later ok-flip (logError
// sets ok=false after logEvent has returned) is captured at serialize time.
function aaaTeeTelemetry(entry, source) {
  try {
    if (!entry || !aaaTelemetryQueue || entry.__tid) return;
    aaaTelemetrySeq++;
    entry.__tid = aaaSessionId + '-' + aaaTelemetrySeq;
    entry.__src = source || 'legacy-player';
    aaaTelemetryQueue.push(entry);
    while (aaaTelemetryQueue.length > AAA_TELEMETRY_MAX_QUEUE) aaaTelemetryQueue.shift();
  } catch (e) { /* telemetry must never break the player */ }
}

function aaaSerializeTelemetry(entry) {
  return {
    id: entry.__tid,
    ts: entry.ts || new Date().toISOString(),
    source: entry.__src || 'legacy-player',
    courseId: String((courseData && courseData.courseId) || ''),
    networkId: String((courseData && courseData.networkId) || ''),
    learnerId: String(aaaLearnerId || 'anonymous'),
    sessionId: aaaSessionId,
    cat: String(entry.cat || ''),
    act: String(entry.act || ''),
    ok: entry.ok !== false,
    detail: entry.detail
  };
}

function aaaFlushTelemetry(useKeepalive) {
  if (aaaTelemetryInFlight || !aaaTelemetryQueue.length) return;
  var batch = aaaTelemetryQueue.splice(0, 500); // batch cap per TelemetryBatchSchema
  var body;
  try { body = JSON.stringify({ events: batch.map(aaaSerializeTelemetry) }); }
  catch (e) { return; }
  aaaTelemetryInFlight = true;
  try {
    fetch(AAA_TELEMETRY_ENDPOINT, {
      method: 'POST',
      keepalive: !!useKeepalive,
      headers: { 'Content-Type': 'application/json' },
      body: body
    }).then(function () {
      aaaTelemetryInFlight = false;
      if (aaaTelemetryQueue.length) aaaFlushTelemetry(false);
    }).catch(function () {
      aaaTelemetryInFlight = false;
      aaaTelemetryQueue = batch.concat(aaaTelemetryQueue); // requeue (bounded) for retry
      while (aaaTelemetryQueue.length > AAA_TELEMETRY_MAX_QUEUE) aaaTelemetryQueue.shift();
      aaaShowDegraded(); // a telemetry POST failed — surface the keep-a-copy warning
    });
  } catch (e) {
    aaaTelemetryInFlight = false;
    aaaTelemetryQueue = batch.concat(aaaTelemetryQueue);
  }
}

// SCORM SetValue/Commit/Terminate + session_time live in the LAUNCHER's flight
// recorder, not the player. Pull it over the existing bridge and tee new entries
// — this is where the time-recording evidence actually is.
function aaaHarvestLauncher() {
  try {
    if (!scorm || typeof scorm.getFlightLog !== 'function') return;
    scorm.getFlightLog().then(function (log) {
      if (!log || !log.length) return;
      for (; aaaLauncherSeen < log.length; aaaLauncherSeen++) {
        aaaTeeTelemetry(log[aaaLauncherSeen], 'launcher');
      }
    }).catch(function () { /* ignore */ });
  } catch (e) { /* ignore */ }
}

if (typeof setInterval === 'function') {
  setInterval(function () { aaaHarvestLauncher(); aaaFlushTelemetry(false); }, AAA_TELEMETRY_FLUSH_MS);
}

// ===================================================================
// PROACTIVE LEARNER SAFEGUARDS (SANDBOX TEST — not for production yet)
//   1. Degraded-state banner: a sticky yellow notice shown the first time a
//      telemetry POST or a SCORM save/commit fails. If everything works, it
//      never appears.
//   2. Completion safety copy: auto-download a plain-text record of the
//      learner's results when the course completes. (A true screenshot can't be
//      auto-taken in an iframe; a text record is the practical personal copy.
//      The download may be blocked by Docebo's iframe sandbox — that's what
//      this test checks.)
// ===================================================================
var aaaDegraded = false;
function aaaShowDegraded() {
  if (aaaDegraded) return;            // sticky: show once, keep for the session
  aaaDegraded = true;
  try {
    var box = document.createElement('div');
    box.id = 'aaa-degraded-banner';
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;top:12px;right:12px;max-width:340px;z-index:2147483647;background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-left:4px solid #9ca3af;border-radius:8px;padding:11px 13px;font:600 13px/1.45 system-ui,Arial,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.15);';
    var l1 = document.createElement('div');
    l1.textContent = 'Our progress tracker is experiencing some intermittent technical difficulties.';
    var l2 = document.createElement('div');
    l2.style.cssText = 'margin-top:8px;';
    l2.textContent = 'Please consider taking a screenshot of your exam results as a personal copy, just in case.';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Save copy';
    btn.style.cssText = 'margin-top:10px;background:#f59e0b;color:#422006;border:1px solid #d97706;border-radius:6px;padding:6px 12px;font:600 12px system-ui,Arial,sans-serif;cursor:pointer;transition:background .12s;';
    btn.onmouseover = function () { btn.style.background = '#d97706'; btn.style.borderColor = '#b45309'; };
    btn.onmouseout = function () { btn.style.background = '#f59e0b'; btn.style.borderColor = '#d97706'; };
    btn.onclick = function () { aaaOpenSnapshot(); };
    box.appendChild(l1);
    box.appendChild(l2);
    box.appendChild(btn);
    (document.body || document.documentElement).appendChild(box);
  } catch (e) { /* a warning must never break the player */ }
}

function aaaEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
  });
}

// Turn source HTML (which may carry tags and entities like &nbsp;) into clean plain
// text: the browser decodes entities + drops tags via textContent. Pair with aaaEsc()
// before inserting into the snapshot markup.
function aaaPlain(s) {
  var d = document.createElement('div');
  d.innerHTML = (s == null ? '' : String(s));
  return (d.textContent || '').replace(/\s+/g, ' ').trim();
}

// Open a complete local-state SNAPSHOT in a new tab (downloads + script-print are blocked
// by Docebo's sandboxed iframe, but opening a top-level tab is allowed). The learner can
// then save-as-PDF / print / screenshot that clean page. More informative than a screenshot —
// it carries the full state: identity, progress, page X/Y, time, score, and per-question results.
function aaaOpenSnapshot() {
  try {
    // A small, distinct popup window (not a browser tab). Passing size + popup features
    // makes Chrome/Edge open a separate window; the named target reuses it on re-click.
    var win = window.open('', 'aaaCourseRecord', 'popup=yes,width=560,height=740,scrollbars=yes,resizable=yes');
    if (!win) return; // popup blocked
    var pct = courseData.totalPages ? Math.round((visitedPages.size / courseData.totalPages) * 100) : 0;
    var mm = Math.floor(timerElapsed / 60), ss = timerElapsed % 60;
    var quizPage = hasQuiz ? courseData.pages.find(function (p) { return p.type === 'quiz'; }) : null;
    var reqScore = quizPage ? quizPage.requiredScore : null;
    var passed = hasQuiz && quizSubmitted && reqScore != null && quizScore >= reqScore;
    var rows = '';
    if (quizPage) {
      var qs = resolveQuizQuestions(quizPage);
      qs.forEach(function (q, qi) {
        var ans = q.answers || [];
        var li = quizAnswers[qi];
        var chose = (li !== undefined && ans[li]) ? aaaPlain(ans[li].text) : '(no answer)';
        var correct = (li !== undefined && ans[li]) ? !!ans[li].correct : false;
        var correctAns = '';
        for (var k = 0; k < ans.length; k++) { if (ans[k].correct) { correctAns = aaaPlain(ans[k].text); break; } }
        var qtext = aaaEsc(aaaPlain(q.question).slice(0, 140));
        var res = (li === undefined) ? '—' : (correct ? 'Correct' : 'Incorrect');
        var col = (li === undefined) ? '#666' : (correct ? '#15803d' : '#b91c1c');
        rows += '<tr><td>' + (qi + 1) + '</td><td>' + qtext + '</td><td>' + aaaEsc(chose) +
          '</td><td style="color:' + col + ';font-weight:700">' + res + '</td><td>' +
          (correct || li === undefined ? '' : aaaEsc(correctAns)) + '</td></tr>';
      });
    }
    var h = [];
    h.push('<!doctype html><html><head><meta charset="utf-8"><title>Course Record - ' + aaaEsc(courseData.courseName || courseData.courseId) + '</title>');
    h.push('<style>body{font:14px/1.5 system-ui,Arial,sans-serif;color:#111;margin:0;padding:28px;max-width:840px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}.muted{color:#666;font-size:13px}.kv{display:grid;grid-template-columns:150px 1fr;gap:5px 12px;margin:8px 0}.kv div:nth-child(odd){color:#666}table{border-collapse:collapse;width:100%;font-size:13px;margin-top:6px}th,td{border:1px solid #e2e2e2;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f7f7f7}.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:700;font-size:12px}.ok{background:#dcfce7;color:#15803d}.no{background:#fee2e2;color:#b91c1c}.tip{margin:14px 0;padding:10px 12px;background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;font-size:13px}@media print{.noprint{display:none}}</style>');
    h.push('</head><body>');
    h.push('<h1>Advanced Aircrew Academy &mdash; Course Record</h1>');
    var aaaNow = new Date();
    var aaaSitMin = Math.max(0, Math.floor((aaaNow - aaaSessionOpenedAt) / 60000));
    var aaaSitStr = (aaaSitMin >= 60 ? Math.floor(aaaSitMin / 60) + 'h ' : '') + (aaaSitMin % 60) + 'm';
    h.push('<div class="muted">Personal copy generated ' + aaaEsc(aaaNow.toString()) + '</div>');
    h.push('<div class="tip noprint">The print / save-as-PDF dialog should open automatically. If it doesn&rsquo;t, press <b>Ctrl/Cmd + P</b>, use the button, or just take a screenshot of this page. <button onclick="window.print()" style="margin-left:8px;background:#4b5563;color:#fff;border:0;border-radius:6px;padding:5px 11px;font-weight:700;cursor:pointer">Print / Save as PDF</button></div>');
    h.push('<h2>Course</h2><div class="kv">');
    h.push('<div>Course</div><div>' + aaaEsc(courseData.courseName || courseData.courseId) + '</div>');
    h.push('<div>Course ID</div><div>' + aaaEsc(courseData.courseId) + '</div>');
    h.push('<div>Network</div><div>' + aaaEsc(courseData.networkId) + '</div>');
    h.push('<div>Learner</div><div>' + aaaEsc(aaaLearnerId) + '</div>');
    h.push('<div>Session</div><div>' + aaaEsc(aaaSessionId) + '</div>');
    h.push('<div>Status</div><div><span class="badge ' + (courseCompleted ? 'ok">Completed' : 'no">In progress') + '</span></div>');
    h.push('</div><h2>Progress</h2><div class="kv">');
    h.push('<div>Page</div><div>' + (currentPage + 1) + ' / ' + courseData.totalPages + '</div>');
    h.push('<div>Pages visited</div><div>' + visitedPages.size + ' / ' + courseData.totalPages + ' (' + pct + '%)</div>');
    h.push('<div>Time on course</div><div>' + mm + 'm ' + ss + 's</div>');
    if (hasQuiz) h.push('<div>Exam score</div><div>' + quizScore + '%' + (reqScore != null ? ' (need ' + reqScore + '%) &mdash; <span class="badge ' + (passed ? 'ok">Pass' : 'no">Not yet') + '</span>' : '') + '</div>');
    h.push('</div>');
    h.push('<h2>This sitting</h2><div class="kv">');
    h.push('<div>Opened the course</div><div>' + aaaEsc(aaaSessionOpenedAt.toLocaleString()) + '</div>');
    h.push('<div>Snapshot taken</div><div>' + aaaEsc(aaaNow.toLocaleString()) + '</div>');
    h.push('<div>Elapsed this sitting</div><div>' + aaaEsc(aaaSitStr) + '</div>');
    h.push('</div>');
    if (rows) h.push('<h2>Exam questions</h2><table><thead><tr><th>#</th><th>Question</th><th>Your answer</th><th>Result</th><th>Correct answer</th></tr></thead><tbody>' + rows + '</tbody></table>');
    // Go straight to the print / save-as-PDF dialog (this window is a top-level, non-sandboxed
    // context, unlike the course iframe). Tab is left open afterward so the learner can also
    // screenshot or re-print; we deliberately do NOT auto-close on cancel.
    h.push('<script>window.addEventListener("load",function(){window.onafterprint=function(){try{window.close();}catch(e){}};setTimeout(function(){try{window.focus();window.print();}catch(e){}},250);});<\/script>');
    h.push('</body></html>');
    win.document.open();
    win.document.write(h.join(''));
    win.document.close();
  } catch (e) { /* snapshot/popup failed */ }
}

// Global error handlers. In an embedded iframe the flight-recorder log is
// invisible during a real session, so logging alone is a silent failure. Any
// uncaught error or rejection is by definition off the happy path — surface it
// to the learner via the sticky degraded banner (self-guards against repeats).
window.onerror = function(msg, source, line, col, error) {
  logError('global', 'onerror', {
    msg: String(msg).substring(0, 300),
    source: String(source || '').substring(0, 100),
    line: line, col: col
  });
  aaaShowDegraded();
  return false;
};
window.onunhandledrejection = function(event) {
  var reason = event && event.reason;
  logError('global', 'unhandledrejection', {
    msg: reason ? String(reason.message || reason).substring(0, 300) : 'unknown'
  });
  aaaShowDegraded();
};

logEvent('player', 'init', {
  courseId: courseData.courseId,
  networkId: courseData.networkId,
  totalPages: courseData.totalPages,
  minimumTimeSeconds: courseData.minimumTimeSeconds,
  hasQuiz: hasQuiz
});

{{FORMAT_ISO8601_DURATION}}

// Build page ID → index map for reference page lookups
var pageIdToIndex = {};
courseData.pages.forEach(function(p, i) { pageIdToIndex[p.id] = i; });
delete courseData.previewStartPage;
delete courseData.previewMode;

function findPreviousContentPageId(fromIndex) {
  for (var i = fromIndex - 1; i >= 0; i--) {
    var candidate = courseData.pages[i];
    if (candidate && candidate.type === 'html') return candidate.id;
  }
  return '';
}

function resolveReferencePageId(primaryId, pageIndex) {
  // '0' is Ascent's sentinel for "no reference" — respect the author's intent
  // rather than silently falling back to the previous content page (which was
  // landing exam questions on the "Ready for the Exam?" page).
  if (primaryId === '0' || primaryId === 0) return null;
  if (primaryId && pageIdToIndex[primaryId] !== undefined) return primaryId;
  return findPreviousContentPageId(pageIndex);
}

function openRefPageModal(refPageId) {
  var idx = pageIdToIndex[refPageId];
  if (idx === undefined) return;
  var refPage = courseData.pages[idx];
  if (!refPage) return;
  document.getElementById('ref-page-title').textContent = refPage.title || 'Reference Page';
  var body = '';
  if (refPage.type === 'html' && refPage.htmlBody) {
    body = refPage.htmlBody;
  } else if (refPage.type === 'selftest') {
    body = '<p>' + (refPage.question || '') + '</p>';
  } else {
    body = '<p>Page ' + refPage.pageNumber + ': ' + escapeHtml(refPage.title || '') + '</p>';
  }
  document.getElementById('ref-page-body').innerHTML = body;
  document.getElementById('ref-page-overlay').classList.add('active');
  // Fix media URLs inside the modal
  var modalBody = document.getElementById('ref-page-body');
  var imgs = modalBody.querySelectorAll('img[src*="X-Amz-"]');
  for (var i = 0; i < imgs.length; i++) { imgs[i].src = stripPresignedParams(imgs[i].src); }
}

function closeRefPageModal() {
  document.getElementById('ref-page-overlay').classList.remove('active');
}

function openRefsModal() {
  var body = document.getElementById('refs-modal-body');
  var page = courseData.pages[currentPage];
  var refs = (page && page.references) || [];
  if (!refs.length) {
    body.innerHTML = '<div class="empty">This page has no reference documents.</div>';
  } else {
    var html = '';
    for (var i = 0; i < refs.length; i++) {
      var r = refs[i];
      var href = r.url || r.file || '';
      var name = r.name || 'Download';
      if (!href) continue;
      html += '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener">' + escapeHtml(name) + '</a>';
    }
    body.innerHTML = html;
  }
  document.getElementById('refs-modal-overlay').classList.add('active');
}

function closeRefsModal() {
  document.getElementById('refs-modal-overlay').classList.remove('active');
}

// Show the "Reference Documents" button only when the current page has
// attachments (Alvin 2026-04-22 — legacy shows a paper-clip only on pages
// with references; we follow suit). Also hidden during an active exam so a
// student can't look up answers mid-test.
function updateRefsBtnVisibility() {
  var btn = document.getElementById('refs-btn');
  if (!btn) return;
  var page = courseData.pages[currentPage];
  var pageHasRefs = page && page.references && page.references.length > 0;
  if (!pageHasRefs) { btn.style.display = 'none'; return; }
  var inActiveExam = page.type === 'quiz' && !quizSubmitted;
  btn.style.display = inActiveExam ? 'none' : '';
}

// Init
document.getElementById('course-title-sidebar').textContent = courseData.courseName;
updateRefsBtnVisibility();

// Initialize ScormClient and restore state if resuming
scorm.init().then(function(session) {
  scormReady = true;

  logEvent('scorm', 'session', {
    connected: session.connected,
    entry: session.entry,
    completionStatus: session.completionStatus,
    successStatus: session.successStatus,
    location: session.location,
    hasSuspendData: !!session.suspendData,
    suspendDataLength: session.suspendData ? session.suspendData.length : 0,
    learnerName: session.learnerName,
    standalone: scorm.isStandalone()
  });

  // If we're embedded in an LMS (nested in a parent frame) but the handshake
  // never connected, we're silently in standalone mode — nothing the learner
  // does will persist to Docebo. Direct S3 previews are top-level (parent ===
  // self), so they don't trip this.
  if (scorm.isStandalone() && window.parent !== window) {
    aaaShowDegraded(); // expected a launcher but none answered — saves will be lost
  }

  // Telemetry identity + session-open marker (the orphaned-session anomaly
  // detector pairs this 'session/start' with the 'session/close' on unload).
  aaaLearnerId = session.learnerId || session.learnerName || aaaLearnerId;
  logEvent('session', 'start', {
    entry: session.entry,
    completionStatus: session.completionStatus,
    standalone: scorm.isStandalone()
  });

  // Detect fresh enrollment: entry is 'ab-initio' AND completion is 'not attempted'.
  // This catches Archive/Re-Enroll (Docebo resets completion but may keep stale suspend_data)
  // while preserving normal resume. We restore by default — only skip on confirmed fresh start.
  // Note: Docebo production may not set cmi.entry='resume' on returning learners,
  // so we cannot gate restore on entry==='resume'.
  var isFreshEnrollment = session.entry === 'ab-initio' &&
                          session.completionStatus === 'not attempted';

  if (isFreshEnrollment) {
    logEvent('restore', 'skip', 'fresh enrollment detected');
  }

  // Restore suspend data first (visited pages + quiz state + selftest + timer + page)
  var suspendRestoreOk = false;
  if (!isPreviewMode && !isFreshEnrollment && session.suspendData) {
    try {
      var saved = JSON.parse(session.suspendData);
      logEvent('restore', 'parsed', {
        hasVisitedPages: !!(saved.visitedPages && saved.visitedPages.length),
        visitedCount: saved.visitedPages ? saved.visitedPages.length : 0,
        savedTimerElapsed: saved.timerElapsed || 0,
        savedCurrentPage: saved.currentPage,
        quizSubmitted: !!saved.quizSubmitted,
        courseCompleted: !!saved.courseCompleted
      });
      if (saved.visitedPages && Array.isArray(saved.visitedPages)) {
        saved.visitedPages.forEach(function(idx) { visitedPages.add(idx); });
        highestVisited = Math.max.apply(null, [0].concat(saved.visitedPages));
      }
      // Restore in-progress exam answers UNCONDITIONALLY. The autosave always
      // persists quizAnswers (whether or not the exam was submitted), so a
      // learner whose submit/completion was lost resumes mid-exam with prior
      // answers pre-filled (renderQuiz reads quizAnswers to pre-select options).
      // quizSubmitted / quizScore stay gated on an ACTUAL prior submission so we
      // never fake a submitted-or-scored state for an un-submitted attempt.
      if (saved.quizAnswers) {
        quizAnswers = saved.quizAnswers || {};
      }
      if (saved.quizSubmitted) {
        quizSubmitted = saved.quizSubmitted;
        quizScore = saved.quizScore || 0;
      }
      if (saved.quizAttemptCount) {
        quizAttemptCount = saved.quizAttemptCount || 0;
      }
      if (saved.selftestAnswered) {
        selftestAnswered = saved.selftestAnswered;
      }
      if (saved.timerElapsed) {
        timerElapsed = saved.timerElapsed;
      }
      if (saved.quizResolvedQuestions) {
        quizResolvedQuestions = saved.quizResolvedQuestions;
      }
      if (saved.quizQuestionStartTimes) {
        quizQuestionStartTimes = saved.quizQuestionStartTimes;
      }
      if (saved.courseCompleted) {
        courseCompleted = true;
      }
      // Restore page position from suspend data (primary source)
      if (typeof saved.currentPage === 'number' && saved.currentPage >= 0 && saved.currentPage < courseData.pages.length) {
        currentPage = saved.currentPage;
        suspendRestoreOk = true;
      }
      logEvent('restore', 'complete', {
        timerElapsed: timerElapsed,
        currentPage: currentPage,
        visitedPages: visitedPages.size,
        highestVisited: highestVisited
      });
    } catch(e) {
      // Could not parse stored state — mark unsafe so we never overwrite the
      // (possibly recoverable) stored blob with a blank snapshot.
      safeToPersist = false;
      logError('restore', 'corrupt-suspend-data', {
        error: e.message,
        dataLength: session.suspendData ? session.suspendData.length : 0,
        dataPreview: session.suspendData ? session.suspendData.substring(0, 200) : ''
      });
    }
  }

  // cmi.location is a FALLBACK only — use it when suspend_data didn't
  // provide a valid currentPage. Previously this always overwrote the
  // suspend_data value, which caused state mismatch when suspend_data
  // was lost but cmi.location survived (learner lands on the right page
  // but with empty visitedPages and timerElapsed = 0).
  if (!isPreviewMode && !isFreshEnrollment && session.location && !suspendRestoreOk) {
    var pg = parseInt(session.location, 10);
    if (!isNaN(pg) && pg >= 0 && pg < courseData.pages.length) {
      currentPage = pg;
    }
  }

  // Final fallback: if we have visited pages but currentPage is still 0,
  // resume at highestVisited (handles old suspend data without currentPage)
  if (!isPreviewMode && currentPage === 0 && highestVisited > 0) {
    currentPage = highestVisited;
  }

  // Only set incomplete for brand-new attempts (no prior progress)
  if (visitedPages.size <= 1) {
    // Sequence: flush only after the status write round-trips the bridge.
    scorm.setCompletionStatus('incomplete').then(function() { return scorm.commit(); });
  }

  // Restore courseCompleted flag from completion status
  if (session.completionStatus === 'completed') {
    courseCompleted = true;
  }

  buildSidebar();
  renderPage();
}).catch(function(err) {
  logError('scorm', 'init-failed', err ? err.message : 'unknown');
  // Even on error, render the content
  buildSidebar();
  renderPage();
});

var suspendSaveCount = 0;
var suspendSaveErrorCount = 0;
// Safety: if restore could NOT read the stored suspend_data (corrupt/parse
// failure), do NOT let saveSuspendData() overwrite it with a blank snapshot —
// preserve whatever is stored for recovery. "If you're blind, don't overwrite."
var safeToPersist = true;

function saveSuspendData() {
  // Don't persist until SCORM init has completed and state has been restored.
  // The initial renderPage() fires before init resolves — saving here would
  // overwrite the LMS's stored progress with a blank slate.
  if (!scormReady) return Promise.resolve();
  // Don't overwrite stored data we failed to read on restore (see safeToPersist).
  if (!safeToPersist) {
    logError('suspend', 'skip-unsafe-overwrite', { reason: 'restore could not read stored data; preserving it' });
    return Promise.resolve();
  }
  var state = {
    currentPage: currentPage,
    visitedPages: Array.from(visitedPages),
    quizSubmitted: quizSubmitted,
    quizScore: quizScore,
    quizAnswers: quizAnswers,
    quizAttemptCount: quizAttemptCount,
    selftestAnswered: selftestAnswered,
    timerElapsed: timerElapsed,
    quizResolvedQuestions: quizResolvedQuestions,
    quizQuestionStartTimes: quizQuestionStartTimes,
    courseCompleted: courseCompleted
  };
  var json = JSON.stringify(state);
  suspendSaveCount++;
  return scorm.setSuspendData(json).then(function() {
    // Log every 10th save or first save to reduce noise
    if (suspendSaveCount === 1 || suspendSaveCount % 10 === 0) {
      logEvent('suspend', 'save', {
        seq: suspendSaveCount,
        bytes: json.length,
        timerElapsed: timerElapsed,
        page: currentPage,
        visited: visitedPages.size
      });
    }
  }).catch(function(err) {
    suspendSaveErrorCount++;
    logError('suspend', 'save-failed', {
      seq: suspendSaveCount,
      errorCount: suspendSaveErrorCount,
      error: err ? err.message : 'unknown',
      timerElapsed: timerElapsed,
      page: currentPage
    });
    aaaShowDegraded(); // a SCORM save failed — genuine risk to the saved record
  });
}

function checkCompletion() {
  if (courseCompleted) return; // Already completed, don't re-fire

  var allVisited = visitedPages.size >= courseData.totalPages;
  var timerMet = !courseData.minimumTimeSeconds || timerElapsed >= courseData.minimumTimeSeconds;

  if (!timerMet) {
    document.getElementById('timer-gate-msg').style.display = allVisited ? 'block' : 'none';
    return;
  }
  document.getElementById('timer-gate-msg').style.display = 'none';

  var shouldComplete = false;
  if (hasQuiz) {
    var quizPage = courseData.pages.find(function(p) { return p.type === 'quiz'; });
    var passed = quizSubmitted && quizScore >= quizPage.requiredScore;
    if (allVisited && passed) shouldComplete = true;
  } else {
    if (allVisited) shouldComplete = true;
  }

  logEvent('completion', 'check', {
    allVisited: allVisited,
    timerMet: timerMet,
    timerElapsed: timerElapsed,
    minimumTimeSeconds: courseData.minimumTimeSeconds,
    visitedPages: visitedPages.size,
    totalPages: courseData.totalPages,
    quizSubmitted: quizSubmitted,
    quizScore: quizScore,
    shouldComplete: shouldComplete
  });

  if (shouldComplete) {
    courseCompleted = true;
    logEvent('completion', 'marking-complete', { timerElapsed: timerElapsed, visitedPages: visitedPages.size });
    // Sequence the LMS writes: completion status, then suspend data, THEN commit.
    // commit() flushes to Docebo, so it must run only after the preceding writes
    // have round-tripped the postMessage bridge — otherwise Docebo persists a
    // stale snapshot missing the just-earned completion (OP-462/463/464).
    scorm.setCompletionStatus('completed').then(function() {
      logEvent('completion', 'status-set', 'completed');
      return saveSuspendData();
    }).then(function() {
      return scorm.commit();
    }).then(function() {
      logEvent('completion', 'commit', 'ok');
    }).catch(function(err) {
      logError('completion', 'commit-failed', err ? err.message : 'unknown');
      aaaShowDegraded(); // commit to the LMS failed — warn the learner
    });
  }
}

function buildSidebar() {
  var nav = document.getElementById('sidebar-nav');
  nav.innerHTML = '';
  courseData.sections.forEach(function(section) {
    var label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = section.name;
    nav.appendChild(label);
    section.pageIds.forEach(function(pid) {
      var page = courseData.pages.find(function(p) { return p.id === pid; });
      if (!page) return;
      var idx = courseData.pages.indexOf(page);
      var item = document.createElement('div');
      item.className = 'nav-item';
      if (idx === currentPage) item.classList.add('active');
      if (visitedPages.has(idx)) item.classList.add('visited');
      var canNav = !courseData.navigationLock || idx <= highestVisited;
      if (!canNav) item.classList.add('locked');
      var icon = page.type === 'selftest' ? '?' : page.type === 'quiz' ? '\u2713' : '\u25CB';
      item.innerHTML = '<span class="icon">' + icon + '</span><span class="page-num">' + page.pageNumber + '</span>' + escapeHtml(page.title);
      if (canNav) {
        item.onclick = (function(i) { return function() { goToPage(i); }; })(idx);
      }
      nav.appendChild(item);
    });
  });
}

function escapeHtml(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderPage() {
  var page = courseData.pages[currentPage];
  visitedPages.add(currentPage);
  if (currentPage > highestVisited) highestVisited = currentPage;
  logEvent('nav', 'page', { index: currentPage, type: page.type, visited: visitedPages.size, highest: highestVisited });

  document.getElementById('page-info').textContent = 'Page ' + page.pageNumber + ' of ' + courseData.totalPages;
  document.getElementById('page-title-bar').textContent = page.title;

  var content = document.getElementById('content-inner');

  if (page.type === 'html') {
    content.innerHTML = '<div class="page-content">' + page.htmlBody + '</div>';
  } else if (page.type === 'selftest') {
    renderSelftest(content, page);
  } else if (page.type === 'quiz') {
    renderQuiz(content, page);
  }
  updateRefsBtnVisibility();

  // Selftest gating: immediately gate Next when landing on unanswered selftest
  if (courseData.navigationLock && page.type === 'selftest' && !selftestAnswered[currentPage]) {
    document.getElementById('selftest-gate-msg').style.display = 'block';
    document.getElementById('next-btn').classList.add('gated');
  } else {
    document.getElementById('selftest-gate-msg').style.display = 'none';
    document.getElementById('next-btn').classList.remove('gated');
  }

  // Update nav buttons
  document.getElementById('prev-btn').disabled = currentPage === 0;
  var isLast = currentPage === courseData.pages.length - 1;
  var nextBtn = document.getElementById('next-btn');
  if (isLast) {
    nextBtn.disabled = false;
    nextBtn.textContent = 'Submit Module \u2713';
    nextBtn.classList.add('submit-btn');
    nextBtn.onclick = function() { completeModule(); };
  } else {
    nextBtn.textContent = 'Next \u25B6';
    nextBtn.classList.remove('submit-btn');
    nextBtn.onclick = function() { nextPage(); };
  }

  // Update sidebar
  buildSidebar();
  updateProgress();

  // SCORM bookmark + suspend data. Sequence so commit() flushes AFTER the
  // suspend write round-trips the bridge — otherwise commit can persist a
  // stale snapshot (the OP-462 class of bug).
  if (scormReady) {
    scorm.setLocation(String(currentPage));
  }
  saveSuspendData().then(function() {
    if (scormReady) { scorm.commit(); }
  });

  // Scroll to top
  document.getElementById('content-area').scrollTop = 0;

  // Fix any presigned URLs in the rendered content
  fixPresignedUrls();
  upgradeLegacyVideoSources();
  applyNoReferrerMedia();

  // Fix broken media URLs where %20 was stored literally in the S3 key.
  // The browser decodes %20→space, which doesn't match the S3 key.
  // Re-encode to %2520 so S3 receives the literal %20.
  fixEncodedMediaUrls();

  // Auto-play first video on the page (matches Ascent behavior)
  var videos = document.querySelectorAll('#content-inner video');
  if (videos.length > 0) {
    videos[0].play().catch(function() { /* autoplay blocked by browser — ignore */ });
  }
}

function renderSelftest(container, page) {
  var referencePageId = resolveReferencePageId(page.refPageId, currentPage);
  var html = '<div class="selftest-container">';
  html += '<div class="selftest-question">' + page.question + '</div>';
  page.answers.forEach(function(ans, i) {
    html += '<div class="answer-option" data-idx="' + i + '" onclick="checkSelftestAnswer(this, ' + i + ', ' + ans.correct + ')">';
    html += '<div class="radio"></div>';
    html += '<div>' + escapeHtml(ans.text) + '</div>';
    html += '</div>';
  });
  html += '<div id="selftest-feedback"></div>';
  if (referencePageId) {
    html += '<button id="selftest-ref-btn" class="view-ref-btn" style="display:none" onclick="openRefPageModal(\'' + referencePageId + '\')">&#128196; View Reference Page</button>';
  }
  html += '</div>';
  container.innerHTML = html;
}

function checkSelftestAnswer(el, idx, correct) {
  // Reset previous selections
  var options = el.parentElement.querySelectorAll('.answer-option');
  options.forEach(function(opt) {
    opt.classList.remove('correct', 'incorrect');
    opt.style.pointerEvents = '';
  });

  // Reveal View Reference Page button on first attempt (right or wrong)
  var refBtn = document.getElementById('selftest-ref-btn');
  if (refBtn) refBtn.style.display = '';

  if (correct) {
    // Only unblock Next when the correct answer is selected
    selftestAnswered[currentPage] = true;
    document.getElementById('selftest-gate-msg').style.display = 'none';
    document.getElementById('next-btn').classList.remove('gated');
    saveSuspendData();
    el.classList.add('correct');
    document.getElementById('selftest-feedback').innerHTML = '<div class="correct-text">Correct!</div>';
  } else {
    el.classList.add('incorrect');
    var hint = courseData.pages[currentPage].answers[idx].hint;
    var fb = hint ? '<div class="hint-text">' + escapeHtml(hint) + '</div>' : '<div class="hint-text">That\'s not correct. Try again.</div>';
    document.getElementById('selftest-feedback').innerHTML = fb;
    // Re-enable answer options so the learner can try again
    options.forEach(function(opt) { opt.style.pointerEvents = ''; });
  }
}

function resolveQuizQuestions(page) {
  // Resolve random pool questions to concrete questions for this attempt.
  // When questionDrawCount is set, treat all random-bank entries as a shared
  // pool and draw that many questions. Otherwise keep the old one-per-slot behavior.
  var explicitQuestions = [];
  var pooledQuestions = [];

  page.questions.forEach(function(q, qi) {
    if (q.questionType === 'random' && q.pool && q.pool.length > 0) {
      q.pool.forEach(function(poolQuestion, pi) {
        pooledQuestions.push({
          key: qi + ':' + pi,
          value: poolQuestion,
        });
      });
    } else if (q.question !== undefined) {
      explicitQuestions.push(q);
    }
  });

  var drawCount = parseInt(page.questionDrawCount || 0, 10);
  if (drawCount > 0 && pooledQuestions.length > 0) {
    if (!Array.isArray(quizResolvedQuestions.__drawCount) || quizResolvedQuestions.__drawCount.length !== Math.min(drawCount, pooledQuestions.length)) {
      var availableIndexes = pooledQuestions.map(function(_, index) { return index; });
      var pickedIndexes = [];
      while (pickedIndexes.length < Math.min(drawCount, pooledQuestions.length) && availableIndexes.length) {
        var pickAt = Math.floor(Math.random() * availableIndexes.length);
        pickedIndexes.push(availableIndexes.splice(pickAt, 1)[0]);
      }
      quizResolvedQuestions.__drawCount = pickedIndexes;
    }
    return explicitQuestions.concat(quizResolvedQuestions.__drawCount.map(function(index) {
      return pooledQuestions[index].value;
    }));
  }

  var resolved = explicitQuestions.slice();
  page.questions.forEach(function(q, qi) {
    if (q.questionType === 'random' && q.pool && q.pool.length > 0) {
      if (quizResolvedQuestions[qi] !== undefined) {
        var savedIdx = quizResolvedQuestions[qi];
        if (savedIdx >= 0 && savedIdx < q.pool.length) {
          resolved.push(q.pool[savedIdx]);
          return;
        }
      }
      var pickIdx = Math.floor(Math.random() * q.pool.length);
      quizResolvedQuestions[qi] = pickIdx;
      resolved.push(q.pool[pickIdx]);
    }
  });
  return resolved;
}

function renderQuiz(container, page) {
  if (quizSubmitted) {
    renderQuizResults(container, page);
    return;
  }

  var questions = resolveQuizQuestions(page);
  initializeQuizQuestionStartTimes(questions);
  saveSuspendData();

  var html = '<div class="quiz-container">';
  html += '<div class="quiz-header"><h2>Final Exam</h2><p>' + questions.length + ' questions &bull; ' + page.requiredScore + '% to pass</p></div>';
  // Map resolved questions back to original question data to get refPageId
  var origQuestions = page.questions || [];
  questions.forEach(function(q, qi) {
    html += '<div class="quiz-question" data-qi="' + qi + '">';
    html += '<div class="quiz-q-num">Question ' + (qi + 1) + '</div>';
    html += '<div class="quiz-q-text">' + (q.question || '') + '</div>';
    if (q.answers && q.answers.length > 0) {
      q.answers.forEach(function(a, ai) {
        var sel = quizAnswers[qi] === ai ? ' selected' : '';
        html += '<div class="quiz-answer' + sel + '" onclick="selectQuizAnswer(' + qi + ',' + ai + ')">' + escapeHtml(a.text) + '</div>';
      });
    }
    // View Reference Page button is intentionally hidden during the exam —
    // reference pages would let the user look up the correct answer mid-exam.
    // The same button IS rendered in renderQuizResults after submit, where
    // reviewing references is the whole point.
    html += '</div>';
  });
  html += '<button id="quiz-submit" onclick="submitQuiz()">Submit Exam</button>';
  html += '<div id="quiz-result-area"></div>';
  html += '</div>';
  container.innerHTML = html;
}

function initializeQuizQuestionStartTimes(questions) {
  var now = Date.now();
  if (!quizQuestionStartTimes || typeof quizQuestionStartTimes !== 'object') {
    quizQuestionStartTimes = {};
  }
  questions.forEach(function(_, qi) {
    if (quizQuestionStartTimes[qi] === undefined) {
      quizQuestionStartTimes[qi] = now;
    }
  });
}

function stripInteractionText(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function trimInteractionText(value, maxLength) {
  var text = stripInteractionText(value);
  if (!maxLength || text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '...';
}

function scormInteractionToken(value, fallback) {
  var token = stripInteractionText(value || fallback || '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return token || fallback || 'item';
}

function getInteractionQuestionId(page, question, qi, attemptNumber) {
  var pageId = scormInteractionToken(page && page.id, 'quiz');
  var questionId = scormInteractionToken(
    question && question.id !== undefined && question.id !== null && String(question.id) !== '' ? question.id : null,
    'q' + (qi + 1)
  );
  return 'quiz_' + pageId + '_attempt_' + attemptNumber + '_' + questionId;
}

function getAnswerInteractionValue(answer, ai) {
  if (answer && answer.text !== undefined && answer.text !== null && String(answer.text) !== '') {
    return trimInteractionText(answer.text, 250);
  }
  if (answer && answer.id !== undefined && answer.id !== null && String(answer.id) !== '') {
    return String(answer.id);
  }
  return 'Choice ' + (ai + 1);
}

function emitQuizInteractions(page, questions, submittedAt, attemptNumber) {
  if (!scorm || typeof scorm.setInteraction !== 'function') return;

  questions.forEach(function(q, qi) {
    var selectedIdx = quizAnswers[qi];
    var answers = (q && q.answers) || [];
    var selectedAnswer = selectedIdx !== undefined ? answers[selectedIdx] : null;
    var startedAt = quizQuestionStartTimes && quizQuestionStartTimes[qi] !== undefined ? Number(quizQuestionStartTimes[qi]) : submittedAt;
    if (!isFinite(startedAt)) startedAt = submittedAt;

    var payload = {
      id: getInteractionQuestionId(page, q, qi, attemptNumber),
      type: 'choice',
      description: trimInteractionText(q && q.question ? q.question : 'Question ' + (qi + 1), 250),
      learnerResponse: selectedAnswer ? getAnswerInteractionValue(selectedAnswer, selectedIdx) : '',
      correctResponses: answers.map(function(answer, ai) {
        return answer && answer.correct ? getAnswerInteractionValue(answer, ai) : null;
      }).filter(function(value) { return value !== null; }),
      result: selectedAnswer && selectedAnswer.correct ? 'correct' : 'incorrect',
      latency: formatIso8601Duration(submittedAt - startedAt),
      attempt: attemptNumber,
      startedAt: new Date(startedAt).toISOString(),
      submittedAt: new Date(submittedAt).toISOString()
    };

    // Telemetry: record the graded per-question RESULT (correct/incorrect + latency)
    // to our own ledger — the answer-select events only have the chosen answer, not
    // whether it was right. Powers the audit summary's per-question detail.
    try {
      logEvent('quiz', 'answer-result', {
        questionId: payload.id,
        qi: qi,
        result: payload.result,
        latency: payload.latency,
        attempt: attemptNumber
      });
    } catch (e) { /* telemetry must never block exam submit */ }

    try {
      var result = scorm.setInteraction(payload);
      if (result && typeof result.catch === 'function') {
        result.catch(function() { /* analytics should never block exam submit */ });
      }
    } catch (e) { /* analytics should never block exam submit */ }
  });
}

function selectQuizAnswer(qi, ai) {
  quizAnswers[qi] = ai;
  var qEl = document.querySelector('.quiz-question[data-qi="' + qi + '"]');
  var answers = qEl.querySelectorAll('.quiz-answer');
  answers.forEach(function(a, i) {
    a.classList.toggle('selected', i === ai);
  });
  // Enable submit if all answered
  var questions = resolveQuizQuestions(courseData.pages[currentPage]);
  var allAnswered = questions.every(function(q, i) {
    return quizAnswers[i] !== undefined;
  });
  document.getElementById('quiz-submit').disabled = !allAnswered;
  // Telemetry: record each exam answer click AS IT HAPPENS (not at submit), so a
  // session that never submits still shows the learner's per-question activity.
  try {
    var qpage = courseData.pages[currentPage];
    var qq = questions[qi];
    logEvent('quiz', 'answer-select', {
      qi: qi,
      questionId: qq ? getInteractionQuestionId(qpage, qq, qi, quizAttemptCount + 1) : ('q' + (qi + 1)),
      selectedIndex: ai,
      attempt: quizAttemptCount + 1,
      allAnswered: allAnswered
    });
    aaaFlushTelemetry(false); // push promptly so a click survives an immediate close
  } catch (e) { /* telemetry must never block answering */ }
  // Persist each answer as it's chosen so an interruption loses at most the
  // current click, not up to 30s of answers (the 30s autosave still commits).
  saveSuspendData();
}

function submitQuiz() {
  var page = courseData.pages[currentPage];
  var questions = resolveQuizQuestions(page);
  var submittedAt = Date.now();
  var correct = 0;
  questions.forEach(function(q, qi) {
    var selectedIdx = quizAnswers[qi];
    if (selectedIdx !== undefined && q.answers && q.answers[selectedIdx] && q.answers[selectedIdx].correct) {
      correct++;
    }
  });

  quizScore = Math.round((correct / questions.length) * 100);
  quizSubmitted = true;
  quizAttemptCount += 1;
  updateRefsBtnVisibility();

  var passed = quizScore >= page.requiredScore;
  var scaled = quizScore / 100;

  // Report to ScormClient
  emitQuizInteractions(page, questions, submittedAt, quizAttemptCount);

  // Sequence: write the exam result, persist suspend data, THEN commit, and only
  // afterwards evaluate completion. A premature commit here was flushing Docebo
  // before the exam score/suspend writes landed — the learner passed but Docebo
  // recorded a stale snapshot (failed/unsaved exam submissions, OP-462/464).
  scorm.submitExam({
    scaled: scaled,
    raw: quizScore,
    min: 0,
    max: 100,
    passed: passed
  }).then(function() {
    return saveSuspendData();
  }).then(function() {
    return scorm.commit();
  }).then(function() {
    logEvent('exam', 'persist', 'ok');
    checkCompletion();
  }).catch(function(err) {
    logError('exam', 'persist-failed', err ? err.message : 'unknown');
    checkCompletion();
  });

  renderQuizResults(document.getElementById('content-inner'), page);
}

function renderQuizResults(container, page) {
  var passed = quizScore >= page.requiredScore;
  var hasUnlimitedRetakes = !page.retakeLimit || page.retakeLimit < 1;
  var remainingRetakes = hasUnlimitedRetakes ? null : Math.max(page.retakeLimit - quizAttemptCount, 0);
  var questions = resolveQuizQuestions(page);
  var origQuestions = page.questions || [];
  var html = '<div class="quiz-container">';
  html += '<div class="quiz-header"><h2>Final Exam - Results</h2></div>';

  // Show each question with correct/incorrect
  questions.forEach(function(q, qi) {
    html += '<div class="quiz-question">';
    html += '<div class="quiz-q-num">Question ' + (qi + 1) + '</div>';
    html += '<div class="quiz-q-text">' + (q.question || '') + '</div>';
    if (q.answers) {
      q.answers.forEach(function(a, ai) {
        var cls = 'quiz-answer';
        if (a.correct) cls += ' correct-reveal';
        else if (quizAnswers[qi] === ai) cls += ' incorrect-reveal';
        if (quizAnswers[qi] === ai) cls += ' selected';
        html += '<div class="' + cls + '">' + escapeHtml(a.text);
        if (a.correct) html += ' \u2713';
        if (quizAnswers[qi] === ai && !a.correct) html += ' \u2717';
        html += '</div>';
      });
    }
    var refId = resolveReferencePageId(q.refPageId || (origQuestions[qi] && origQuestions[qi].refPageId), currentPage);
    if (refId) {
      html += '<button class="view-ref-btn" onclick="openRefPageModal(\'' + refId + '\')">&#128196; View Reference Page</button>';
    }
    html += '</div>';
  });

  html += '<div class="quiz-result ' + (passed ? 'passed' : 'failed') + '">';
  html += '<h3>' + (passed ? 'Congratulations! You Passed!' : 'Not Yet Passing') + '</h3>';
  html += '<div class="score">' + quizScore + '%</div>';
  html += '<p>Required: ' + page.requiredScore + '%</p>';
  if (!passed && page.allowRetake) {
    html += '<p>Retakes remaining: ' + (hasUnlimitedRetakes ? 'Unlimited' : (remainingRetakes + ' of ' + page.retakeLimit)) + '</p>';
  }
  html += '</div>';

  if (!passed && page.allowRetake && (hasUnlimitedRetakes || remainingRetakes > 0)) {
    html += '<button id="retake-btn" style="display:block" onclick="retakeQuiz()">Retake Exam</button>';
  } else if (!passed && page.allowRetake && !hasUnlimitedRetakes) {
    html += '<div class="quiz-result failed"><p>No retakes remain for this attempt.</p></div>';
  }
  html += '</div>';
  container.innerHTML = html;
}

function applyNoReferrerMedia() {
  var container = document.getElementById('content-inner');
  if (!container) return;
  container.querySelectorAll('img').forEach(function(img) {
    img.referrerPolicy = 'no-referrer';
  });
  container.querySelectorAll('video').forEach(function(video) {
    video.referrerPolicy = 'no-referrer';
    try { video.load(); } catch (err) { /* ignore */ }
  });
  container.querySelectorAll('video source').forEach(function(source) {
    source.setAttribute('referrerpolicy', 'no-referrer');
  });
}

function retakeQuiz() {
  quizSubmitted = false;
  quizAnswers = {};
  quizScore = 0;
  quizResolvedQuestions = {};
  quizQuestionStartTimes = {};
  saveSuspendData();
  renderPage();
}

function goToPage(idx) {
  if (courseData.navigationLock && idx > highestVisited + 1) return;
  currentPage = idx;
  renderPage();
}

function nextPage() {
  if (currentPage < courseData.pages.length - 1) {
    // Selftest gating: if nav lock is on, block forward nav past unanswered selftests
    var page = courseData.pages[currentPage];
    if (courseData.navigationLock && page.type === 'selftest' && !selftestAnswered[currentPage]) {
      document.getElementById('selftest-gate-msg').style.display = 'block';
      document.getElementById('next-btn').classList.add('gated');
      return;
    }
    currentPage++;
    renderPage();
  }
}

function completeModule() {
  var allVisited = visitedPages.size >= courseData.totalPages;
  var timerMet = !courseData.minimumTimeSeconds || timerElapsed >= courseData.minimumTimeSeconds;
  var modal = document.getElementById('submit-modal');
  var overlay = document.getElementById('submit-modal-overlay');

  // Check for blockers
  var blockers = [];
  if (!allVisited) {
    var remaining = courseData.totalPages - visitedPages.size;
    blockers.push('Visit all pages (' + remaining + ' remaining)');
  }
  if (!timerMet) {
    var secs = courseData.minimumTimeSeconds - timerElapsed;
    var h = Math.floor(secs / 3600);
    var m = Math.floor((secs % 3600) / 60);
    var s = secs % 60;
    var timeStr;
    if (h > 0) {
      timeStr = h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    } else {
      timeStr = m + ':' + (s < 10 ? '0' : '') + s;
    }
    blockers.push('Minimum time not met (' + timeStr + ' remaining)');
  }
  if (hasQuiz) {
    var quizPage = courseData.pages.find(function(p) { return p.type === 'quiz'; });
    var passed = quizSubmitted && quizScore >= quizPage.requiredScore;
    if (!passed) {
      blockers.push('Pass the exam (requires ' + quizPage.requiredScore + '%)');
    }
  }

  if (blockers.length > 0) {
    logEvent('submit', 'blocked', { blockers: blockers, timerElapsed: timerElapsed, visitedPages: visitedPages.size });
    var html = '<div class="submit-blocked">';
    html += '<h3>Cannot Submit Yet</h3>';
    html += '<p>Please complete the following before submitting:</p>';
    html += '<ul>';
    blockers.forEach(function(b) { html += '<li>' + b + '</li>'; });
    html += '</ul>';
    html += '<button class="btn-close" onclick="document.getElementById(\'submit-modal-overlay\').classList.remove(\'active\')">OK</button>';
    html += '</div>';
    modal.innerHTML = html;
    overlay.classList.add('active');
    return;
  }

  logEvent('submit', 'completing', { timerElapsed: timerElapsed, visitedPages: visitedPages.size, quizScore: quizScore });
  // All conditions met — complete the module.
  // Sequence completion → suspend → commit so Docebo's flush captures the
  // completion and final state instead of a stale pre-submit snapshot.
  courseCompleted = true;
  scorm.setCompletionStatus('completed').then(function() {
    return saveSuspendData();
  }).then(function() {
    return scorm.commit();
  }).then(function() {
    logEvent('submit', 'commit', 'ok');
  }).catch(function(err) {
    logError('submit', 'commit-failed', err ? err.message : 'unknown');
  });

  var html = '<div class="submit-success">';
  html += '<h3>Module Submitted Successfully</h3>';
  html += '<p>This module has been marked as complete. You may now close this window.</p>';
  html += '<button class="btn-ok" onclick="document.getElementById(\'submit-modal-overlay\').classList.remove(\'active\')">OK</button>';
  html += '</div>';
  modal.innerHTML = html;
  overlay.classList.add('active');

  // Disable the submit button after successful submission
  var nextBtn = document.getElementById('next-btn');
  nextBtn.disabled = true;
  nextBtn.textContent = 'Submitted \u2713';
}

function prevPage() {
  if (currentPage > 0) {
    currentPage--;
    renderPage();
  }
}

function updateProgress() {
  var pct = Math.round((visitedPages.size / courseData.totalPages) * 100);
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-text').textContent = visitedPages.size + ' of ' + courseData.totalPages + ' pages (' + pct + '%)';
}

// Timer
function startTimer() {
  // ALWAYS run the engaged-time counter so timerElapsed grows for EVERY course.
  // Previously this bailed out when there was no minimum-time gate, leaving
  // timerElapsed stuck at 0 for those courses (no time signal, misleading logs).
  var minSecs = courseData.minimumTimeSeconds || 0;
  logEvent('timer', 'start', {
    timerElapsed: timerElapsed,
    minimumTimeSeconds: minSecs,
    remaining: Math.max(0, minSecs - timerElapsed)
  });
  updateTimerDisplay();
  timerInterval = setInterval(function() {
    timerElapsed++;
    updateTimerDisplay();
    // Save every 30 seconds to avoid data loss. Sequence so commit() flushes
    // after the suspend write lands (no stale-snapshot commit).
    if (timerElapsed % 30 === 0) {
      saveSuspendData().then(function() { return scorm.commit(); });
    }
    // Log every 5 minutes for timer health tracking
    if (timerElapsed % 300 === 0) {
      logEvent('timer', 'heartbeat', {
        timerElapsed: timerElapsed,
        remaining: Math.max(0, minSecs - timerElapsed),
        visitedPages: visitedPages.size,
        suspendSaveErrors: suspendSaveErrorCount
      });
    }
    // Gate met: use >= with a once-guard so a throttled/coalesced tick can't skip
    // past the exact second and miss the trigger (was a fragile === check).
    if (minSecs > 0 && !timerMetFired && timerElapsed >= minSecs) {
      timerMetFired = true;
      logEvent('timer', 'met', { timerElapsed: timerElapsed });
      checkCompletion();
    }
  }, 1000);
}

function updateTimerDisplay() {
  var el = document.getElementById('timer-display');
  if (!courseData.minimumTimeSeconds || courseData.minimumTimeSeconds <= 0) {
    el.style.display = 'none';
    return;
  }
  var remaining = Math.max(0, courseData.minimumTimeSeconds - timerElapsed);
  if (remaining > 0) {
    var hrs = Math.floor(remaining / 3600);
    var min = Math.floor((remaining % 3600) / 60);
    var sec = remaining % 60;
    var timeStr;
    if (hrs > 0) {
      timeStr = hrs + ':' + (min < 10 ? '0' : '') + min + ':' + (sec < 10 ? '0' : '') + sec;
    } else {
      timeStr = min + ':' + (sec < 10 ? '0' : '') + sec;
    }
    el.textContent = timeStr + ' remaining';
    el.className = 'counting';
  } else {
    el.textContent = 'Minimum time met';
    el.className = 'met';
  }
}

startTimer();

// ===================================================================
// DIAGNOSTIC PANEL
// ===================================================================

var currentDiagTab = 'log';

function openDiagPanel() {
  refreshDiagPanel();
  document.getElementById('diag-overlay').classList.add('active');
}

function closeDiagPanel() {
  document.getElementById('diag-overlay').classList.remove('active');
}

function showDiagTab(tab) {
  currentDiagTab = tab;
  var tabs = document.querySelectorAll('#diag-panel .diag-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].textContent.toLowerCase().indexOf(tab) !== -1);
  }
  refreshDiagPanel();
}

function refreshDiagPanel() {
  var body = document.getElementById('diag-body');
  if (currentDiagTab === 'log') {
    renderDiagLog(body);
  } else if (currentDiagTab === 'state') {
    renderDiagState(body);
  } else if (currentDiagTab === 'suspend') {
    renderDiagSuspend(body);
  }
}

function renderDiagLog(body) {
  // Merge player log + launcher log (fetch async)
  var html = '';
  var allEntries = flightLog.slice();
  // Sort by timestamp
  allEntries.sort(function(a, b) { return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0; });
  for (var i = 0; i < allEntries.length; i++) {
    var e = allEntries[i];
    var cls = e.ok ? '' : ' error';
    var ts = e.ts ? e.ts.substring(11, 23) : '';
    var detail = e.detail;
    if (detail && typeof detail === 'object') {
      try { detail = JSON.stringify(detail); } catch(x) { detail = String(detail); }
    }
    html += '<div class="log-entry' + cls + '">'
          + '<span class="log-ts">' + ts + '</span>'
          + '<span class="log-cat">' + (e.cat || '') + '</span>'
          + '<span class="log-act">' + (e.act || '') + '</span>'
          + '<span class="log-detail">' + (detail || '') + '</span>'
          + '</div>';
  }
  body.innerHTML = html || '<div style="color:#666;padding:16px;">No events recorded yet.</div>';
  body.scrollTop = body.scrollHeight;

  // Also fetch launcher log in background
  if (scormReady && !scorm.isStandalone()) {
    scorm.getFlightLog().then(function(launcherLog) {
      if (!launcherLog || !launcherLog.length) return;
      var merged = flightLog.slice();
      for (var j = 0; j < launcherLog.length; j++) {
        var le = launcherLog[j];
        le.cat = 'L:' + (le.cat || '');
        merged.push(le);
      }
      merged.sort(function(a, b) { return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0; });
      var mhtml = '';
      for (var k = 0; k < merged.length; k++) {
        var me = merged[k];
        var mcls = me.ok ? '' : ' error';
        var mts = me.ts ? me.ts.substring(11, 23) : '';
        var md = me.detail;
        if (md && typeof md === 'object') {
          try { md = JSON.stringify(md); } catch(x) { md = String(md); }
        }
        mhtml += '<div class="log-entry' + mcls + '">'
              + '<span class="log-ts">' + mts + '</span>'
              + '<span class="log-cat">' + (me.cat || '') + '</span>'
              + '<span class="log-act">' + (me.act || '') + '</span>'
              + '<span class="log-detail">' + (md || '') + '</span>'
              + '</div>';
      }
      if (currentDiagTab === 'log') {
        body.innerHTML = mhtml;
        body.scrollTop = body.scrollHeight;
      }
    });
  }
}

function renderDiagState(body) {
  var state = {
    courseId: courseData.courseId,
    networkId: courseData.networkId,
    courseName: courseData.courseName,
    totalPages: courseData.totalPages,
    minimumTimeSeconds: courseData.minimumTimeSeconds,
    currentPage: currentPage,
    visitedPages: visitedPages.size,
    highestVisited: highestVisited,
    timerElapsed: timerElapsed,
    timerRemaining: Math.max(0, (courseData.minimumTimeSeconds || 0) - timerElapsed),
    quizSubmitted: quizSubmitted,
    quizScore: quizScore,
    quizAttemptCount: quizAttemptCount,
    courseCompleted: courseCompleted,
    scormReady: scormReady,
    standalone: scorm.isStandalone(),
    suspendSaveCount: suspendSaveCount,
    suspendSaveErrorCount: suspendSaveErrorCount,
    visitedPagesList: Array.from(visitedPages).sort(function(a,b){return a-b;})
  };
  body.innerHTML = '<pre class="diag-json">' + JSON.stringify(state, null, 2) + '</pre>';
}

function renderDiagSuspend(body) {
  if (!scormReady || scorm.isStandalone()) {
    body.innerHTML = '<pre class="diag-json">SCORM not connected — no suspend data available</pre>';
    return;
  }
  scorm.getSuspendData().then(function(data) {
    if (!data) {
      body.innerHTML = '<pre class="diag-json">No suspend data stored</pre>';
      return;
    }
    try {
      var parsed = JSON.parse(data);
      body.innerHTML = '<pre class="diag-json">' + JSON.stringify(parsed, null, 2) + '</pre>';
    } catch(e) {
      body.innerHTML = '<pre class="diag-json">RAW (parse failed: ' + e.message + '):\n' + data.substring(0, 4000) + '</pre>';
    }
  });
}

function copyDiagLog() {
  var allEntries = flightLog.slice();
  allEntries.sort(function(a, b) { return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0; });
  var text = JSON.stringify({
    exported: new Date().toISOString(),
    courseId: courseData.courseId,
    networkId: courseData.networkId,
    timerElapsed: timerElapsed,
    visitedPages: visitedPages.size,
    entries: allEntries
  }, null, 2);
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(function() {
      alert('Flight log copied to clipboard (' + allEntries.length + ' entries)');
    });
  } else {
    // Fallback for older browsers
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    alert('Flight log copied to clipboard (' + allEntries.length + ' entries)');
  }
}

// Keyboard shortcut: Ctrl+Shift+D to open diagnostic panel
document.addEventListener('keydown', function(e) {
  if (e.ctrlKey && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    if (document.getElementById('diag-overlay').classList.contains('active')) {
      closeDiagPanel();
    } else {
      openDiagPanel();
    }
  }
  if (e.key === 'Escape' && document.getElementById('diag-overlay').classList.contains('active')) {
    closeDiagPanel();
  }
});

// URL fixer: strip presigned params from media URLs
function stripPresignedParams(url) {
  if (!url || url.indexOf('X-Amz-') === -1) return url;
  return url.split('?')[0];
}

function fixPresignedUrls() {
  var container = document.getElementById('content-inner');
  if (!container) return;
  var imgs = container.querySelectorAll('img[src*="X-Amz-"]');
  for (var i = 0; i < imgs.length; i++) {
    imgs[i].src = stripPresignedParams(imgs[i].src);
  }
  var sources = container.querySelectorAll('source[src*="X-Amz-"]');
  for (var i = 0; i < sources.length; i++) {
    sources[i].src = stripPresignedParams(sources[i].src);
  }
  var links = container.querySelectorAll('a[href*="X-Amz-"]');
  for (var i = 0; i < links.length; i++) {
    links[i].href = stripPresignedParams(links[i].href);
  }
}

function normalizeLegacyVideoUrl(url) {
  if (!url) return url;
  var match = String(url).match(/^(.+).(wmv|mov|avi)([?#].*)?$/i);
  if (!match) return url;
  return match[1] + '.mp4' + (match[3] || '');
}

function upgradeLegacyVideoSources() {
  var container = document.getElementById('content-inner');
  if (!container) return;
  var changedVideos = new Set();

  container.querySelectorAll('video').forEach(function(video) {
    var srcAttr = video.getAttribute('src');
    if (!srcAttr) return;
    var normalized = normalizeLegacyVideoUrl(srcAttr);
    if (normalized !== srcAttr) {
      video.setAttribute('src', normalized);
      changedVideos.add(video);
    }
  });

  container.querySelectorAll('video source').forEach(function(source) {
    var srcAttr = source.getAttribute('src') || '';
    var normalized = normalizeLegacyVideoUrl(srcAttr);
    if (normalized !== srcAttr) {
      source.setAttribute('src', normalized);
      if (source.parentElement && source.parentElement.tagName === 'VIDEO') {
        changedVideos.add(source.parentElement);
      }
    }
  });

  changedVideos.forEach(function(video) {
    try { video.load(); } catch (err) { /* ignore */ }
  });
}

// Fix media URLs where URL-encoded chars (%20, %23, etc.) were stored literally
// in S3 keys. The browser decodes them when fetching, so the request fails.
// We detect broken images/videos and re-encode the percent signs in the URL.
function fixEncodedMediaUrls() {
  var container = document.getElementById('content-inner');
  if (!container) return;
  var s3Base = 'aaa-courses.s3.us-east-2.amazonaws.com';

  // For images: use onerror to detect and retry with fixed URL
  var imgs = container.querySelectorAll('img');
  for (var i = 0; i < imgs.length; i++) {
    (function(img) {
      if (img.src.indexOf(s3Base) === -1) return;
      if (img.getAttribute('data-url-fixed')) return;
      var origSrc = img.src;
      img.onerror = function() {
        if (img.getAttribute('data-url-fixed')) return;
        img.setAttribute('data-url-fixed', '1');
        // Re-encode: the browser already decoded %20→space in the src.
        // We need to encode spaces (and other chars) back for S3.
        // Replace the path portion only, encoding each segment.
        try {
          var url = new URL(origSrc);
          var segments = url.pathname.split('/');
          var encoded = segments.map(function(s) { return encodeURIComponent(decodeURIComponent(s)).replace(/'/g, '%27'); }).join('/');
          img.src = url.origin + encoded;
        } catch(e) { /* ignore */ }
      };
    })(imgs[i]);
  }

  // For video sources
  var sources = container.querySelectorAll('source');
  for (var i = 0; i < sources.length; i++) {
    (function(source) {
      if (source.src.indexOf(s3Base) === -1) return;
      if (source.getAttribute('data-url-fixed')) return;
      var video = source.parentElement;
      if (!video || video.tagName !== 'VIDEO') return;
      var origSrc = source.src;
      video.onerror = function() {
        if (source.getAttribute('data-url-fixed')) return;
        source.setAttribute('data-url-fixed', '1');
        try {
          var url = new URL(origSrc);
          var segments = url.pathname.split('/');
          var encoded = segments.map(function(s) { return encodeURIComponent(decodeURIComponent(s)).replace(/'/g, '%27'); }).join('/');
          source.src = url.origin + encoded;
          video.load();
        } catch(e) { /* ignore */ }
      };
    })(sources[i]);
  }
}

// Lightbox
function closeLightbox() {
  document.getElementById('lightbox-overlay').classList.remove('active');
}

// Lightbox for dual-size images
document.addEventListener('click', function(e) {
  var link = e.target.closest('.dual-size-image');
  if (link) {
    e.preventDefault();
    e.stopPropagation();
    var overlay = document.getElementById('lightbox-overlay');
    var img = document.getElementById('lightbox-img');
    img.src = stripPresignedParams(link.href);
    overlay.classList.add('active');
    return;
  }
  // Close lightbox when clicking the overlay background (not the image)
  var overlay = document.getElementById('lightbox-overlay');
  if (overlay.classList.contains('active') && e.target === overlay) {
    closeLightbox();
  }
});

// Prevent clicks on lightbox image from closing
document.getElementById('lightbox-img').addEventListener('click', function(e) {
  e.stopPropagation();
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeLightbox();
    closeRefPageModal();
  }
});

// Keyboard navigation
document.addEventListener('keydown', function(e) {
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); nextPage(); }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); prevPage(); }
});

// Window close -- save final state then terminate SCORM session.
// KNOWN LIMITATION (tracked for the refactor): these are async postMessage
// calls fired during page teardown, so delivery is NOT guaranteed and they
// cannot be safely sequenced/awaited (the page may unload first, dropping
// terminate). A reliable fix needs a synchronous transport (navigator.sendBeacon
// or fetch{keepalive:true}) for the final flush. Until then, the 30s autosave
// (now sequenced) is the durable path; worst case here is the last <30s.
window.addEventListener('beforeunload', function() {
  saveSuspendData();
  scorm.commit();
  scorm.terminate();
  // Final telemetry flush via keepalive — this is the one transport that
  // survives the unload the SCORM postMessages above cannot be guaranteed to.
  try {
    logEvent('session', 'close', { timerElapsed: timerElapsed, page: currentPage, completed: courseCompleted });
    aaaFlushTelemetry(true);
  } catch (e) { /* never block unload */ }
});

// pagehide (mobile Safari / bfcache) — best-effort duplicate of the unload flush.
window.addEventListener('pagehide', function() {
  try {
    logEvent('session', 'pagehide', { timerElapsed: timerElapsed, page: currentPage, completed: courseCompleted });
    aaaFlushTelemetry(true);
  } catch (e) { /* ignore */ }
});

// --- Report a Problem widget ---
var FEEDBACK_API = 'https://editor.aircrewacademy.com/api/feedback';

function toggleFeedback() {
  var panel = document.getElementById('feedback-panel');
  var status = document.getElementById('fp-status');
  status.className = 'fp-status';
  status.textContent = '';
  if (panel.classList.contains('active')) {
    panel.classList.remove('active');
  } else {
    var page = courseData.pages[currentPage];
    document.getElementById('fp-context').textContent =
      courseData.courseName + ' — Page ' + (currentPage + 1) + ' of ' + courseData.totalPages +
      (page && page.title ? ' (' + page.title + ')' : '');
    document.getElementById('fp-message').value = '';
    document.getElementById('fp-submit').disabled = false;
    panel.classList.add('active');
    document.getElementById('fp-message').focus();
  }
}

function submitFeedback() {
  var msg = document.getElementById('fp-message').value.trim();
  if (!msg) return;
  var btn = document.getElementById('fp-submit');
  var status = document.getElementById('fp-status');
  btn.disabled = true;
  btn.textContent = 'Submitting...';
  status.className = 'fp-status';

  var page = courseData.pages[currentPage] || {};
  var body = JSON.stringify({
    courseName: courseData.courseName,
    courseId: courseData.courseId,
    networkId: courseData.networkId,
    pageNumber: currentPage + 1,
    pageTitle: page.title || '',
    message: msg
  });

  fetch(FEEDBACK_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body
  }).then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.success) {
        status.className = 'fp-status success';
        status.textContent = 'Thanks! An Instructor will get back to you soon.';
        btn.textContent = 'Submit';
        setTimeout(function() { toggleFeedback(); }, 2000);
      } else {
        throw new Error(data.error || 'Submission failed');
      }
    }).catch(function(err) {
      status.className = 'fp-status error';
      status.textContent = err.message || 'Failed to submit. Please try again.';
      btn.disabled = false;
      btn.textContent = 'Submit';
    });
}

// Initial render (for standalone/no-launcher mode -- init() may resolve instantly)
buildSidebar();
renderPage();
