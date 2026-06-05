'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONTENT_BASE_URL = 'https://aaa-courses.s3.us-east-2.amazonaws.com';

/**
 * Generates launcher.html for a dynamic SCORM 2004 package.
 *
 * Reads the launcher template from packages/course-player/src/launcher-template.html
 * and substitutes configuration placeholders with the provided values.
 *
 * @param {Object} opts
 * @param {string} opts.courseId       - Numeric course ID
 * @param {string} opts.networkId      - Customer network ID
 * @param {string} opts.contentVersion - Content version for cache-busting (e.g. "1")
 * @param {string} [opts.contentBaseUrl] - Base URL for content; defaults to S3 bucket
 * @param {string} [opts.contentUrl] - Direct content URL (e.g. presigned S3 URL); overrides constructed URL
 * @returns {string} The complete launcher.html content
 */
function generateLauncher({ courseId, networkId, contentVersion, contentBaseUrl, contentUrl }) {
  if (!courseId) throw new Error('courseId is required');
  if (!networkId) throw new Error('networkId is required');
  if (!contentVersion) throw new Error('contentVersion is required');

  const baseUrl = contentBaseUrl || DEFAULT_CONTENT_BASE_URL;
  // Derive allowed origin from the content URL or base URL
  const originSource = contentUrl || baseUrl;
  const urlObj = new URL(originSource);
  const allowedOrigin = urlObj.origin;

  const templatePath = path.join(__dirname, '..', '..', 'runtime', 'launcher-template.html');
  // Normalize CRLF→LF to match template literal behavior (JS spec normalizes CRLF in template literals)
  let html = fs.readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n');

  html = html.split('{{CONTENT_BASE_URL}}').join(baseUrl);
  html = html.split('{{COURSE_ID}}').join(courseId);
  html = html.split('{{NETWORK_ID}}').join(networkId);
  html = html.split('{{CONTENT_VERSION}}').join(contentVersion);
  html = html.split('{{ALLOWED_ORIGIN}}').join(allowedOrigin);
  html = html.split('{{CONTENT_URL}}').join(contentUrl || '');

  return html;

}

module.exports = { generateLauncher };
