'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Generates imsmanifest.xml for a SCORM 2004 4th Edition package.
 *
 * Mirrors generateLauncher: the XML body is a declarative artifact
 * (runtime/manifest-template.xml) with {{PLACEHOLDER}} holes; this function only fills them.
 * The ONLY per-course variance is the package identifier (courseId + networkId) and the course
 * title (×2). The title is the lone bit of irreducible logic — it must be XML-escaped before
 * substitution. Everything else (schema, sequencing, nav-hiding, the launcher.html resource) is
 * constant boilerplate living in the template.
 *
 * @param {Object} opts
 * @param {string} opts.courseId   - Numeric course ID (e.g. "100007")
 * @param {string} opts.networkId - Customer network ID (e.g. "668")
 * @param {string} opts.courseName - Human-readable course title
 * @returns {string} The complete imsmanifest.xml content
 */
function generateManifest({ courseId, networkId, courseName }) {
  if (!courseId) throw new Error('courseId is required');
  if (!networkId) throw new Error('networkId is required');
  if (!courseName) throw new Error('courseName is required');

  // Escape XML special characters in the course name (the only non-template logic).
  const escapedName = String(courseName)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const templatePath = path.join(__dirname, '..', '..', 'runtime', 'manifest-template.xml');
  // Normalize CRLF→LF so file storage (git autocrlf / editors) can never drift the bytes — the
  // pre-template output was a JS template literal (LF), and the golden-parity test pins LF.
  let xml = fs.readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n');

  xml = xml.split('{{COURSE_ID}}').join(courseId);
  xml = xml.split('{{NETWORK_ID}}').join(networkId);
  xml = xml.split('{{TITLE}}').join(escapedName);

  return xml;
}

module.exports = { generateManifest };
