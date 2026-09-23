/**
 * MMS Library — Apps Script frontend bridge
 *
 * This file contains no spreadsheet IDs or secrets.
 * It adapts the shared frontend to google.script.run when
 * Index.html is hosted by Apps Script.
 */

function libraryApiGet(action, params) {
  const p = params || {};
  const a = String(action || '');

  switch (a) {
    case 'health':
      return healthCheck();

    case 'dashboard':
      return getDashboard(p.date);

    case 'timetable':
      return getTimetable(p.date);

    case 'weeklyTimetable':
      return getWeeklyTimetable(p.date);

    case 'students':
      return getStudents({
        search: p.search,
        grade: p.grade,
        section: p.section
      });

    case 'sections':
      return getSectionsForGrade(p.grade);

    case 'attendanceForClass':
      return getAttendanceForClass(
        p.dateStr || p.date,
        p.grade,
        p.section
      );

    case 'studentProfile':
      return getStudentProfile(p.admissionNumber);

    case 'reports':
      return getReports(p.month);

    case 'settings':
      return getSettings();

    default:
      throw new Error('Unknown GET action: ' + a);
  }
}

function libraryApiPost(action, payload) {
  const p = payload || {};
  const a = String(action || '');

  switch (a) {
    case 'saveAttendance':
      return saveAttendance(p);

    case 'saveReadingAssessment':
      return saveReadingAssessment(p);

    case 'addStudent':
      return addStudent(p);

    case 'updateStudent':
      return updateStudent(p);

    case 'moveStudent':
      return moveStudent(p);

    default:
      throw new Error('Unknown POST action: ' + a);
  }
}
