'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Generates imsmanifest.xml for a SCORM 2004 3rd Edition package.
 *
 * Mirrors generateLauncher: the XML body is a declarative artifact
 * (runtime/manifest-template.xml) with {{PLACEHOLDER}} holes; this function only fills them.
 * The ONLY sanctioned per-course variables are COURSE_ID + NETWORK_ID (composed into the package
 * identifier). There is NO title — Docebo inherits the real course name for the SCO (verified in
 * sandbox), and net+id are the same inseparable pair already baked into the launcher. Everything else
 * (schema, sequencing, nav-hiding, the launcher.html resource) is constant boilerplate in the template.
 *
 * @param {Object} opts
 * @param {string} opts.courseId  - Numeric course ID (e.g. "100007")
 * @param {string} opts.networkId - Customer network ID (e.g. "668")
 * @returns {string} The complete imsmanifest.xml content
 */
function generateManifest({ courseId, networkId }) {
  if (!courseId) throw new Error('courseId is required');
  if (!networkId) throw new Error('networkId is required');

  const templatePath = path.join(__dirname, '..', '..', 'runtime', 'manifest-template.xml');
  // Normalize CRLF→LF so file storage (git autocrlf / editors) can never drift the bytes —
  // the golden-parity test pins LF.
  let xml = fs.readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n');

  xml = xml.split('{{COURSE_ID}}').join(courseId);
  xml = xml.split('{{NETWORK_ID}}').join(networkId);

  return xml;
}

module.exports = { generateManifest };
