// ScormClient instance
// Any genuine LMS read/write failure (timeout or success:false), across every
// Docebo endpoint, trips the sticky degraded-mode warning. aaaShowDegraded is a
// hoisted declaration below; it self-guards so repeat failures are a no-op.
var scorm = new ScormClient({
  onSendError: function (action, err) {
    aaaShowDegraded(); // a real LMS send/recv failure — surface to the learner FIRST (invariant)
    // DIAGNOSTIC: record WHAT tripped it — this path was previously SILENT, making spurious
    // banners impossible to attribute. (_fireSendError already try/catches this callback.)
    logError('scorm-send', action || 'unknown', (err && err.message) ? err.message : String(err));
    aaaSendErrorReport('scorm-send:' + (action || 'unknown'), err); // direct error report (best-effort)
  }
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
var lastQuizPageIndex = -1;         // R4: page index of the most-recently submitted exam (multi-quiz gate binding)
var aaaRequiredScoreWarned = false; // R4: dedup the loud requiredScore-invalid diagnostic
var selftestAnswered = {};
var timerElapsed = 0;
var timerInterval = null;
var timerMetFired = false; // fire the time-gate completion check once (guards against throttled-tick skips)
var quizResolvedQuestions = {};
var quizQuestionStartTimes = {};
var courseCompleted = false;
var completionInFlight = false; // R1: true while a finalizeCompletion write is racing; cleared in both success + catch
var AAA_COMPLETION_RETRY_BACKOFF_MS = 1000; // R2: short backoff before the one bounded completion-write retry
// In-house analytics time context. The separate WALL-CLOCK session clock is TERMINATED — there is ONE
// engaged clock (timerElapsed). Telemetry stamps that canonical clock + the cumulative total below.
var priorTotalTimeSec = 0;             // cmi.total_time from prior sessions (read at init)

// ===================================================================
// FLIGHT RECORDER — structured logging for player diagnostics
// ===================================================================
var flightLog = [];
var FLIGHT_LOG_MAX = 500;

// === SINGLE-SOURCE TIME (Docebo broker) — ships DARK ============================================
// The minimum-time GATE and its countdown can read Docebo's OWN live total_time instead of our local
// `timerElapsed`. SAFETY: the source defaults to 'local', so the gate stays byte-for-byte on
// timerElapsed — NO behavior change in production. It flips to 'docebo' ONLY when a course opts in
// (courseData.timeSource==='docebo') or a tester passes ?aaaTimeSource=docebo — so prod stays dark
// while sandbox can exercise the broker. Even in 'docebo' mode an unanswered broker falls back to
// timerElapsed, so a learner is NEVER hard-blocked by an outage. The broker is an OPEN, rate-limited,
// read-only GET of Docebo via our telemetry service (no token, no writes).
var AAA_DOCEBO_TIME_ENDPOINT = 'https://editor.aircrewacademy.com/api/telemetry/docebo-time';
var AAA_TIME_POLL_MS = 60000;
// SESSION KEEPALIVE — pings Docebo every 15 min to prevent the platform's 5400s idle-session
// expiry from silently killing SCORM commits (OP-634 root cause: BR-LAUNCHER-SAVE-SWALLOW hides
// commit timeouts, completion never reaches Docebo). Origin is auto-derived from document.referrer
// (the launcher, which is on the Docebo domain) — null in standalone/preview, where keepalive is skipped.
var AAA_KEEPALIVE_INTERVAL_MS = 900000; // 15 min (5400s / 6 — pings well inside the 90-min window)
var AAA_DOCEBO_ORIGIN = (function () {
  try { var ref = document.referrer; if (ref) return new URL(ref).origin; } catch (e) {}
  return (courseData && courseData.doceboOrigin) || null;
})();
var aaaTime = { doceboTimeSec: null, asOf: 0, ok: false }; // ONE store: the gate AND the countdown read this
// (The time-source mode switch is gone — no "docebo mode" vs "local mode".) The Docebo time is ALWAYS
// polled when a course is time-gated, so the submit gate can ALWAYS check it as an option (the OR); and
// the learner ALWAYS sees our own local clock. Both clocks are always on; neither is a mode.

// ================================================================================================
// TWO CLOCKS, TWO TICKS — both mandatory, no flags, no dark-default, no shared timebase.
// ================================================================================================
//
// CLOCK 1 — the INACTIVITY timer. A plain counter of seconds since the last interaction: every activity
// event resets it to 0 (aaaResetInactivity), and aaaInactivityTick adds one per REAL second. Its only
// output is aaaTimerFrozen() — true once it reaches the 5-minute cap. Same rule Docebo uses.
var aaaInactiveSec = 0;
// 5 min with no interaction => frozen (matches Docebo's iframe timeout). TEST-ONLY: ?aaaIdleSec=N
// shortens it (absent => 300), and the presence banner reads the same param, so the freeze + banner
// stay in lockstep when exercising the gray-out in seconds instead of 5 minutes. Harmless in prod.
var AAA_INACTIVITY_CAP_SEC = (function () {
  try {
    var m = (typeof location !== 'undefined') && (location.search || '').match(/[?&]aaaIdleSec=(\d+)\b/);
    return m ? Math.max(1, parseInt(m[1], 10)) : 300;
  } catch (e) { return 300; }
})();
var AAA_INACTIVITY_TICK_MS = 1000;   // CLOCK 1 measures REAL idle seconds

// CLOCK 2 — the ACTIVITY (engaged-time) clock: timerElapsed. One unit of engaged time per 1025ms of real
// time. The 1025 (vs 1000) is a permanent ~2.5% conservative buffer: our local clock lags real time a
// touch, so when it says the minimum is met the learner has spent slightly MORE real time and Docebo
// (which counts real time) has met it too.
var AAA_TICK_MS = 1025;

// The minimum-time gate is HARMONIOUS: it clears when EITHER independent clock reaches the floor —
// our local `timerElapsed` (always available, no network, survives resume) OR Docebo's live total_time
// (the system-of-record cross-check, when we have a reading). So neither a Docebo outage NOR a local
// hiccup can block a learner who genuinely has the time on the other clock. Conservative by construction:
// a pass requires at least one trustworthy clock at/over the floor (OR === max(clocks) >= min).
//   SAFETY: when the broker is unreachable (or hasn't answered yet) aaaTime.ok stays false, so
//   aaaDoceboReadySec() returns null and BOTH the gate and the countdown fall back to exactly
//   `timerElapsed`. The Docebo reading is always an OPTION at submit, never a requirement.
function aaaDoceboReadySec() {
  return (aaaTime.ok && typeof aaaTime.doceboTimeSec === 'number') ? aaaTime.doceboTimeSec : null;
}
// The seconds the countdown keys on: whichever clock is furthest along, so "time remaining" matches the
// moment the OR gate actually clears. No Docebo reading (broker unreachable) => exactly `timerElapsed`.
function aaaTimeBasisSec() {
  var d = aaaDoceboReadySec();
  return (d !== null) ? Math.max(timerElapsed, d) : timerElapsed;
}
// The gate decision: met if the floor is 0/unset, OR our local clock cleared it, OR Docebo cleared it.
function aaaTimerMet() {
  var min = courseData.minimumTimeSeconds;
  if (!min || min <= 0) return true;
  var d = aaaDoceboReadySec();
  return (timerElapsed >= min) || (d !== null && d >= min);
}

// Parse a SCORM ISO-8601 duration (e.g. "PT1H30M45S") to whole seconds.
function parseIso8601DurationSeconds(iso) {
  if (typeof iso !== 'string') return 0;
  var m = iso.match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return 0;
  return Math.floor(
    (parseInt(m[1] || 0, 10) * 86400) + (parseInt(m[2] || 0, 10) * 3600) +
    (parseInt(m[3] || 0, 10) * 60) + parseFloat(m[4] || 0)
  );
}

function logEvent(category, action, detail) {
  var sessionTimeSec = timerElapsed;
  var entry = {
    ts: new Date().toISOString(),
    cat: category,
    act: action,
    ok: true,
    // Time context for in-house analytics — on EVERY event (page turns, quiz
    // clicks, etc.): engaged time, this session's wall-clock, and the running
    // cumulative total across sessions.
    timerElapsed: timerElapsed,
    sessionTimeSec: sessionTimeSec,
    totalTimeSec: priorTotalTimeSec + sessionTimeSec
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
var aaaLearnerId = null;
var aaaLearnerName = null;
var aaaTelemetryQueue = [];
var aaaTelemetrySeq = 0;
var aaaTelemetryInFlight = false;
var aaaLauncherSeen = 0;
var aaaLauncherLogCache = []; // Phase A: last-N launcher flight entries (incl. Docebo GetLastError) for error reports
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
  // BR-FLUSH-DELIVERY: on the unload/hidden path, prefer navigator.sendBeacon — the
  // one transport that reliably survives sandboxed-iframe teardown (the fetch
  // keepalive below can still be dropped mid-unload). If sendBeacon is unavailable
  // or refuses the payload synchronously (queue full / too large), fall through to
  // the fetch keepalive with the same body. NOTE: cross-origin beacon delivery to
  // the sink must be confirmed in sandbox (BR-CSP-PROBE) — beacons can't preflight,
  // so the sink must accept application/json without one (or we revert to fetch).
  if (useKeepalive && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      if (navigator.sendBeacon(AAA_TELEMETRY_ENDPOINT, new Blob([body], { type: 'application/json' }))) {
        aaaTelemetryInFlight = false;
        return; // queued by the browser; delivered even after the page unloads
      }
    } catch (e) { /* fall through to fetch keepalive */ }
  }
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
      // BR-BANNER-GATE: a telemetry POST failing is an OBSERVABILITY blip, NOT a
      // learner data-loss event — do NOT pop the degraded banner here. The events
      // are requeued for retry; record it quietly. (SCORM save/commit failures DO
      // still trip the banner — see onSendError, warnSaveFailed, finalizeCompletion.)
      logError('telemetry', 'flush-failed', 'beacon POST rejected; requeued');
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
      aaaLauncherLogCache = log.slice(Math.max(0, log.length - 40)); // Phase A: cache tail for error reports
    }).catch(function () { /* ignore */ });
  } catch (e) { /* ignore */ }
}

