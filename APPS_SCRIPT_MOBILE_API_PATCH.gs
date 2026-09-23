/**
 * MMS Library — mobile PWA API transport patch
 *
 * Apply this patch in the private Apps Script Code.gs.
 *
 * 1) In doGet(e), keep the existing API branch:
 *      if (e && e.parameter && e.parameter.api) return handleApiGet_(e);
 *
 * 2) Replace the existing handleApiGet_(e) with the version below.
 *
 * This keeps JSONP for normal browsers and adds an iframe/postMessage
 * transport for mobile standalone PWAs.
 */

function handleApiGet_(e) {
  try {
    const p = e.parameter || {};
    const action = String(p.action || '');
    const callback = String(p.callback || '');
    const transport = String(p.transport || '');
    const token = String(p.token || '');
    const origin = String(p.origin || '');

    let data;
    switch (action) {
      case 'health':
        data = healthCheck();
        break;
      case 'dashboard':
        data = getDashboard(p.date);
        break;
      case 'timetable':
        data = getTimetable(p.date);
        break;
      case 'weeklyTimetable':
        data = getWeeklyTimetable(p.date);
        break;
      case 'students':
        data = getStudents({
          search: p.search,
          grade: p.grade,
          section: p.section
        });
        break;
      case 'sections':
        data = getSectionsForGrade(p.grade);
        break;
      case 'attendanceForClass':
        data = getAttendanceForClass(
          p.dateStr || p.date,
          p.grade,
          p.section
        );
        break;
      case 'studentProfile':
        data = getStudentProfile(p.admissionNumber);
        break;
      case 'reports':
        data = getReports(p.month);
        break;
      case 'settings':
        data = getSettings();
        break;
      default:
        throw new Error('Unknown action: ' + action);
    }

    const payload = { ok: true, data: data };

    // Mobile standalone/PWA bridge.
    if (transport === 'message') {
      const safeOrigin = origin && origin !== 'null' ? origin : '*';
      const safeToken = JSON.stringify(token);
      const body = JSON.stringify(payload);

      return ContentService
        .createTextOutput(
          '<!doctype html><html><body><script>' +
          'window.parent.postMessage(' +
          JSON.stringify({
            source: 'mms-library-api',
            token: token,
            ok: true,
            data: data
          }) +
          ',' + JSON.stringify(safeOrigin) +
          ');</script></body></html>'
        )
        .setMimeType(ContentService.MimeType.HTML);
    }

    // Existing JSONP transport.
    if (!callback || !/^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) {
      return jsonOut_({ok:false, error:'Invalid callback'});
    }

    return ContentService
      .createTextOutput(
        callback + '(' + JSON.stringify(payload) + ')'
      )
      .setMimeType(ContentService.MimeType.JAVASCRIPT);

  } catch (err) {
    const p = (e && e.parameter) || {};
    const callback = String(p.callback || '');
    const transport = String(p.transport || '');
    const token = String(p.token || '');
    const origin = String(p.origin || '');
    const message = String(err && err.message || err);

    if (transport === 'message') {
      const safeOrigin = origin && origin !== 'null' ? origin : '*';

      return ContentService
        .createTextOutput(
          '<!doctype html><html><body><script>' +
          'window.parent.postMessage(' +
          JSON.stringify({
            source: 'mms-library-api',
            token: token,
            ok: false,
            error: message
          }) +
          ',' + JSON.stringify(safeOrigin) +
          ');</script></body></html>'
        )
        .setMimeType(ContentService.MimeType.HTML);
    }

    if (callback && /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) {
      return ContentService
        .createTextOutput(
          callback + '(' + JSON.stringify({ok:false, error:message}) + ')'
        )
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }

    return jsonOut_({ok:false, error:message});
  }
}
