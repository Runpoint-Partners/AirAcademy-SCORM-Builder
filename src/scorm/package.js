'use strict';

const archiver = require('archiver');
const { generateManifest } = require('./manifest');
const { generateLauncher } = require('./launcher');

/**
 * Creates a SCORM 2004 ZIP package containing imsmanifest.xml and launcher.html.
 *
 * @param {Object} opts
 * @param {string} opts.courseId        - Numeric course ID
 * @param {string} opts.networkId       - Customer network ID
 * @param {string} opts.courseName      - Human-readable course title
 * @param {string} opts.contentVersion  - Content version for cache-busting
 * @param {string} [opts.contentBaseUrl] - Base URL for content; defaults to S3 bucket
 * @param {string} [opts.contentUrl] - Direct content URL (e.g. presigned S3 URL)
 * @returns {Promise<Buffer>} The SCORM ZIP as a Buffer
 */
async function createScormPackage({ courseId, networkId, courseName, contentVersion, contentBaseUrl, contentUrl }) {
  // courseName is no longer used (no SCO <title> in the manifest — Docebo inherits the real course
  // name). It stays in createScormPackage's signature only for API stability with existing callers.
  const manifest = generateManifest({ courseId, networkId });
  const launcher = generateLauncher({ courseId, networkId, contentVersion, contentBaseUrl, contentUrl });

  return new Promise((resolve, reject) => {
    const chunks = [];

    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', (err) => reject(err));

    archive.append(manifest, { name: 'imsmanifest.xml' });
    archive.append(launcher, { name: 'launcher.html' });

    archive.finalize();
  });
}

module.exports = { createScormPackage };