if (typeof setInterval === 'function') {
  setInterval(function () { aaaHarvestLauncher(); aaaFlushTelemetry(false); aaaShadowLedgerFlush(false); }, AAA_TELEMETRY_FLUSH_MS);
}

// ===================================================================
// DIRECT CLIENT ERROR REPORTING — when a GENUINE user-facing call fails (a real SCORM
// save/commit/exam failure, or no launcher answered), send ONE rich, immediate report so we
// learn exactly who/what/where failed: identity (learner/course/network/session), the failed
// call, and a snapshot of pages + questions state, plus a short flight-log tail. Dedicated,
// low-volume, must-deliver channel — separate from the batched best-effort telemetry. It is
// BEST-EFFORT and MUST NEVER throw into the player, block the UI, or trip the banner.
// Sink: POST /api/telemetry/errors on the editor host -> the distinct, queryable
// `client_errors` SQLite table. (Under /api/telemetry/ so the existing nginx route proxies
// it to the telemetry service with no nginx change; the route itself is public/no-token.)
// ===================================================================
var AAA_ERROR_ENDPOINT = 'https://editor.aircrewacademy.com/api/telemetry/errors';

function aaaFlightLogTail(n) {
  n = n || 20;
  try {
    if (typeof flightLog === 'undefined' || !flightLog || !flightLog.length) return [];
    return flightLog.slice(Math.max(0, flightLog.length - n));
  } catch (e) { return []; }
}

// Phase A: last-N LAUNCHER flight entries (where the Docebo GetLastError code is recorded),
// cached by aaaHarvestLauncher. Sibling to aaaFlightLogTail; best-effort, never throws. On old
// launchers without getFlightLog the cache stays empty and this returns [] (graceful degrade).
function aaaLauncherFlightTail(n) {
  n = n || 20;
  try {
    if (typeof aaaLauncherLogCache === 'undefined' || !aaaLauncherLogCache || !aaaLauncherLogCache.length) return [];
    return aaaLauncherLogCache.slice(Math.max(0, aaaLauncherLogCache.length - n));
  } catch (e) { return []; }
}

// Phase A: classify a genuine save/send failure so reports triage Docebo-vs-bridge at a glance.
// Mirrors the gates in scorm-client.js _fireSendError so the class agrees with banner logic.
// NOTE: a true Docebo REJECT would only become its own class once the launcher propagates
// success:false (Surface 2, out of scope); today a launcher-reported failure shows 'launcher-error'.
function aaaClassifyFailure(failedCall, reason) {
  try {
    var fc = String(failedCall || '');
    var r = (reason && reason.message) ? String(reason.message) : String(reason || '');
    if (/no-launcher|standalone/i.test(fc)) return 'no-launcher';
    if (/Unknown action/i.test(r)) return 'unknown-action';
    if (/ScormClient timeout|timed?\s?out/i.test(r)) return 'timeout';
    return 'launcher-error';
  } catch (e) { return 'unknown'; }
}

// Compact "pages + questions state at the moment of failure". Defensive: may be called early
// (e.g. an init-time send failure) before some globals exist, so every read is guarded.
function aaaSnapshotForErrorReport() {
  try {
    var cd = (typeof courseData !== 'undefined') ? courseData : null;
    var quizPage = (typeof hasQuiz !== 'undefined' && hasQuiz && cd && cd.pages)
      ? cd.pages.find(function (p) { return p.type === 'quiz'; }) : null;
    var vp = (typeof visitedPages !== 'undefined' && visitedPages) ? visitedPages : null;
    return {
      page: {
        current: (typeof currentPage === 'number') ? currentPage : null,
        total: cd ? cd.totalPages : null,
        visitedCount: vp ? vp.size : null,
        highestVisited: (typeof highestVisited !== 'undefined') ? highestVisited : null,
        visited: vp ? Array.from(vp) : null
      },
      quiz: (typeof hasQuiz !== 'undefined' && hasQuiz) ? {
        submitted: (typeof quizSubmitted !== 'undefined') ? quizSubmitted : null,
        score: (typeof quizScore !== 'undefined') ? quizScore : null,
        requiredScore: quizPage ? quizPage.requiredScore : null,
        attemptCount: (typeof quizAttemptCount !== 'undefined') ? quizAttemptCount : null,
        answers: (typeof quizAnswers !== 'undefined') ? quizAnswers : null
      } : null,
      selftestAnswered: (typeof selftestAnswered !== 'undefined') ? selftestAnswered : null,
      timing: {
        timerElapsed: (typeof timerElapsed !== 'undefined') ? timerElapsed : null,
        sessionOpenedAt: (typeof aaaSessionOpenedAt !== 'undefined' && aaaSessionOpenedAt) ? aaaSessionOpenedAt.toISOString() : null
      },
      flags: {
        courseCompleted: (typeof courseCompleted !== 'undefined') ? courseCompleted : null,
        scormReady: (typeof scormReady !== 'undefined') ? scormReady : null,
        suspendSaveCount: (typeof suspendSaveCount !== 'undefined') ? suspendSaveCount : null,
        suspendSaveErrorCount: (typeof suspendSaveErrorCount !== 'undefined') ? suspendSaveErrorCount : null
      }
    };
  } catch (e) { return { snapshotError: String((e && e.message) || e) }; }
}

function aaaSendErrorReport(failedCall, reason) {
  try {
    var body = JSON.stringify({
      ts: new Date().toISOString(),
      source: 'legacy-player',
      learnerId: String((typeof aaaLearnerId !== 'undefined' && aaaLearnerId) || 'anonymous'),
      sessionId: (typeof aaaSessionId !== 'undefined') ? aaaSessionId : null,
      courseId: String(((typeof courseData !== 'undefined' && courseData) ? courseData.courseId : '') || ''),
      networkId: String(((typeof courseData !== 'undefined' && courseData) ? courseData.networkId : '') || ''),
      failedCall: String(failedCall || 'unknown'),
      reason: (reason && reason.message) ? String(reason.message) : (reason != null ? String(reason) : ''),
      snapshot: aaaSnapshotForErrorReport(),
      flightTail: aaaFlightLogTail(20),
      launcherTail: aaaLauncherFlightTail(20),
      failureClass: aaaClassifyFailure(failedCall, reason),
      userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : ''
    });
    // sendBeacon first (survives sandboxed-iframe/unload teardown), fetch keepalive fallback.
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try { if (navigator.sendBeacon(AAA_ERROR_ENDPOINT, new Blob([body], { type: 'application/json' }))) return; } catch (e) { /* fall through */ }
    }
    if (typeof fetch === 'function') {
      fetch(AAA_ERROR_ENDPOINT, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: body }).catch(function () { /* best-effort */ });
    }
  } catch (e) { /* error reporting must never break the player */ }
}

