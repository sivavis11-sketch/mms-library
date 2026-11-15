/**
 * MMS Library — remove a student
 *
 * Copy this file into the Apps Script project next to Code.gs.
 * It uses the SPREADSHEET_ID constant that Code.gs already defines.
 *
 * Also add this to the POST routing in Code.gs (doPost), next to moveStudent:
 *
 *     case 'deleteStudent':
 *       data = deleteStudent(payload);
 *       break;
 *
 * (APPS_SCRIPT_API_BRIDGE.gs already routes it for the Apps Script page.)
 *
 * Payload: { "admissionNumber": "ADM001" }
 *
 * Rules:
 * - Removes the student's row from the "Students" tab only.
 * - Attendance and reading assessment rows are kept, so old reports still
 *   have their history.
 */
function deleteStudent(payload) {
  const admission = String((payload && payload.admissionNumber) || '').trim();
  if (!admission) throw new Error('Admission number is required.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Students');
    if (!sheet) throw new Error('Students sheet not found.');

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('Student not found: ' + admission);

    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]).trim() === admission) {
        sheet.deleteRow(i + 2);
        return { ok: true, admissionNumber: admission };
      }
    }
    throw new Error('Student not found: ' + admission);
  } finally {
    lock.releaseLock();
  }
}
