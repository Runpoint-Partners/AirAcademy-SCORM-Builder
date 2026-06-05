'use strict';

/**
 * Generates imsmanifest.xml for a SCORM 2004 4th Edition package.
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

  // Escape XML special characters in the course name
  const escapedName = String(courseName)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="AAA_${courseId}_${networkId}"
  version="1.0"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3"
  xmlns:adlseq="http://www.adlnet.org/xsd/adlseq_v1p3"
  xmlns:adlnav="http://www.adlnet.org/xsd/adlnav_v1p3"
  xmlns:imsss="http://www.imsglobal.org/xsd/imsss"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="
    http://www.imsglobal.org/xsd/imscp_v1p1 imscp_v1p1.xsd
    http://www.adlnet.org/xsd/adlcp_v1p3 adlcp_v1p3.xsd
    http://www.adlnet.org/xsd/adlseq_v1p3 adlseq_v1p3.xsd
    http://www.adlnet.org/xsd/adlnav_v1p3 adlnav_v1p3.xsd
    http://www.imsglobal.org/xsd/imsss imsss_v1p0.xsd">

  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>2004 4th Edition</schemaversion>
  </metadata>

  <organizations default="ORG-001">
    <organization identifier="ORG-001">
      <title>${escapedName}</title>
      <item identifier="ITEM-001" identifierref="RES-001" isvisible="true">
        <title>${escapedName}</title>

        <!-- Sequencing: single SCO, no LMS-managed sequencing -->
        <imsss:sequencing>
          <imsss:controlMode
            choice="true"
            flow="true"
            choiceExit="true"
            forwardOnly="false" />
          <imsss:deliveryControls
            completionSetByContent="true"
            objectiveSetByContent="true" />
        </imsss:sequencing>

        <!-- Disable LMS-provided navigation UI; course handles its own nav -->
        <adlnav:presentation>
          <adlnav:navigationInterface>
            <adlnav:hideLMSUI>previous</adlnav:hideLMSUI>
            <adlnav:hideLMSUI>continue</adlnav:hideLMSUI>
            <adlnav:hideLMSUI>exit</adlnav:hideLMSUI>
            <adlnav:hideLMSUI>abandon</adlnav:hideLMSUI>
          </adlnav:navigationInterface>
        </adlnav:presentation>
      </item>
    </organization>
  </organizations>

  <resources>
    <resource identifier="RES-001"
      type="webcontent"
      adlcp:scormType="sco"
      href="launcher.html">
      <file href="launcher.html" />
    </resource>
  </resources>

</manifest>`;
}

module.exports = { generateManifest };