// ===================================================================
// PHASE C — UPSTREAM PREREQUISITES. Predict a SCORM contract breach BEFORE the send, from state
// the player already holds, so a known-bad write is VISIBLE upstream instead of (post-swallow)
// invisible. Pure + defensive; never throws. The hard 64KB reject already lives in
// scorm-client.js setSuspendData — this surfaces the *approach* and other prerequisites earlier.
// ===================================================================
function validateSCORMPrerequisites(action, payload) {
  var issues = [];
  try {
    if (action === 'setSuspendData') {
      var len = (payload && typeof payload.length === 'number') ? payload.length : 0;
      if (len >= 64000) issues.push({ level: 'VIOLATION', code: 'suspend_data_over_limit', detail: { bytes: len, limit: 64000 } });
      else if (len > 50000) issues.push({ level: 'WARNING', code: 'suspend_data_approaching_limit', detail: { bytes: len, limit: 64000 } });
    }
    if (action === 'commit' || action === 'setCompletionStatus') {
      if (typeof scormReady !== 'undefined' && !scormReady) issues.push({ level: 'VIOLATION', code: 'scorm_not_ready', detail: { action: action } });
      if (scorm && typeof scorm.isStandalone === 'function' && scorm.isStandalone()) issues.push({ level: 'WARNING', code: 'standalone_no_lms', detail: { action: action } });
    }
    if (action === 'submitExam') {
      var sc = payload ? payload.scaled : undefined;
      if (typeof sc === 'number' && (sc < 0 || sc > 1)) issues.push({ level: 'VIOLATION', code: 'score_scaled_out_of_range', detail: { scaled: sc } });
      var raw = payload ? payload.raw : undefined;
      if (typeof raw === 'number' && (raw < 0 || raw > 100)) issues.push({ level: 'VIOLATION', code: 'score_raw_out_of_range', detail: { raw: raw } });
    }
  } catch (e) { /* prerequisite check must never break the player */ }
  return issues;
}

// Run the check and log ONLY violations (avoids per-save pass-event bloat — relevant to the
// Phase-D queue-completeness concern). Never throws into the learner path.
function aaaCheckPrereqs(action, payload) {
  try {
    var issues = validateSCORMPrerequisites(action, payload);
    if (issues && issues.length) logError(action, 'prerequisite-violation', { action: action, issues: issues });
  } catch (e) { /* ignore */ }
}

// ===================================================================
// PHASE B — SHADOW-LEDGER (CAPTURE ONLY). An INDEPENDENT, server-side recovery copy of the exact
// state the player hands to Docebo on every save, plus completion/exam evidence. Because the
// launcher can silently swallow a Docebo reject (BR-LAUNCHER-SAVE-SWALLOW), this is our own source
// of truth for later reconstruction/override. FULL HISTORY (every save, no coalescing — durability
// decision). DEDICATED transport: its OWN bounded queue + OWN endpoint + OWN table — it does NOT
// ride aaaTeeTelemetry/the analytics queue, so it can't cannibalize analytics slots (the Phase-D
// completeness concern). Best-effort; MUST NEVER throw. Capture only — no Docebo write/reconciler.
// Sink: POST /api/telemetry/ledger -> the `save_ledger` SQLite table.
// ===================================================================
var AAA_LEDGER_ENDPOINT = 'https://editor.aircrewacademy.com/api/telemetry/ledger';
var AAA_LEDGER_MAX_QUEUE = 1000;
var aaaLedgerQueue = [];
var aaaLedgerInFlight = false;

function aaaShadowLedgerEmit(action, payload) {
  try {
    aaaLedgerQueue.push({
      ts: new Date().toISOString(),
      source: 'legacy-player',
      learnerId: String((typeof aaaLearnerId !== 'undefined' && aaaLearnerId) || 'anonymous'),
      sessionId: (typeof aaaSessionId !== 'undefined') ? aaaSessionId : null,
      courseId: String(((typeof courseData !== 'undefined' && courseData) ? courseData.courseId : '') || ''),
      networkId: String(((typeof courseData !== 'undefined' && courseData) ? courseData.networkId : '') || ''),
      action: String(action || ''),
      payload: payload
    });
    while (aaaLedgerQueue.length > AAA_LEDGER_MAX_QUEUE) aaaLedgerQueue.shift();
  } catch (e) { /* ledger must never break the player */ }
}

function aaaShadowLedgerFlush(useKeepalive) {
  if (aaaLedgerInFlight || !aaaLedgerQueue.length) return;
  var batch = aaaLedgerQueue.splice(0, 200);
  var body;
  try { body = JSON.stringify({ entries: batch }); } catch (e) { return; }
  aaaLedgerInFlight = true;
  if (useKeepalive && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      if (navigator.sendBeacon(AAA_LEDGER_ENDPOINT, new Blob([body], { type: 'application/json' }))) {
        aaaLedgerInFlight = false;
        return;
      }
    } catch (e) { /* fall through to fetch keepalive */ }
  }
  try {
    fetch(AAA_LEDGER_ENDPOINT, {
      method: 'POST',
      keepalive: !!useKeepalive,
      headers: { 'Content-Type': 'application/json' },
      body: body
    }).then(function () {
      aaaLedgerInFlight = false;
      if (aaaLedgerQueue.length) aaaShadowLedgerFlush(false);
    }).catch(function () {
      aaaLedgerInFlight = false;
      aaaLedgerQueue = batch.concat(aaaLedgerQueue); // requeue (bounded) for retry
      while (aaaLedgerQueue.length > AAA_LEDGER_MAX_QUEUE) aaaLedgerQueue.shift();
    });
  } catch (e) {
    aaaLedgerInFlight = false;
    aaaLedgerQueue = batch.concat(aaaLedgerQueue);
  }
}

// ===================================================================
// PROACTIVE LEARNER SAFEGUARDS (SANDBOX TEST — not for production yet)
//   1. Degraded-state banner: a sticky yellow notice shown the first time a
//      telemetry POST or a SCORM save/commit fails. If everything works, it
//      never appears.
//   2. Course Record (personal copy): an on-demand "Save as PDF" — the "Save as PDF"
//      button next to Submit on the final page and the degraded-banner "Save copy"
//      both open a clean top-level Course Record page and trigger the browser
//      Print / Save-as-PDF dialog. No HTML file is ever downloaded.
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

// Shown when the keepalive endpoint returns a non-2xx (session genuinely expired) — distinct from
// the generic degraded banner because the remediation is specific: reload the page to re-auth.
var aaaSessionExpiredShown = false;
function aaaShowSessionExpired() {
  if (aaaSessionExpiredShown) return;
  aaaSessionExpiredShown = true;
  try {
    var box = document.createElement('div');
    box.id = 'aaa-session-expired-banner';
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;top:12px;right:12px;max-width:340px;z-index:2147483647;background:#fef2f2;color:#7f1d1d;border:1px solid #fca5a5;border-left:4px solid #ef4444;border-radius:8px;padding:11px 13px;font:600 13px/1.45 system-ui,Arial,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.15);';
    var msg = document.createElement('div');
    msg.textContent = 'Your session has expired. Progress may not save — please reload the page to continue.';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reload page';
    btn.style.cssText = 'margin-top:10px;background:#ef4444;color:#fff;border:none;border-radius:6px;padding:6px 12px;font:600 12px system-ui,Arial,sans-serif;cursor:pointer;';
    btn.onclick = function () { window.location.reload(); };
    box.appendChild(msg);
    box.appendChild(btn);
    (document.body || document.documentElement).appendChild(box);
  } catch (e) { /* a warning must never break the player */ }
}

