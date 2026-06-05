/**
 * ScormClient -- content-side SCORM 2004 bridge client
 *
 * Browser-side library that S3-hosted course content uses to communicate
 * with the Docebo-hosted launcher via postMessage. Provides a Promise-based
 * API that abstracts the postMessage bridge so course rendering code never
 * deals with raw postMessage.
 *
 * Usage:
 *   <script src="scorm-client.js"></script>
 *   <script>
 *     const scorm = new ScormClient();
 *     const session = await scorm.init();
 *     // session = { connected, entry, location, suspendData, ... }
 *
 *     await scorm.setLocation('14');
 *     await scorm.setSuspendData(JSON.stringify(state));
 *     await scorm.setInteraction({
 *       id: 'exam-q1',
 *       type: 'choice',
 *       learnerResponse: 'A',
 *       result: 'correct'
 *     });
 *     await scorm.setCompletionStatus('completed');
 *     await scorm.submitExam({ scaled: 0.85, raw: 85, min: 0, max: 100, passed: true });
 *     await scorm.terminate();
 *   </script>
 *
 * Protocol:
 *   Request  (content -> launcher): { type: "aaa-scorm", id, action, payload }
 *   Response (launcher -> content): { type: "aaa-scorm-response", id, success, payload }
 *
 * Standalone/preview mode:
 *   If no launcher responds to the handshake within the timeout period,
 *   ScormClient enters standalone mode. All methods resolve with safe
 *   defaults rather than rejecting, allowing content to run outside an
 *   LMS for previewing and testing.
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------
  // Default session state returned when running in standalone mode
  // (no launcher present, e.g. direct S3 preview)
  // -------------------------------------------------------------------
  var STANDALONE_SESSION = {
    connected: false,
    entry: 'ab-initio',
    completionStatus: 'not attempted',
    successStatus: 'unknown',
    location: '',
    suspendData: '',
    scoreScaled: '',
    scoreRaw: '',
    learnerName: 'Preview User',
    learnerId: 'preview',
    interactions: []
  };

  /**
   * @constructor
   * @param {Object} [options]
   * @param {string} [options.targetOrigin='*']  Origin to use when posting to the launcher.
   * @param {number} [options.timeout=5000]      Timeout (ms) for each request.
   * @param {string} [options.launcherOrigin]     Expected origin of the launcher. If set,
   *                                              incoming messages from other origins are ignored.
   */
  function ScormClient(options) {
    options = options || {};
    this._targetOrigin = options.targetOrigin || '*';
    this._timeout = options.timeout || 5000;
    this._launcherOrigin = options.launcherOrigin || null;
    // Optional host hook: invoked (action, error) on ANY genuine send/receive
    // failure with the LMS, so the host (player) can trip a degraded-mode warning.
    // See _fireSendError for the two deliberate exclusions (handshake / unknown action).
    this._onSendError = typeof options.onSendError === 'function' ? options.onSendError : null;
    this._requestCounter = 0;
    this._pending = new Map();
    this._initialized = false;
    this._standalone = false;
    this._sessionData = null;
    this._interactions = [];

    // Bind and register the message listener
    this._onMessage = this._handleMessage.bind(this);
    window.addEventListener('message', this._onMessage, false);
  }

  // -------------------------------------------------------------------
  // PUBLIC API
  // -------------------------------------------------------------------

  /**
   * Perform the handshake with the launcher.
   * Resolves with the session state object. Must be called before any
   * other method.
   *
   * In standalone mode (no launcher responds within timeout), resolves
   * with safe defaults so the content can still render for preview.
   *
   * @returns {Promise<Object>} Session state from the LMS
   */
  ScormClient.prototype.init = function init() {
    var self = this;
    return this._send('handshake', {}).then(
      function (payload) {
        self._initialized = true;
        self._standalone = false;
        self._sessionData = payload;
        self._interactions = Array.isArray(payload.interactions) ? payload.interactions.slice() : [];
        return payload;
      },
      function () {
        // Timeout or error -- enter standalone mode
        self._initialized = true;
        self._standalone = true;
        self._sessionData = Object.assign({}, STANDALONE_SESSION);
        self._interactions = [];
        return self._sessionData;
      }
    );
  };

  /**
   * Set cmi.completion_status.
   * @param {string} status - "completed"|"incomplete"|"not attempted"|"unknown"
   * @returns {Promise<Object>}
   */
  ScormClient.prototype.setCompletionStatus = function setCompletionStatus(status) {
    if (this._standalone) return Promise.resolve({});
    return this._send('setCompletionStatus', { status: status });
  };

  /**
   * Set cmi.success_status.
   * @param {string} status - "passed"|"failed"|"unknown"
   * @returns {Promise<Object>}
   */
  ScormClient.prototype.setSuccessStatus = function setSuccessStatus(status) {
    if (this._standalone) return Promise.resolve({});
    return this._send('setSuccessStatus', { status: status });
  };

  /**
   * Set cmi.score.* fields.
   * @param {Object} score - { scaled: 0.0-1.0, raw: 0-100, min: 0, max: 100 }
   * @returns {Promise<Object>}
   */
  ScormClient.prototype.setScore = function setScore(score) {
    if (this._standalone) return Promise.resolve({});
    return this._send('setScore', score);
  };

  /**
   * Set cmi.location (bookmark).
   * @param {string} location - Page index or custom bookmark string (max 1000 chars)
   * @returns {Promise<Object>}
   */
  ScormClient.prototype.setLocation = function setLocation(location) {
    if (this._standalone) return Promise.resolve({});
    return this._send('setLocation', { location: String(location) });
  };

  /**
   * Set one cmi.interactions entry for exam analytics.
   *
   * Preferred usage:
   *   setInteraction({
   *     id: 'exam-q1',
   *     type: 'choice',
   *     learnerResponse: 'A',
   *     correctResponse: 'B',
   *     result: 'incorrect',
   *     description: 'Question text'
   *   })
   *
   * Backward-compatible shorthand forms are also accepted:
   *   setInteraction('exam-q1', { learnerResponse: 'A', result: 'correct' })
   *   setInteraction('exam-q1', 'A', 'correct', { type: 'choice' })
   *
   * The client keeps a local copy so content can inspect what has been
   * reported even in standalone mode or when an older launcher does not yet
   * support the setInteraction action.
   *
   * @param {Object|string} interactionOrId
   * @param {Object|string} [detailsOrLearnerResponse]
   * @param {string} [result]
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  ScormClient.prototype.setInteraction = function setInteraction(
    interactionOrId,
    detailsOrLearnerResponse,
    result,
    options
  ) {
    var interaction;
    var tracked;

    try {
      interaction = this._normalizeInteraction(
        interactionOrId,
        detailsOrLearnerResponse,
        result,
        options
      );
      tracked = this._trackInteraction(interaction);
    } catch (error) {
      return Promise.reject(error);
    }

    if (this._standalone) {
      return Promise.resolve({ interaction: tracked });
    }

    return this._send('setInteraction', tracked).then(
      function (payload) {
        return payload;
      },
      function (error) {
        // Older launchers will not know about this protocol action yet. Keep
        // the local ledger intact and resolve so analytics calls do not break
        // completion, bookmarking, or exam submission.
        if (error && /Unknown action:\s*setInteraction/.test(error.message)) {
          return { unsupported: true, interaction: tracked };
        }
        throw error;
      }
    );
  };

  /**
   * Get interactions reported through setInteraction().
   * Returns a copy so callers cannot mutate the client's internal ledger.
   * @returns {Object[]}
   */
  ScormClient.prototype.getInteractions = function getInteractions() {
    return this._interactions.map(function (interaction) {
      return Object.assign({}, interaction);
    });
  };

  /**
   * Set cmi.suspend_data.
   * @param {string|Object} data - JSON string or object (max 64KB when serialized)
   * @returns {Promise<Object>}
   */
  ScormClient.prototype.setSuspendData = function setSuspendData(data) {
    if (typeof data !== 'string') {
      data = JSON.stringify(data);
    }
    if (data.length > 65536) {
      return Promise.reject(new Error('suspend_data exceeds 64KB limit'));
    }
    if (this._standalone) return Promise.resolve({});
    return this._send('setSuspendData', { data: data });
  };

  /**
   * Get cmi.suspend_data.
   * @returns {Promise<string>} The stored suspend data string
   */
  ScormClient.prototype.getSuspendData = function getSuspendData() {
    if (this._standalone) {
      return Promise.resolve(this._sessionData ? this._sessionData.suspendData || '' : '');
    }
    return this._send('getSuspendData', {}).then(function (payload) {
      return payload.data;
    });
  };

  /**
   * Get any cmi.* value.
   * @param {string} key - SCORM data model element (e.g., "cmi.learner_name")
   * @returns {Promise<string>}
   */
  ScormClient.prototype.getValue = function getValue(key) {
    if (this._standalone) return Promise.resolve('');
    return this._send('getState', { key: key }).then(function (payload) {
      return payload.value;
    });
  };

  /**
   * Set any cmi.* value.
   * @param {string} key - SCORM data model element
   * @param {string} value
   * @returns {Promise<Object>}
   */
  ScormClient.prototype.setValue = function setValue(key, value) {
    if (this._standalone) return Promise.resolve({});
    return this._send('setState', { key: key, value: String(value) });
  };

  /**
   * Force an immediate commit.
   * @returns {Promise<Object>}
   */
  ScormClient.prototype.commit = function commit() {
    if (this._standalone) return Promise.resolve({});
    return this._send('commit', {});
  };

  /**
   * Submit exam results in one atomic call.
   * Sets score, success_status, and completion_status.
   * @param {Object} result - { scaled, raw, min, max, passed }
   * @returns {Promise<Object>}
   */
  ScormClient.prototype.submitExam = function submitExam(result) {
    if (this._standalone) return Promise.resolve({});
    return this._send('examSubmit', {
      scaled: result.scaled,
      raw: result.raw,
      min: result.min !== undefined ? result.min : 0,
      max: result.max !== undefined ? result.max : 100,
      passed: !!result.passed
    });
  };

  /**
   * Terminate the SCORM session. Call on course exit.
   * After this call, no further SCORM operations are possible.
   * @returns {Promise<void>}
   */
  ScormClient.prototype.terminate = function terminate() {
    var self = this;
    if (this._standalone) {
      this._initialized = false;
      window.removeEventListener('message', this._onMessage);
      return Promise.resolve();
    }
    return this._send('terminate', {}).then(function () {
      self._initialized = false;
      window.removeEventListener('message', self._onMessage);
    });
  };

  /**
   * Retrieve the launcher's flight recorder log via postMessage.
   * Returns the combined launcher log entries for diagnostics.
   * @returns {Promise<Object[]>}
   */
  ScormClient.prototype.getFlightLog = function getFlightLog() {
    if (this._standalone) return Promise.resolve([]);
    return this._send('getFlightLog', {}).then(function (payload) {
      return payload.log || [];
    }).catch(function () {
      return [];
    });
  };

  /**
   * Clean up event listener without terminating SCORM session.
   * Use when the content iframe is being unloaded.
   */
  ScormClient.prototype.destroy = function destroy() {
    window.removeEventListener('message', this._onMessage);
    this._pending.forEach(function (entry) {
      clearTimeout(entry.timer);
      entry.reject(new Error('ScormClient destroyed'));
    });
    this._pending.clear();
  };

  /**
   * Whether the client is running in standalone/preview mode
   * (no launcher responded to the handshake).
   * @returns {boolean}
   */
  ScormClient.prototype.isStandalone = function isStandalone() {
    return this._standalone;
  };

  // -------------------------------------------------------------------
  // INTERNALS
  // -------------------------------------------------------------------

  /**
   * Generate a unique request ID.
   * Format: req_{timestamp}_{counter} (zero-padded to 3 digits).
   * @returns {string}
   */
  ScormClient.prototype._generateId = function _generateId() {
    this._requestCounter++;
    var counter = String(this._requestCounter);
    while (counter.length < 3) counter = '0' + counter;
    return 'req_' + Date.now() + '_' + counter;
  };

  /**
   * Normalize supported setInteraction call shapes into one payload.
   * @returns {Object}
   */
  ScormClient.prototype._normalizeInteraction = function _normalizeInteraction(
    interactionOrId,
    detailsOrLearnerResponse,
    result,
    options
  ) {
    var interaction;

    if (interactionOrId && typeof interactionOrId === 'object') {
      interaction = Object.assign({}, interactionOrId);
    } else {
      interaction = { id: interactionOrId };
      if (
        detailsOrLearnerResponse &&
        typeof detailsOrLearnerResponse === 'object' &&
        !Array.isArray(detailsOrLearnerResponse)
      ) {
        interaction = Object.assign(interaction, detailsOrLearnerResponse);
      } else {
        interaction.learnerResponse = detailsOrLearnerResponse;
        interaction.result = result;
        if (options && typeof options === 'object') {
          interaction = Object.assign(interaction, options);
        }
      }
    }

    if (interaction.id === undefined || interaction.id === null || interaction.id === '') {
      throw new Error('interaction.id is required');
    }

    interaction.id = String(interaction.id);
    if (interaction.type === undefined) interaction.type = 'choice';

    if (interaction.learnerResponse === undefined && interaction.learner_response !== undefined) {
      interaction.learnerResponse = interaction.learner_response;
    }
    if (interaction.correctResponse === undefined && interaction.correct_response !== undefined) {
      interaction.correctResponse = interaction.correct_response;
    }
    if (interaction.correctResponse === undefined && interaction.correctResponses !== undefined) {
      interaction.correctResponse = interaction.correctResponses;
    }
    if (interaction.timestamp === undefined) {
      interaction.timestamp = new Date().toISOString();
    }

    return interaction;
  };

  /**
   * Store each interaction payload in order. Repeated ids are allowed so
   * quiz retakes preserve each submitted attempt instead of overwriting the
   * prior one.
   * @returns {Object} Stored copy
   */
  ScormClient.prototype._trackInteraction = function _trackInteraction(interaction) {
    var tracked = Object.assign({}, interaction);
    this._interactions.push(tracked);
    return Object.assign({}, tracked);
  };

  /**
   * Send a request to the launcher via postMessage and return a Promise
   * that resolves when the matching response arrives.
   *
   * @param {string} action - The action name (e.g. 'handshake', 'setCompletionStatus')
   * @param {Object} payload - Action-specific data
   * @returns {Promise<Object>}
   */
  ScormClient.prototype._send = function _send(action, payload) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var id = self._generateId();

      var timer = setTimeout(function () {
        self._pending.delete(id);
        var err = new Error('ScormClient timeout: ' + action + ' (id=' + id + ')');
        self._fireSendError(action, err);
        reject(err);
      }, self._timeout);

      self._pending.set(id, { resolve: resolve, reject: reject, timer: timer, action: action });

      var msg = {
        type: 'aaa-scorm',
        id: id,
        action: action,
        payload: payload
      };

      // Post to parent window (the launcher)
      window.parent.postMessage(msg, self._targetOrigin);
    });
  };

  /**
   * Handle incoming postMessage events from the launcher.
   * Validates origin and message format before resolving pending requests.
   *
   * @param {MessageEvent} event
   */
  ScormClient.prototype._handleMessage = function _handleMessage(event) {
    // Origin validation: if a launcherOrigin is configured, only accept
    // messages from that origin. This prevents other frames or browser
    // extensions from injecting fake responses.
    if (this._launcherOrigin && event.origin !== this._launcherOrigin) {
      return;
    }

    var msg = event.data;

    // Ignore messages that are not ScormClient responses
    if (!msg || msg.type !== 'aaa-scorm-response' || !msg.id) {
      return;
    }

    var pending = this._pending.get(msg.id);
    if (!pending) return;

    this._pending.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.success) {
      pending.resolve(msg.payload || {});
    } else {
      var errorMsg = (msg.payload && msg.payload.error) || 'SCORM operation failed';
      var err = new Error(errorMsg);
      this._fireSendError(pending.action, err);
      pending.reject(err);
    }
  };

  /**
   * Notify the host of ANY LMS send/receive failure — timeout OR a success:false
   * response, reads and writes alike. Maximum sensitivity by design: if we can't
   * talk to the LMS in either direction, the saved record is at risk and the
   * learner must be told. Logging alone is useless inside an embedded iframe.
   *
   * The ONLY exclusion is 'handshake': a failed handshake is the normal
   * standalone/preview fallback (no launcher present). When the player is truly
   * embedded but the handshake still fails, the host detects that separately
   * (isStandalone() && parent !== self) and trips the warning itself — so a real
   * connect failure is still surfaced; we just don't false-trip top-level previews.
   *
   * Note: an 'Unknown action' rejection (launcher doesn't support a verb) is NO
   * longer suppressed. With the launcher and player co-deployed, that signals a
   * version mismatch — genuinely off the happy path — so it trips the warning.
   *
   * @param {string} action
   * @param {Error} err
   */
  ScormClient.prototype._fireSendError = function _fireSendError(action, err) {
    if (action === 'handshake') return;
    if (typeof this._onSendError === 'function') {
      try { this._onSendError(action, err); } catch (e) { /* a warning must never break the bridge */ }
    }
  };

  // -------------------------------------------------------------------
  // EXPORT
  // -------------------------------------------------------------------
  window.ScormClient = ScormClient;

})();