// Ping Docebo's keep_alive endpoint from the learner's browser (credentials:include sends the
// session cookie). A non-2xx response means the session is expired → loud banner. A network/CORS
// TypeError means the browser blocked the cross-origin request — logged silently (keepalive not
// available, but the session isn't necessarily expired yet, so no false-positive banner).
function aaaSessionKeepAlive() {
  if (!AAA_DOCEBO_ORIGIN || scorm.isStandalone()) return;
  fetch(AAA_DOCEBO_ORIGIN + '/manage/v1/user/keep_alive', { method: 'GET', credentials: 'include' })
    .then(function (res) {
      if (res.ok) {
        logEvent('keepalive', 'ok', { status: res.status });
      } else {
        logError('keepalive', 'session-expired', 'HTTP ' + res.status);
        aaaSendErrorReport('keepalive:session-expired', { status: res.status });
        aaaShowSessionExpired();
      }
    })
    .catch(function (err) {
      // TypeError = CORS blocked or network failure. Don't trip the degraded banner — keepalive
      // unavailability ≠ session expired. Log so we can detect if Docebo CORS needs configuring.
      logError('keepalive', 'fetch-error', err ? err.message : 'unknown');
      aaaSendErrorReport('keepalive:fetch-error', err);
    });
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
    if (!win) return false; // popup blocked (e.g. completion reached without a user gesture)
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
    h.push('<div class="tip noprint">This is your Course Record &mdash; a personal copy of your progress. For a PDF, use <b>Print / Save as PDF</b> (or press <b>Ctrl/Cmd + P</b>); you can also screenshot this page. <button onclick="window.print()" style="margin-left:8px;background:#4b5563;color:#fff;border:0;border-radius:6px;padding:5px 11px;font-weight:700;cursor:pointer">Print / Save as PDF</button></div>');
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
    // This popup is a top-level, non-sandboxed context (unlike the course iframe), so it CAN print.
    // It ALWAYS opens the browser Print / Save-as-PDF dialog (no HTML file is ever produced) and
    // closes itself once the dialog is dismissed. The page also has an inline "Print / Save as PDF"
    // button as a manual fallback.
    h.push('<script>window.addEventListener("load",function(){window.onafterprint=function(){try{window.close();}catch(e){}};setTimeout(function(){try{window.focus();window.print();}catch(e){}},250);});<\/script>');
    h.push('</body></html>');
    win.document.open();
    win.document.write(h.join(''));
    win.document.close();
    return true;
  } catch (e) { /* snapshot/popup failed */ return false; }
}

// Global error handlers. In an embedded iframe the flight-recorder log is
// invisible during a real session, so logging alone is a silent failure — tee it
// to telemetry for observability. BR-BANNER-GATE: an uncaught JS error/rejection
// (often from 3rd-party migrated course markup) is NOT evidence the learner's
// progress failed to save, so do NOT pop the "your progress may not be saved"
// banner here — that false alarm erodes trust and generates the very tickets it
// meant to prevent. Genuine save/commit failures still trip the banner via the
// SCORM paths (onSendError, warnSaveFailed, finalizeCompletion commit-fail).
window.onerror = function(msg, source, line, col, error) {
  // BR-BANNER-GATE stays in force: do NOT pop the degraded banner here. Phase A adds a LABEL
  // only — classify cross-origin / extension-injected noise (no source, or the opaque
  // "Script error.") as 'external' so our metrics/alarms count OUR failures, not browser
  // extensions (the EmptyRanges family: source=undefined, identical line:col across courses).
  var external = (!source) || /^Script error\.?$/i.test(String(msg || '').trim());
  logError('global', 'onerror', {
    msg: String(msg).substring(0, 300),
    source: String(source || '').substring(0, 100),
    line: line, col: col,
    errorClass: external ? 'external' : 'page'
  });
  return false;
};
window.onunhandledrejection = function(event) {
  var reason = event && event.reason;
  logError('global', 'unhandledrejection', {
    msg: reason ? String(reason.message || reason).substring(0, 300) : 'unknown'
  });
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

  // Cumulative time from prior sessions, so analytics can report a running
  // total (prior + this session). Best-effort + async; defaults to 0.
  try {
    var totalTimeP = scorm.getValue('cmi.total_time');
    if (totalTimeP && typeof totalTimeP.then === 'function') {
      totalTimeP.then(function(v) { priorTotalTimeSec = parseIso8601DurationSeconds(v); }, function() {});
    } else {
      priorTotalTimeSec = parseIso8601DurationSeconds(totalTimeP);
    }
  } catch (e) { /* analytics best-effort; never block init */ }

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
    aaaSendErrorReport('standalone:no-launcher', 'embedded but SCORM handshake never connected — saves will be lost');
  }

  // Start Docebo session keepalive. Pings immediately to confirm the session is live at init,
  // then every 15 min. Skipped in standalone/preview (no Docebo session to keep alive).
  if (!scorm.isStandalone()) {
    aaaSessionKeepAlive();
    setInterval(aaaSessionKeepAlive, AAA_KEEPALIVE_INTERVAL_MS);
  }

  // Telemetry identity + session-open marker (the orphaned-session anomaly
  // detector pairs this 'session/start' with the 'session/close' on unload).
  aaaLearnerId = session.learnerId || null;
  aaaLearnerName = session.learnerName || null;
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
      // Baseline for the regressive-write guard (see saveSuspendData). We restored
      // real stored progress; a later save that falls below this is blanked state,
      // not progress, and must not overwrite the good snapshot.
      restoredVisited = visitedPages.size;
      restoredTimer = timerElapsed;
      restoreBaselineSet = true;
      logEvent('restore', 'complete', {
        timerElapsed: timerElapsed,
        currentPage: currentPage,
        visitedPages: visitedPages.size,
        highestVisited: highestVisited
      });
    } catch(e) {
      // Could not parse stored state. Do NOT freeze saving (that used to strand the
      // learner with zero saves for the whole session). A corrupt blob is unrecoverable
      // in place anyway, and the unconditional-restore above + the regressive-write
      // guard in saveSuspendData prevent a destructive overwrite — so it is safe to
      // save fresh state forward. We DO ship the full corrupt blob to telemetry so it
      // is recoverable/diagnosable server-side.
      // NOTE: corruptBlob may be up to ~64KB and can contain learner answers — keep it
      // out of any UI; it rides the same authenticated-write telemetry path as the rest.
      logError('restore', 'corrupt-suspend-data', {
        error: e.message,
        dataLength: session.suspendData ? session.suspendData.length : 0,
        corruptBlob: session.suspendData || ''
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
    scorm.setCompletionStatus('incomplete').then(function() { return scorm.commit(); }).catch(warnSaveFailed);
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
// Regressive-write guard baseline (set on a SUCCESSFUL restore). visitedPages and
// timerElapsed are monotonic-forward within a session; saveSuspendData() refuses any
// save that would drop BELOW these, which neutralizes the OP-462/463 blank-overwrite
// WITHOUT ever freezing saves for the session. (The old `safeToPersist` ban did the
// latter and stranded learners with a corrupt blob — see docs/HANDOFF-player-save-guard-fix.md.)
var restoreBaselineSet = false;
var restoredVisited = 0;
var restoredTimer = 0;

// A save only reaches Docebo via commit(), so ANY rejection in an autosave /
// bookmark / init flush chain is a real save failure — surface it (sticky
// degraded banner) instead of failing silently. One shared handler so the
// "a save failure is ALWAYS surfaced" invariant holds on every flush path, not
// just the completion path (OP-537). Previously these chains were fire-and-forget
// with no .catch, so a failed commit lost progress with no warning (OP-534).
function warnSaveFailed(err) {
  logError('save', 'flush-failed', err ? err.message : 'unknown');
  aaaShowDegraded();
  aaaSendErrorReport('save:flush-failed', err); // direct error report (best-effort)
}

function saveSuspendData() {
  // Don't persist until SCORM init has completed and state has been restored.
  // The initial renderPage() fires before init resolves — saving here would
  // overwrite the LMS's stored progress with a blank slate.
  if (!scormReady) return Promise.resolve();
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
  // Regressive-write guard (replaces the old session-wide `safeToPersist` ban).
  // visitedPages and timerElapsed only move FORWARD within a session, so a save that
  // drops BELOW what we restored means in-memory state was blanked (OP-462/463) — skip
  // THIS write and keep the good stored snapshot. We skip only the offending write,
  // never the whole session. (quizAnswers is intentionally NOT gated here: a legit new
  // attempt clears it, while visited/timer never legitimately decrease.)
  if (restoreBaselineSet &&
      (state.visitedPages.length < restoredVisited || timerElapsed < restoredTimer - 1)) {
    logError('suspend', 'skip-regressive', {
      restoredVisited: restoredVisited, nowVisited: state.visitedPages.length,
      restoredTimer: restoredTimer, nowTimer: timerElapsed
    });
    return Promise.resolve();
  }
  var json = JSON.stringify(state);
  suspendSaveCount++;
  aaaCheckPrereqs('setSuspendData', json); // Phase C: surface size breaches upstream (before the swallow)
  aaaShadowLedgerEmit('suspend-save', { seq: suspendSaveCount, bytes: json.length, suspendData: json, page: currentPage, visited: visitedPages.size, timerElapsed: timerElapsed, quizSubmitted: quizSubmitted, quizScore: quizScore }); // Phase B: full-history recovery copy
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
    aaaSendErrorReport('setSuspendData', err); // direct error report (best-effort)
  });
}

// ===================================================================
// THE single canonical completion path (OP-537). EVERY route that finishes a
// course — automatic (checkCompletion: timer-met / exam-passed) and manual
// (completeModule: the Submit button) — goes through here. Consolidating the
// previously-separate paths means a fix or guarantee (safety-record download,
// commit-ordering, degraded-banner-on-failure, honest success/failure UI)
// applies EVERYWHERE at once, instead of being patched into one path and missed
// in the others — which is exactly how the save bug slipped through
// (OP-533/534/555/588).
//
// opts.source    — label for telemetry ('auto' | 'manual-submit' | ...)
// opts.onSuccess — called once the completion COMMIT actually lands.
// opts.onError   — called if the LMS write fails (the degraded banner also fires).
// Returns a Promise<boolean> (true = recorded, false = save failed).
// ===================================================================
// R4: ONE canonical exam-pass gate (replaces the duplicated `pages.find(type==='quiz')` checks in
// finalizeCompletion / checkCompletion / completeModule). Binds to the LAST-SUBMITTED quiz page
// (multi-quiz safe — the single global quizScore came from that exam), falling back to the first quiz
// page. A missing/NaN requiredScore is a LOUD, deduped diagnostic that NEVER auto-passes (preserves
// the OP-577 invariant — we cannot certify against an unknown threshold) instead of the silent
// `quizScore >= undefined` permanent lockout.
function getExamGate() {
  var gate = { hasQuiz: hasQuiz, quizPage: null, requiredScore: null, requiredScoreValid: false, passed: false };
  if (!hasQuiz) { gate.passed = true; return gate; } // no exam -> the exam requirement is satisfied
  var qp = (lastQuizPageIndex >= 0 && courseData.pages[lastQuizPageIndex] && courseData.pages[lastQuizPageIndex].type === 'quiz')
    ? courseData.pages[lastQuizPageIndex]
    : courseData.pages.find(function(p) { return p.type === 'quiz'; });
  gate.quizPage = qp || null;
  var req = qp ? qp.requiredScore : null;
  gate.requiredScore = req;
  gate.requiredScoreValid = (typeof req === 'number' && isFinite(req));
  if (!gate.requiredScoreValid) {
    if (!aaaRequiredScoreWarned) {
      aaaRequiredScoreWarned = true;
      logError('completion', 'requiredScore-invalid', { lastQuizPageIndex: lastQuizPageIndex, requiredScore: req });
      aaaShadowLedgerEmit('completion-config-error', { reason: 'requiredScore-invalid', requiredScore: req, lastQuizPageIndex: lastQuizPageIndex });
    }
    return gate; // never auto-pass without a valid threshold (OP-577)
  }
  gate.passed = !!(quizSubmitted && quizScore >= req);
  return gate;
}

function finalizeCompletion(opts) {
  opts = opts || {};
  // Idempotent: a course completes exactly once. If already complete, still
  // report success so a (re)Submit click on an already-complete course confirms.
  if (courseCompleted) {
    if (typeof opts.onSuccess === 'function') opts.onSuccess();
    return Promise.resolve(true);
  }
  // OP-577 HARD SCORING GATE: never record completion for a quiz course unless the
  // exam was actually submitted AND passed. The comment below relies on every route
  // being pass-gated; this ENFORCES that invariant so a single mis-call can never
  // again issue an invalid certificate at a 0.00 score on a regulatory >=80% course.
  var _gate = getExamGate(); // R4: single source of truth for the exam-pass gate
  if (_gate.hasQuiz && !_gate.passed) {
    logError('completion', 'blocked-subthreshold', {
      source: opts.source || 'auto',
      quizSubmitted: quizSubmitted,
      quizScore: quizScore,
      requiredScore: _gate.requiredScore
    });
    aaaShadowLedgerEmit('completion-refused', { source: opts.source || 'auto', quizSubmitted: quizSubmitted, quizScore: quizScore, requiredScore: _gate.requiredScore }); // Detection
    if (typeof opts.onError === 'function') opts.onError(new Error('exam not passed — completion refused'));
    return Promise.resolve(false);
  }
  // R1: do NOT set courseCompleted here (pre-commit). That poisoned the idempotency guard above so a
  // FAILED commit faked success on the next resubmit. Set it ONLY on a committed success (below), and
  // guard re-entrancy so a concurrent auto+manual pair drives a single write.
  if (completionInFlight) return Promise.resolve(false);
  completionInFlight = true;
  logEvent('completion', 'marking-complete', {
    source: opts.source || 'auto',
    timerElapsed: timerElapsed,
    visitedPages: visitedPages.size
  });
  // NOTE: completion no longer force-downloads an HTML file (clunky, surprised
  // learners). The learner saves a real PDF on demand via the "Save as PDF" button
  // next to Submit on the final page (and the degraded-banner "Save copy") — both
  // reuse aaaOpenSnapshot()'s print / Save-as-PDF flow.
  // ONE canonical LMS write order: completion status -> success status -> suspend
  // data -> commit. commit() flushes to Docebo, so it runs LAST — only after the
  // preceding writes round-trip the postMessage bridge — or Docebo persists a
  // stale snapshot missing the just-earned completion (OP-462/463/464).
  //
  // OP-462: the canonical path asserts cmi.success_status='passed' alongside
  // cmi.completion_status='completed'. Every route into finalizeCompletion is
  // pass-gated — checkCompletion() only fires when the exam is passed (or the
  // course has no exam), and completeModule() blocks submission until the exam is
  // passed — so a course that reaches here has been earned. Setting success here
  // (not only on exam submit) is what keeps scored SCORM 2004 courses from staying
  // "in progress" in Docebo on the non-quiz and resume-after-pass routes, where
  // submitExam() never re-fires and would otherwise leave success_status 'unknown'.
  aaaCheckPrereqs('setCompletionStatus'); // Phase C
  // R2: one bounded idempotent retry. The write sequence is idempotent (SCORM set*/commit), so on a
  // TRANSIENT failure we wait a short backoff and re-run the whole sequence once before declaring
  // failure. Permanent/deterministic rejects (suspend over 64KB, an Unknown-action version skew) are
  // NOT retried. Layers on top of R1 (retry-on-next-gate-event) + the transport's single timeout-retry.
  function runCompletionWrites() {
    return scorm.setCompletionStatus('completed').then(function() {
      logEvent('completion', 'status-set', 'completed');
      return scorm.setSuccessStatus('passed');
    }).then(function() {
      logEvent('completion', 'success-set', 'passed');
      return saveSuspendData();
    }).then(function() {
      return scorm.commit();
    });
  }
  function isPermanentCompletionError(err) {
    var m = (err && err.message) ? String(err.message) : '';
    return /exceeds.*64KB|64KB limit|Unknown action/i.test(m);
  }
  // R5: read-after-write reconciliation. The launcher can report success even when Docebo REJECTED the
  // SetValue (BR-LAUNCHER-SAVE-SWALLOW). Read cmi.completion_status back; a CONFIDENT mismatch (a
  // non-empty value that isn't 'completed') means the write didn't stick -> re-send ONCE (bounded; the
  // re-send is NOT re-verified, so no loop). An empty/missing read-back (old launcher / unsupported
  // getState) is "can't verify" -> trust the commit and defer to the server-side reconciliation report
  // (NEVER false-retry). NOTE: GetValue reads the in-browser data model, so this catches SetValue-level
  // rejects; a commit-persistence gap (model has it, server didn't) is still the report's job.
  // R5 read-after-write primitive (generalized from completion_status to every reconciled field). Re-read
  // ONE element via the bridge and classify against an expectation:
  //   'match'        -> the read-back satisfies it
  //   'unverifiable' -> empty/missing read-back (old launcher / unsupported getState) -> ACCEPT, never re-send
  //   'mismatch'     -> a CONFIDENT non-empty read-back that fails it -> caller re-sends ONCE (not re-verified)
  // GetValue reads the in-browser data model, so this catches SetValue-level rejects (the swallow); a
  // commit-persistence gap (model has it, the server didn't) stays the server-side reconcile's job.
  function aaaReconcileWrite(element, isExpected) {
    if (!scorm || typeof scorm.getValue !== 'function') return Promise.resolve({ verdict: 'unverifiable', readback: null });
    return scorm.getValue(element).then(function(rb) {
      if (rb == null || rb === '') return { verdict: 'unverifiable', readback: rb };
      return { verdict: isExpected(rb) ? 'match' : 'mismatch', readback: rb };
    }).catch(function() { return { verdict: 'unverifiable', readback: null }; });
  }
  // R5 (generalized to completion_status + success_status + score). Each re-send is bounded (ONCE, NOT
  // re-verified -> no loop). completion_status + success_status are co-written by runCompletionWrites, so a
  // mismatch on either re-sends that sequence; score (written at exam time as quizScore/100) re-sends via
  // setScore. An empty/missing read-back stays "can't verify" -> accept + defer to the server reconcile.
  function verifyAndReconcile() {
    if (!scorm || typeof scorm.getValue !== 'function') return;
    var _gate = getExamGate();
    var expScaled = (_gate.hasQuiz && typeof quizScore === 'number' && isFinite(quizScore)) ? (quizScore / 100) : null;
    return Promise.all([
      aaaReconcileWrite('cmi.completion_status', function(rb) { return rb === 'completed'; }),
      aaaReconcileWrite('cmi.success_status', function(rb) { return rb === 'passed'; })
    ]).then(function(v) {
      var mismatched = v.filter(function(x) { return x.verdict === 'mismatch'; });
      if (mismatched.length === 0) return;
      logError('completion', 'reconcile-mismatch', { source: opts.source || 'auto', readback: String(v[0].readback), completion: String(v[0].readback), success: String(v[1].readback) });
      aaaShadowLedgerEmit('completion-reconcile-mismatch', { source: opts.source || 'auto', readback: String(v[0].readback), completion: String(v[0].readback), success: String(v[1].readback), quizSubmitted: quizSubmitted, quizScore: quizScore }); // Detection
      return runCompletionWrites(); // re-send completion + success ONCE
    }).then(function() {
      // Score: verify the exam-written score persisted; re-send setScore ONCE on a confident mismatch.
      if (expScaled === null || typeof scorm.setScore !== 'function') return;
      return aaaReconcileWrite('cmi.score.scaled', function(rb) {
        var n = Number(rb); return isFinite(n) && Math.abs(n - expScaled) <= 0.01;
      }).then(function(s) {
        if (s.verdict !== 'mismatch') return;
        logError('completion', 'reconcile-mismatch-score', { source: opts.source || 'auto', readback: String(s.readback), expectedScaled: expScaled });
        aaaShadowLedgerEmit('completion-reconcile-mismatch', { source: opts.source || 'auto', field: 'score', readback: String(s.readback), quizScore: quizScore }); // Detection
        return scorm.setScore({ scaled: expScaled, raw: quizScore, min: 0, max: 100 }).then(function() { return scorm.commit(); });
      });
    }).catch(function() { /* read-back/re-send failed -> can't verify; trust the commit + server reconcile */ });
  }
  return runCompletionWrites().catch(function(err) {
    if (isPermanentCompletionError(err)) throw err; // a retry cannot help — fail now
    logEvent('completion', 'commit-retry', { error: err ? err.message : 'unknown' });
    return new Promise(function(res) { setTimeout(res, AAA_COMPLETION_RETRY_BACKOFF_MS); }).then(runCompletionWrites);
  }).then(verifyAndReconcile).then(function() {
    courseCompleted = true;       // R1: set ONLY after a real committed success — no fake success
    completionInFlight = false;
    logEvent('completion', 'commit', 'ok');
    aaaShadowLedgerEmit('completion-evidence', { source: opts.source || 'auto', timerElapsed: timerElapsed, visitedCount: visitedPages.size, totalPages: (courseData && courseData.totalPages) || null, reachedLastPage: (courseData && courseData.totalPages) ? (highestVisited >= courseData.totalPages - 1) : null, quizSubmitted: quizSubmitted, quizScore: quizScore }); // Phase B
    // OP-630: END the SCORM session at completion so cmi.exit flips to 'normal' NOW — not only on the
    // launcher's 60s auto-commit or an unreliable teardown. Otherwise a learner who closes right after
    // finishing returns to "Continue training" at a stale page even though the completion landed. The
    // launcher's terminate (existing bridge verb) clears its commit interval, runs setScormExit()
    // (='normal' because completion_status is 'completed'), pre-commits + Terminates, and sets
    // scormInitialized=false — so any later autosave safely no-ops (the course is already committed).
    // Wrapped in catch so an old launcher without the verb (Unknown action) never blocks the success modal.
    var _term = (scorm && typeof scorm.terminate === 'function')
      ? scorm.terminate().then(function () { logEvent('scorm', 'terminate', 'on-completion (exit=normal)'); }).catch(function (e) { logError('scorm', 'terminate', { phase: 'on-completion', error: e && e.message }); })
      : Promise.resolve();
    return _term.then(function () {
      if (typeof opts.onSuccess === 'function') opts.onSuccess();
      return true;
    });
  }).catch(function(err) {
    completionInFlight = false; // R1: leave courseCompleted=false so a resubmit / auto re-fire genuinely retries
    logError('completion', 'commit-failed', err ? err.message : 'unknown');
    aaaShowDegraded(); // the learner MUST be told the save may not have landed
    aaaSendErrorReport('completion:commit-failed', err); // direct error report (best-effort)
    aaaShadowLedgerEmit('completion-failed', { source: opts.source || 'auto', error: err ? err.message : 'unknown', quizSubmitted: quizSubmitted, quizScore: quizScore, reachedLastPage: (courseData && courseData.totalPages) ? (highestVisited >= courseData.totalPages - 1) : null }); // Detection
    if (typeof opts.onError === 'function') opts.onError(err);
    return false;
  });
}

function checkCompletion() {
  if (courseCompleted) return; // Already completed, don't re-fire

  var allVisited = visitedPages.size >= courseData.totalPages;
  var timerMet = aaaTimerMet(); // HARMONIOUS gate: local timerElapsed OR Docebo total_time clears the floor (dark default = local only)

  if (!timerMet) {
    document.getElementById('timer-gate-msg').style.display = allVisited ? 'block' : 'none';
    return;
  }
  document.getElementById('timer-gate-msg').style.display = 'none';

  // R4: one canonical gate — getExamGate().passed is true for no-quiz courses, so this covers both.
  var _checkGate = getExamGate();
  var shouldComplete = allVisited && _checkGate.passed;

  logEvent('completion', 'check', {
    allVisited: allVisited,
    timerMet: timerMet,
    timerElapsed: timerElapsed,
    doceboTimeSec: aaaDoceboReadySec(),     // the system-of-record cross-check at the gate moment (null in the dark default)
    minimumTimeSeconds: courseData.minimumTimeSeconds,
    visitedPages: visitedPages.size,
    totalPages: courseData.totalPages,
    quizSubmitted: quizSubmitted,
    quizScore: quizScore,
    // Proactively emit the course's required pass % (when there's a graded exam) so reporting always
    // knows it — not only when a learner is blocked. null for no-exam courses (no required score).
    requiredScore: _checkGate.requiredScoreValid ? _checkGate.requiredScore : null,
    shouldComplete: shouldComplete
  });

  if (shouldComplete) {
    // Automatic completion (timer-met / exam-passed) → the single canonical path.
    finalizeCompletion({ source: 'auto' });
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
  // Carry the rollup-relevant state on EVERY nav beacon (not just player/init / completion),
  // so a single dropped event can't leave totalPages/status/score permanently blank in the
  // analytics. Down-payment on the Vue state-snapshot model.
  logEvent('nav', 'page', { index: currentPage, type: page.type, visited: visitedPages.size, highest: highestVisited,
    totalPages: courseData.totalPages, completed: courseCompleted, score: (hasQuiz && quizSubmitted) ? quizScore : null });

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

  // "Save as PDF" button \u2014 created lazily by the SHARED player (so it ships with the
  // player deploy and reaches every course with no per-course rebuild). It sits next
  // to Submit on the final page and reuses the same print / Save-as-PDF flow as the
  // banner "Save copy". This replaces the old silent HTML auto-download on completion.
  var savePdfBtn = document.getElementById('save-pdf-btn');
  if (!savePdfBtn && nextBtn && nextBtn.parentNode) {
    savePdfBtn = document.createElement('button');
    savePdfBtn.id = 'save-pdf-btn';
    savePdfBtn.className = 'nav-secondary-btn';
    savePdfBtn.type = 'button';
    savePdfBtn.title = 'Save your Course Record as a PDF';
    savePdfBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg><span>Save as PDF</span>';
    savePdfBtn.onclick = function () { aaaOpenSnapshot(); };
    nextBtn.parentNode.insertBefore(savePdfBtn, nextBtn);
  }

  if (isLast) {
    nextBtn.disabled = false;
    nextBtn.textContent = 'Submit Module \u2713';
    nextBtn.classList.add('submit-btn');
    nextBtn.onclick = function() { completeModule(); };
    if (savePdfBtn) savePdfBtn.style.display = '';   // show next to Submit on the final page
  } else {
    nextBtn.textContent = 'Next \u25B6';
    nextBtn.classList.remove('submit-btn');
    nextBtn.onclick = function() { nextPage(); };
    if (savePdfBtn) savePdfBtn.style.display = 'none';
  }

  // Update sidebar
  buildSidebar();
  updateProgress();

  // SCORM bookmark + suspend data. Sequence setLocation -> suspend -> commit so the
  // bookmark and suspend writes both round-trip the bridge BEFORE commit() flushes —
  // otherwise commit can persist a stale snapshot (the OP-462 class of bug).
  // setLocation's OWN failure is swallowed: cmi.location is only a resume fallback,
  // so a failed bookmark must never block the (durable) suspend_data save.
  if (scormReady) {
    scorm.setLocation(String(currentPage)).catch(function() {
      /* failed bookmark must not block the suspend save below */
    }).then(function() {
      return saveSuspendData();
    }).then(function() {
      return scorm.commit();
    }).catch(warnSaveFailed);
  } else {
    saveSuspendData().catch(warnSaveFailed);
  }

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

  // OE-26 (508): do not auto-play video. Videos render with native controls so
  // the learner starts playback. Auto-play violates Section 508 / WCAG.
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
  if (!scorm || typeof scorm.setInteraction !== 'function') return Promise.resolve();

  var pending = [];
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
      submittedAt: new Date(submittedAt).toISOString(),
      // Course-level time context for in-house analytics (alongside per-question latency).
      timerElapsed: timerElapsed,
      sessionTimeSec: timerElapsed,
      totalTimeSec: priorTotalTimeSec + timerElapsed
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
      if (result && typeof result.then === 'function') {
        // Collect each write so the caller can AWAIT delivery into the commit (no
        // longer fire-and-forget). .catch settles failures so one bad write never
        // rejects the batch or blocks submit.
        pending.push(result.catch(function() { /* settle; never block exam submit */ }));
      }
    } catch (e) { /* analytics should never block exam submit */ }
  });
  // Resolve once all interaction writes have SETTLED. They run in parallel and each
  // setInteraction carries its own ~5s timeout, so the batch is bounded (~5s worst
  // case, not N*5s). Awaited before commit so cmi.interactions ride the same flush
  // instead of racing it and getting dropped.
  return Promise.allSettled(pending);
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
  lastQuizPageIndex = currentPage; // R4: bind the completion exam-gate to the exam just submitted (multi-quiz safe)
  updateRefsBtnVisibility();

  var passed = quizScore >= page.requiredScore;
  var scaled = quizScore / 100;
  aaaCheckPrereqs('submitExam', { scaled: scaled, raw: quizScore }); // Phase C

  // Sequence (OP-588 + OP-462/464): persist the exam state to suspend data FIRST — quizSubmitted,
  // quizScore and quizAnswers are already set — so that even if the LMS examSubmit/commit FAILS, a
  // resume restores the selected answers and the learner can simply re-submit instead of redoing the
  // whole exam (the reported Northern Jet / 147573 behaviour). Then AWAIT the per-question
  // interactions, submitExam, re-save, and commit. The interactions are now CHAINED into the
  // sequence (no longer fire-and-forget) so cmi.interactions ride the SAME commit instead of racing
  // it and dropping. Completion is evaluated only afterwards (a premature commit flushed a stale
  // Docebo snapshot).
  saveSuspendData().then(function() {
    return emitQuizInteractions(page, questions, submittedAt, quizAttemptCount);
  }).then(function() {
    return scorm.submitExam({
      scaled: scaled,
      raw: quizScore,
      min: 0,
      max: 100,
      passed: passed
    });
  }).then(function() {
    return saveSuspendData();
  }).then(function() {
    return scorm.commit();
  }).then(function() {
    logEvent('exam', 'persist', 'ok');
    aaaShadowLedgerEmit('exam-submit', { quizScore: quizScore, passed: passed, requiredScore: page.requiredScore, attempt: quizAttemptCount, timerElapsed: timerElapsed }); // Phase B
    checkCompletion();
  }).catch(function(err) {
    logError('exam', 'persist-failed', err ? err.message : 'unknown');
    aaaShowDegraded(); // exam submit/commit failed — warn the learner; the saved answers + record are the safety net
    aaaSendErrorReport('exam:persist-failed', err); // direct error report (best-effort)
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
  var timerMet = aaaTimerMet(); // HARMONIOUS gate: local timerElapsed OR Docebo total_time clears the floor (dark default = local only)
  var modal = document.getElementById('submit-modal');
  var overlay = document.getElementById('submit-modal-overlay');

  // Check for blockers
  var blockers = [];
  if (!allVisited) {
    var remaining = courseData.totalPages - visitedPages.size;
    blockers.push('Visit all pages (' + remaining + ' remaining)');
  }
  if (!timerMet) {
    var secs = courseData.minimumTimeSeconds - aaaTimeBasisSec();
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
  var _examGate = getExamGate(); // R4: single source of truth
  if (_examGate.hasQuiz && !_examGate.passed) {
    var _reqStr = _examGate.requiredScoreValid ? (_examGate.requiredScore + '%') : 'a passing score';
    blockers.push('Pass the exam (requires ' + _reqStr + ')');
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
  // Route the manual Submit through the SINGLE completion path (OP-537). The
  // success/failure UI is gated on the ACTUAL LMS result, so we NEVER show
  // "Submitted Successfully" when the save silently failed \u2014 the old manual-path
  // save bug where a failed commit still claimed success and the learner's
  // completion was never recorded (OP-533/534/555).
  var nextBtn = document.getElementById('next-btn');
  // Immediate "submitting" state so the click feels responsive; replaced by the
  // real outcome once the LMS write resolves.
  modal.innerHTML = '<div class="submit-pending"><h3>Submitting...</h3>' +
    '<p>Saving your completion, one moment.</p></div>';
  overlay.classList.add('active');
  finalizeCompletion({
    source: 'manual-submit',
    onSuccess: function () {
      logEvent('submit', 'commit', 'ok');
      modal.innerHTML = '<div class="submit-success">' +
        '<h3>Module Submitted Successfully</h3>' +
        '<p>This module has been marked as complete. You may now close this window.</p>' +
        '<button class="btn-ok" onclick="document.getElementById(\'submit-modal-overlay\').classList.remove(\'active\')">OK</button>' +
        '</div>';
      nextBtn.disabled = true;
      nextBtn.textContent = 'Submitted \u2713';
    },
    onError: function () {
      // Do NOT claim success and do NOT disable Submit \u2014 let the learner retry.
      // The sticky degraded banner (fired inside finalizeCompletion) + the
      // Save copy button are their safety net.
      modal.innerHTML = '<div class="submit-blocked">' +
        '<h3>We could not confirm your submission was saved</h3>' +
        '<p>The progress tracker had trouble reaching the system. Please use the ' +
        '<b>Save copy</b> button (top of the page) to keep a personal record, then try Submit again.</p>' +
        '<button class="btn-close" onclick="document.getElementById(\'submit-modal-overlay\').classList.remove(\'active\')">OK</button>' +
        '</div>';
    }
  });
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

// CLOCK 1's only output: frozen once inactivity reaches the cap. ONE comparison of two numbers — no flag,
// no presence read, no try/catch, no ternary, no ||. This is the single thing that skips an activity tick.
function aaaTimerFrozen() {
  return aaaInactiveSec >= AAA_INACTIVITY_CAP_SEC;
}

// CLOCK 1's tick: one real second of inactivity. Reset to 0 by aaaResetInactivity on any interaction.
function aaaInactivityTick() {
  aaaInactiveSec++;
}

// Any interaction clears the inactivity clock — which lifts the freeze on the very next activity tick.
function aaaResetInactivity() {
  aaaInactiveSec = 0;
}

// Add one unit to the single engaged-time clock + the per-tick bookkeeping (display, periodic save,
// health heartbeat, completion gate). Pure counter: no timestamps, no wall-clock math.
function incrementTimeActive() {
  timerElapsed++;
  updateTimerDisplay();
  var minSecs = courseData.minimumTimeSeconds || 0;
  // Save every 30 seconds to avoid data loss. Sequence so commit() flushes after the suspend write lands.
  if (timerElapsed % 30 === 0) {
    saveSuspendData().then(function() { return scorm.commit(); }).catch(warnSaveFailed);
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
  // Gate met: use >= with a once-guard so a throttled/coalesced tick can't skip past the exact second.
  if (minSecs > 0 && !timerMetFired && timerElapsed >= minSecs) {
    timerMetFired = true;
    logEvent('timer', 'met', { timerElapsed: timerElapsed });
    checkCompletion();
  }
}

// The ACTIVITY TIMER. The whole rule, every 1025ms: count engaged time UNLESS the (separate) freeze
// timer is set. Nothing more.
function aaaTimerTick() {
  if (!aaaTimerFrozen()) incrementTimeActive();
}

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
  // CLOCK 1 (inactivity, real-time): every interaction resets it to 0; it ticks up once per real second.
  var acts = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click', 'wheel'];
  for (var i = 0; i < acts.length; i++) {
    try { document.addEventListener(acts[i], aaaResetInactivity, { passive: true }); } catch (e) { /* never block the player */ }
  }
  setInterval(aaaInactivityTick, AAA_INACTIVITY_TICK_MS);
  // CLOCK 2 (activity, engaged time at 1025ms): counts one unit unless CLOCK 1 says frozen.
  timerInterval = setInterval(aaaTimerTick, AAA_TICK_MS);
}

function updateTimerDisplay() {
  var el = document.getElementById('timer-display');
  // The learner ALWAYS sees our own local countdown (min - activeTime). It freezes/resumes with the
  // activity clock, and never depends on the network — our local clock is the one the learner watches.
  if (!courseData.minimumTimeSeconds || courseData.minimumTimeSeconds <= 0) {
    el.style.display = 'none';
    return;
  }
  var remaining = Math.max(0, courseData.minimumTimeSeconds - aaaTimeBasisSec());
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

// Broker poll: refresh the Docebo-time store, then refresh the countdown + re-evaluate the completion
// gate. Runs whenever the course is TIME-GATED (always, now) so the submit gate can check the Docebo
// time as an OPTION (the OR). An unreachable broker is swallowed (aaaTimeBasisSec falls back to
// timerElapsed). Read-only GET, no token; never throws into the player.
function aaaPollDoceboTime() {
  try {
    if (!courseData.minimumTimeSeconds) return;
    var learner = String(aaaLearnerId || '');
    var course = String((courseData && courseData.courseId) || '');
    if (!learner || learner === 'anonymous' || !course) return;
    var url = AAA_DOCEBO_TIME_ENDPOINT + '?learner=' + encodeURIComponent(learner) + '&course=' + encodeURIComponent(course);
    fetch(url, { method: 'GET' })
      .then(function (r) { return (r && r.ok) ? r.json() : null; })
      .then(function (j) {
        if (j && typeof j.timeSeconds === 'number') {
          aaaTime = { doceboTimeSec: j.timeSeconds, asOf: Date.now(), ok: true };
          updateTimerDisplay();  // countdown reflects the new value
          checkCompletion();     // re-evaluate the gate now that Docebo time may have crossed the minimum
        }
      })
      .catch(function () { /* broker unreachable -> timerElapsed fallback covers the gate */ });
  } catch (e) { /* the poll must never break the player */ }
}
if (typeof setInterval === 'function') { setInterval(aaaPollDoceboTime, AAA_TIME_POLL_MS); }
aaaPollDoceboTime(); // one immediate attempt (no-op in 'local' mode / before identity is known)

// ===================================================================
// BACKUP-TIME / IDLE add-on — wire the standalone aaa-presence.js module (loaded as its own <script>
// before this one). The HEARTBEAT runs ALWAYS-ON: a hidden, append-only telemetry pulse that records
// OUR own idle-capped active time alongside the local timer and the live Docebo reading, so we keep an
// independent backup in case Docebo's total_time ever looks anomalous. The grayscale IDLE FADE is
// OPT-IN (Docebo/sandbox mode or ?aaaFade=1) and DARK in production. The module is fully decoupled —
// it reads the player only through these injected getters, never touches the completion gate, and is
// wrapped so a fault in it can never throw into the player.
// ===================================================================
// MANDATORY: the idle banner always shows when the clock freezes. The freeze is no longer optional, so
// neither is the explanation — a frozen clock with no banner reads as "my time stopped" (a bug).
var aaaFadeEnabled = true;
// TEST-ONLY: ?aaaIdleSec=N shortens the idle threshold so an end-to-end test can exercise the fade in
// seconds instead of the 5-min default. Harmless in prod (absent ⇒ default 300s); also tightens the
// idle-check tick so the veil appears promptly once the (short) threshold is crossed.
var aaaIdleSec = (function () {
  try {
    var m = (typeof location !== 'undefined') && (location.search || '').match(/[?&]aaaIdleSec=(\d+)\b/);
    return m ? Math.max(1, parseInt(m[1], 10)) : null;
  } catch (e) { return null; }
})();
try {
  if (typeof window !== 'undefined' && window.AaaPresence && typeof window.AaaPresence.start === 'function') {
    var aaaPresenceOpts = {
      emit: function (act, detail) { try { return logEvent('aaa-presence', act, detail); } catch (e) { return null; } },
      getLocalTimerSec: function () { return (typeof timerElapsed !== 'undefined') ? timerElapsed : null; },
      getDoceboTimeSec: function () { try { return (aaaTime && aaaTime.ok && typeof aaaTime.doceboTimeSec === 'number') ? aaaTime.doceboTimeSec : null; } catch (e) { return null; } },
      getSessionSec: function () { try { return timerElapsed; } catch (e) { return null; } },
      getMinimumSec: function () { return (courseData && courseData.minimumTimeSeconds) || null; },
      fade: aaaFadeEnabled
    };
    if (aaaIdleSec) { aaaPresenceOpts.fadeAfterSec = aaaIdleSec; aaaPresenceOpts.tickSec = 1; }
    window.__aaaPresence = window.AaaPresence.start(aaaPresenceOpts);
  }
} catch (e) { /* the presence add-on must never break the player */ }

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
  scorm.commit().catch(function() {});
  scorm.terminate().catch(function() {});
  // Final telemetry flush via keepalive — this is the one transport that
  // survives the unload the SCORM postMessages above cannot be guaranteed to.
  try {
    logEvent('session', 'close', { timerElapsed: timerElapsed, page: currentPage, completed: courseCompleted });
    aaaFlushTelemetry(true);
    aaaShadowLedgerFlush(true);
  } catch (e) { /* never block unload */ }
});

// pagehide (mobile Safari / bfcache) — best-effort duplicate of the unload flush.
window.addEventListener('pagehide', function() {
  try {
    logEvent('session', 'pagehide', { timerElapsed: timerElapsed, page: currentPage, completed: courseCompleted });
    aaaFlushTelemetry(true);
    aaaShadowLedgerFlush(true);
  } catch (e) { /* ignore */ }
});

// BR-FLUSH-DELIVERY: inside Docebo's sandboxed cross-origin iframe, beforeunload is
// unreliable, and a tab-switch or a Docebo SPA route-change fires NEITHER
// beforeunload NOR pagehide — so the last <=15s of telemetry (interval flush) would
// silently never ship. visibilitychange -> hidden DOES fire in those cases, so flush
// there too, using the keepalive/beacon transport in case hidden precedes teardown.
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'hidden') {
    try {
      aaaHarvestLauncher();
      logEvent('session', 'hidden', { timerElapsed: timerElapsed, page: currentPage, completed: courseCompleted });
      aaaFlushTelemetry(true);
      aaaShadowLedgerFlush(true);
    } catch (e) { /* never block on a visibility change */ }
  }
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
    learnerId: aaaLearnerId,
    learnerName: aaaLearnerName,
    sessionId: aaaSessionId,
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
