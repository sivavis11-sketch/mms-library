/* MMS Library — app shell, router, and views */

const RUBRIC_KEYS = ['fluency','accuracy','vocabulary','comprehension','expression','confidence'];
const RUBRIC_LABELS = {
  fluency:'Fluency', accuracy:'Accuracy', vocabulary:'Vocabulary',
  comprehension:'Comprehension', expression:'Expression', confidence:'Confidence'
};
const GRADES = ['1','2','3','4','5','6','7','8','9','10','11','12'];

const state = {
  route: 'dashboard',
  params: {},
};

/* ---------------- API client ---------------- */
/*
 * MMS Library supports two runtimes:
 * 1) GitHub/PWA: cross-origin JSONP + form POST to the deployed Apps Script API.
 * 2) Apps Script HtmlService: use google.script.run directly. This avoids
 *    the HtmlService sandbox/CSP blocking the JSONP <script> request.
 */
function appsScriptRuntime() {
  return typeof google !== 'undefined' &&
    google.script &&
    google.script.run;
}

function apiConfigured() {
  if (appsScriptRuntime()) return true;
  return typeof API_URL === 'string' && API_URL && !API_URL.includes('PASTE_YOUR');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const API_TIMEOUT_MS = 9000;
const API_RETRIES = 2;
const pendingGets = new Map();
const sectionCache = new Map();
const SECTION_CACHE_MS = 5 * 60 * 1000;

function appsScriptGet(action, params) {
  return new Promise((resolve, reject) => {
    google.script.run
      .withSuccessHandler(resolve)
      .withFailureHandler(err => reject(new Error(String(err && err.message || err || 'Apps Script request failed'))))
      .libraryApiGet(action, params || {});
  });
}

function appsScriptPost(action, payload) {
  return new Promise((resolve, reject) => {
    google.script.run
      .withSuccessHandler(resolve)
      .withFailureHandler(err => reject(new Error(String(err && err.message || err || 'Apps Script request failed'))))
      .libraryApiPost(action, payload || {});
  });
}

function jsonpRequest(params, attempt = 0) {
  return new Promise((resolve, reject) => {
    const cb = '__mmsPwaCb_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    let settled = false;

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Request timed out'));
    }, API_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      try { delete window[cb]; } catch (err) {}
      try { script.remove(); } catch (err) {}
    }

    window[cb] = (json) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (!json || !json.ok) {
        reject(new Error((json && json.error) || 'Request failed'));
        return;
      }

      resolve(json.data);
    };

    script.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Failed to reach library server'));
    };

    const query = new URLSearchParams({
      ...params,
      callback: cb,
      _t: Date.now().toString()
    });

    script.src = API_URL + '?' + query.toString();
    document.head.appendChild(script);
  });
}

async function apiGet(action, params) {
  if (!apiConfigured()) throw new Error('CONFIG_MISSING');

  if (appsScriptRuntime()) {
    const requestParams = { ...(params || {}) };
    const key = 'apps-script:' + action + ':' + JSON.stringify(requestParams);

    if (pendingGets.has(key)) return pendingGets.get(key);

    if (action === 'sections' && requestParams.grade) {
      const cached = sectionCache.get(String(requestParams.grade));
      if (cached && Date.now() - cached.time < SECTION_CACHE_MS) {
        return cached.data;
      }
    }

    const request = (async () => {
      const data = await appsScriptGet(action, requestParams);
      if (action === 'sections' && requestParams.grade) {
        sectionCache.set(String(requestParams.grade), {
          time: Date.now(),
          data
        });
      }
      return data;
    })();

    pendingGets.set(key, request);
    try {
      return await request;
    } finally {
      pendingGets.delete(key);
    }
  }

  const requestParams = { api: '1', action, ...(params || {}) };
  const key = JSON.stringify(requestParams);

  if (pendingGets.has(key)) return pendingGets.get(key);

  if (action === 'sections' && requestParams.grade) {
    const cached = sectionCache.get(String(requestParams.grade));
    if (cached && Date.now() - cached.time < SECTION_CACHE_MS) {
      return cached.data;
    }
  }

  const request = (async () => {
    let lastError;

    for (let attempt = 0; attempt <= API_RETRIES; attempt++) {
      try {
        const data = await jsonpRequest(requestParams, attempt);

        if (action === 'sections' && requestParams.grade) {
          sectionCache.set(String(requestParams.grade), {
            time: Date.now(),
            data
          });
        }

        return data;
      } catch (err) {
        lastError = err;
        if (attempt < API_RETRIES) {
          await sleep(600 + attempt * 900);
        }
      }
    }

    throw lastError || new Error('Unable to load library data');
  })();

  pendingGets.set(key, request);

  try {
    return await request;
  } finally {
    pendingGets.delete(key);
  }
}

async function apiPost(action, payload) {
  if (!apiConfigured()) throw new Error('CONFIG_MISSING');

  if (appsScriptRuntime()) {
    return appsScriptPost(action, payload || {});
  }

  return new Promise((resolve, reject) => {
    const iframeName =
      'api_post_' +
      Date.now() +
      '_' +
      Math.random().toString(36).slice(2);

    const iframe = document.createElement('iframe');
    iframe.name = iframeName;
    iframe.style.display = 'none';
    document.body.appendChild(iframe);

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = API_URL;
    form.target = iframeName;
    form.style.display = 'none';

    const payloadInput = document.createElement('input');
    payloadInput.type = 'hidden';
    payloadInput.name = 'payload';
    payloadInput.value = JSON.stringify({
      action: action,
      payload: payload || {}
    });

    form.appendChild(payloadInput);
    document.body.appendChild(form);

    let completed = false;

    function cleanup() {
      setTimeout(() => {
        try { form.remove(); } catch (err) {}
        try { iframe.remove(); } catch (err) {}
      }, 500);
    }

    function finish() {
      if (completed) return;
      completed = true;
      cleanup();
      resolve({ ok: true });
    }

    iframe.onload = finish;

    iframe.onerror = () => {
      if (completed) return;
      completed = true;
      cleanup();
      reject(new Error('Unable to send request to the library server.'));
    };

    try {
      form.submit();
      setTimeout(() => {
        if (!completed) finish();
      }, 3000);
    } catch (err) {
      if (!completed) {
        completed = true;
        cleanup();
        reject(err);
      }
    }
  });
}

/* ---------------- helpers ---------------- */
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function niceDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
function setLoading(el) { el.innerHTML = '<div class="loading"><div class="spinner"></div>Loading…</div>'; }
function setupBanner() {
  return `<div class="setup-banner">This app isn't connected to your library data yet. Open <code>config.js</code> and paste your deployed Apps Script Web App URL into <code>API_URL</code>, then reload.</div>`;
}

/* ---------------- router ---------------- */
const routes = ['dashboard','timetable','students','attendance','reports','profile','assess','add-student','edit-student','move-student'];

function navigate(route, params) {
  state.route = route;
  state.params = params || {};
  location.hash = '#/' + route + (params && params.id ? '/' + params.id : '');
  render();
}

window.addEventListener('hashchange', () => {
  const parts = location.hash.replace('#/','').split('/');
  state.route = parts[0] || 'dashboard';
  state.params = parts[1] ? { id: decodeURIComponent(parts[1]) } : {};
  render();
});

document.querySelectorAll('[data-route]').forEach(el => {
  el.addEventListener('click', () => navigate(el.dataset.route));
});

function syncNavActive() {
  document.querySelectorAll('[data-route]').forEach(el => {
    el.classList.toggle('active', el.dataset.route === state.route);
    el.classList.toggle('on', el.dataset.route === state.route);
  });
}

/* ---------------- render dispatch ---------------- */
async function render() {
  syncNavActive();
  document.getElementById('topbarDate').textContent = niceDate(todayStr());
  const content = document.getElementById('content');
  if (!apiConfigured() && state.route !== 'dashboard') {
    content.innerHTML = setupBanner();
    return;
  }
  setLoading(content);
  try {
    if (state.route === 'dashboard') await viewDashboard(content);
    else if (state.route === 'timetable') await viewTimetable(content);
    else if (state.route === 'students') await viewStudents(content);
    else if (state.route === 'add-student') await viewStudentForm(content, 'add');
    else if (state.route === 'edit-student') await viewStudentForm(content, 'edit', state.params.id);
    else if (state.route === 'move-student') await viewMoveStudent(content, state.params.id);
    else if (state.route === 'profile') await viewProfile(content, state.params.id);
    else if (state.route === 'attendance') await viewAttendance(content);
    else if (state.route === 'assess') await viewAssess(content);
    else if (state.route === 'reports') await viewReports(content);
    else content.innerHTML = '<div class="empty">Not found.</div>';
  } catch (err) {
    if (String(err.message) === 'CONFIG_MISSING') {
      content.innerHTML = setupBanner();
    } else {
      content.innerHTML = `<div class="empty">Couldn't load this — ${esc(err.message)}</div>`;
    }
  }
}

/* ---------------- DASHBOARD ---------------- */
async function viewDashboard(content) {
  if (!apiConfigured()) {
    content.innerHTML = `
      <div class="page-head">
        <div class="eyebrow">Welcome</div>
        <h1>MMS Library</h1>
        <p>Set up the connection to your library Google Sheet to get started.</p>
      </div>
      ${setupBanner()}`;
    return;
  }

  const d = await apiGet('dashboard', { date: todayStr() });
  const firstClass = d.timetable && d.timetable.length ? d.timetable[0] : null;

  content.innerHTML = `
    <section class="library-welcome">
      <div>
        <div class="eyebrow">${esc(String(d.day || '').toUpperCase())} · ${esc(niceDate(todayStr()))}</div>
        <h1>Mathakondapalli<br>Model School</h1>
        <div class="library-wordmark">LIBRARY</div>
      </div>
      <div class="welcome-person">
        <div class="welcome-avatar">●</div>
        <div>
          <div class="welcome-small">Good Morning,</div>
          <div class="welcome-name">Librarian!</div>
          <div class="welcome-date">${esc(niceDate(todayStr()))}</div>
        </div>
      </div>
    </section>

    <section class="dashboard-card today-library">
      <div class="dash-card-head">
        <div>
          <h2>Today's Library</h2>
          <p>Classes scheduled for today</p>
        </div>
        <span class="pill amber">${d.timetable.length} classes</span>
      </div>
      ${firstClass ? `
        <div class="today-session">
          <div class="session-time"><strong>${esc(firstClass.start)}</strong><strong>${esc(firstClass.end)}</strong></div>
          <div class="session-icon">▣</div>
          <div class="session-info">
            <strong>${esc(firstClass.classSection)}</strong>
            <span>Open attendance for this class</span>
          </div>
          <button class="btn" onclick="navigate('attendance',{grade:'${esc(firstClass.grade)}',section:'${esc(firstClass.section)}'})">Open</button>
        </div>
      ` : '<div class="empty">No library sessions scheduled today.</div>'}
    </section>

    <section class="grid cols-2 dashboard-stats">
      <div class="dashboard-card mini-stat">
        <div class="mini-value">${d.present}</div>
        <div class="mini-label">Present marked today</div>
        <div class="mini-icon teal">●●</div>
      </div>
      <div class="dashboard-card mini-stat">
        <div class="mini-value">${d.absent}</div>
        <div class="mini-label">Absent marked today</div>
        <div class="mini-icon orange">●</div>
      </div>
    </section>

    <section class="dashboard-card feature teal-feature">
      <div class="dash-card-head">
        <div>
          <h2>Attendance</h2>
          <p>${d.present + d.absent} students marked today</p>
        </div>
        <span class="pill light">Updated</span>
      </div>
      <button class="feature-button" onclick="navigate('attendance')">Mark / Edit Attendance <span>→</span></button>
    </section>

    <section class="dashboard-card feature reading-feature">
      <div class="dash-card-head">
        <div>
          <h2>Reading Tracking</h2>
          <p>Current cycle: Week ${esc(d.cycle)} · Four observations per month</p>
        </div>
        <span class="pill">0 records</span>
      </div>
      <button class="feature-button orange-button" onclick="navigate('assess')">Continue Reading Tracking <span>→</span></button>
    </section>

    <section class="dashboard-actions">
      <button class="dashboard-action action-purple" onclick="navigate('students')">
        <span class="action-icon">▤</span>
        <strong>Students</strong>
        <small>View and manage<br>student data</small>
        <span class="action-arrow">→</span>
      </button>
      <button class="dashboard-action action-peach" onclick="navigate('timetable')">
        <span class="action-icon">▣</span>
        <strong>Schedule</strong>
        <small>Manage library<br>sessions</small>
        <span class="action-arrow">→</span>
      </button>
      <button class="dashboard-action action-mint" onclick="navigate('reports')">
        <span class="action-icon">▤</span>
        <strong>Reports</strong>
        <small>View insights<br>and analytics</small>
        <span class="action-arrow">→</span>
      </button>
    </section>`;
}

/* ---------------- TIMETABLE ---------------- */
async function viewTimetable(content) {
  const week = await apiGet('weeklyTimetable', { date: todayStr() });
  const today = todayStr();
  let active = week.findIndex(w => w.date === today);
  if (active < 0) active = 0;

  function renderDay(idx) {
    const w = week[idx];
    const body = document.getElementById('ttBody');
    body.innerHTML = w.classes.length ? w.classes.map(t => `
      <div class="list-row">
        <div class="main">
          <div class="title">${esc(t.classSection)}</div>
          <div class="meta">${esc(t.start)} – ${esc(t.end)}${t.note ? ' · ' + esc(t.note) : ''}</div>
        </div>
        <button class="btn ghost" onclick="navigate('attendance',{grade:'${esc(t.grade)}',section:'${esc(t.section)}',date:'${w.date}'})">Mark</button>
      </div>`).join('') : '<div class="empty">No sessions this day.</div>';
  }

  content.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">This week</div>
      <h1>Timetable</h1>
    </div>
    <div class="tabs-inline" id="ttTabs">
      ${week.map((w,i) => `<button data-i="${i}" class="${i===active?'on':''}">${w.day.slice(0,3)} ${w.date.slice(8,10)}</button>`).join('')}
    </div>
    <div class="card" id="ttBody"></div>`;

  document.querySelectorAll('#ttTabs button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#ttTabs button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      renderDay(Number(b.dataset.i));
    });
  });
  renderDay(active);
}

/* ---------------- STUDENTS ---------------- */
function initials(name) {
  return String(name || '?').trim().split(/\\s+/).slice(0,2).map(x => x[0]).join('').toUpperCase() || '?';
}

function invalidateStudentCaches() {
  sectionCache.clear();
}

async function loadSectionsInto(selectEl, grade, selected) {
  selectEl.innerHTML = '<option value="">Select section</option>';
  if (!grade) return [];
  const sections = await apiGet('sections', { grade });
  sections.forEach(s => {
    selectEl.insertAdjacentHTML('beforeend', `<option value="${esc(s)}" ${String(s)===String(selected||'')?'selected':''}>Section ${esc(s)}</option>`);
  });
  return sections;
}

async function viewStudents(content) {
  content.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">Student management</div>
      <h1>Students</h1>
      <p>Search, add, edit and move students without leaving the library workspace.</p>
    </div>

    <div class="hero">
      <div class="hero-row">
        <div>
          <div class="eyebrow">Directory</div>
          <h1>Student records</h1>
          <p>Keep class and section information accurate so attendance and reading history stay connected.</p>
        </div>
        <button class="btn" onclick="navigate('add-student')">＋ Add Student</button>
      </div>
    </div>

    <div class="searchbox">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
      <input id="stuSearch" type="text" placeholder="Search name or admission number">
    </div>

    <div class="row-2">
      <div class="field"><select id="stuGrade"><option value="">All grades</option>${GRADES.map(g=>`<option value="${g}">Grade ${g}</option>`).join('')}</select></div>
      <div class="field"><select id="stuSection"><option value="">All sections</option></select></div>
    </div>

    <div class="section-title">Quick student actions</div>
    <div class="action-grid">
      <button class="action-card" onclick="navigate('add-student')">
        <span class="action-icon">＋</span><span class="action-title">Add student</span><span class="action-meta">Create a new record</span>
      </button>
      <button class="action-card green" onclick="document.getElementById('stuSearch').focus()">
        <span class="action-icon">⌕</span><span class="action-title">Find student</span><span class="action-meta">Search the directory</span>
      </button>
    </div>

    <div class="section-title">Student directory</div>
    <div class="card" id="stuList"><div class="loading"><div class="spinner"></div>Loading…</div></div>`;

  const search = document.getElementById('stuSearch');
  const gradeSel = document.getElementById('stuGrade');
  const sectionSel = document.getElementById('stuSection');
  const list = document.getElementById('stuList');

  async function refreshSections() {
    sectionSel.innerHTML = '<option value="">All sections</option>';
    if (!gradeSel.value) return;
    const sections = await apiGet('sections', { grade: gradeSel.value });
    sections.forEach(s => sectionSel.insertAdjacentHTML('beforeend', `<option value="${esc(s)}">Section ${esc(s)}</option>`));
  }

  async function refreshList() {
    setLoading(list);
    const students = await apiGet('students', { search: search.value, grade: gradeSel.value, section: sectionSel.value });
    list.innerHTML = students.length ? students.map(s => `
      <div class="list-row">
        <div class="student-row" style="cursor:pointer" onclick="navigate('profile',{id:'${esc(s.admissionNumber)}'})">
          <div class="avatar">${esc(initials(s.studentName))}</div>
          <div class="main">
            <div class="title">${esc(s.studentName)}</div>
            <div class="meta">Grade ${esc(s.grade)} · Section ${esc(s.section)} · Adm# ${esc(s.admissionNumber)}</div>
          </div>
        </div>
        <div class="student-actions">
          <button class="btn small ghost" onclick="event.stopPropagation();navigate('edit-student',{id:'${esc(s.admissionNumber)}'})">Edit</button>
          <button class="btn small" onclick="event.stopPropagation();navigate('move-student',{id:'${esc(s.admissionNumber)}'})">Move</button>
        </div>
      </div>`).join('') : '<div class="empty">No students match these filters.</div>';
  }

  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(refreshList, 250); });
  gradeSel.addEventListener('change', async () => { await refreshSections(); refreshList(); });
  sectionSel.addEventListener('change', refreshList);
  refreshList();
}

/* ---------------- STUDENT PROFILE ---------------- */
async function viewProfile(content, admissionNumber) {
  const p = await apiGet('studentProfile', { admissionNumber });
  const s = p.student;
  content.innerHTML = `
    <div class="link-back" onclick="navigate('students')">← Back to students</div>
    <div class="page-head">
      <div class="eyebrow">Student profile</div>
      <h1>${esc(s.studentName)}</h1>
      <p>Grade ${esc(s.grade)} · Section ${esc(s.section)} · Admission No. ${esc(s.admissionNumber)}</p>
    </div>

    <div class="form-actions">
      <button class="btn" onclick="navigate('edit-student',{id:'${esc(s.admissionNumber)}'})">✎ Edit data</button>
      <button class="btn green" onclick="navigate('move-student',{id:'${esc(s.admissionNumber)}'})">⇄ Move section</button>
    </div>

    <div class="section-title">Student overview</div>
    <div class="grid cols-2">
      <div class="stat dark"><div class="label">Attendance</div><div class="value">${p.attendancePct}%</div></div>
      <div class="stat"><div class="label">Sessions logged</div><div class="value">${p.attendanceCount}</div></div>
    </div>

    <div class="section-title">Reading assessments</div>
    <div class="card">
      ${p.assessments.length ? p.assessments.slice().reverse().map(a => `
        <div style="padding:.9rem 0;border-bottom:1px solid var(--line)">
          <div class="list-row" style="border:none;padding:0 0 .6rem">
            <div class="main"><div class="title">Cycle ${esc(a.cycle)} · ${esc(a.date)}</div></div>
            <span class="pill amber">${a.overall}% overall</span>
          </div>
          ${RUBRIC_KEYS.map(k => `
            <div class="bar-row">
              <div class="lbl">${RUBRIC_LABELS[k]}</div>
              <div class="bar-track"><div class="bar-fill" style="width:${(a[k]||0)/5*100}%"></div></div>
              <div class="pct">${a[k]||0}/5</div>
            </div>`).join('')}
          ${a.observation ? `<p style="font-size:.75rem;color:var(--muted);margin:.5rem 0 0">${esc(a.observation)}</p>` : ''}
        </div>`).join('') : '<div class="empty">No assessments recorded yet.</div>'}
    </div>`;
}

/* ---------------- ADD / EDIT STUDENT ---------------- */
async function viewStudentForm(content, mode, admissionNumber) {
  let existing = null;

  if (mode === 'edit') {
    const p = await apiGet('studentProfile', { admissionNumber });
    existing = p.student;
  }

  const title = mode === 'edit' ? 'Edit student' : 'Add student';
  const eyebrow = mode === 'edit' ? 'Student management' : 'New record';

  content.innerHTML = `
    <div class="link-back" onclick="${mode === 'edit' ? `navigate('profile',{id:'${esc(admissionNumber)}'})` : `navigate('students')`}">← Back</div>
    <div class="page-head">
      <div class="eyebrow">${eyebrow}</div>
      <h1>${title}</h1>
      <p>${mode === 'edit' ? 'Update the student record while preserving the admission number as the permanent key.' : 'Create a student record before the student starts library attendance or reading assessment.'}</p>
    </div>

    <div class="notice">
      <strong>${mode === 'edit' ? 'Key field:' : 'Before saving:'}</strong>
      <span>${mode === 'edit' ? 'Admission number is locked because attendance and reading history are linked to it.' : 'Check the admission number carefully. It should be unique and stable.'}</span>
    </div>

    <div class="card">
      <div class="field">
        <label>Student name</label>
        <input id="stuNameForm" type="text" value="${esc(existing ? existing.studentName : '')}" placeholder="Full student name">
      </div>
      <div class="field">
        <label>Admission number</label>
        <input id="stuAdmForm" type="text" value="${esc(existing ? existing.admissionNumber : '')}" placeholder="Admission number" ${mode === 'edit' ? 'readonly' : ''}>
      </div>
      <div class="row-2">
        <div class="field"><label>Grade</label><select id="stuGradeForm"><option value="">Select grade</option>${GRADES.map(g=>`<option value="${g}" ${existing && String(existing.grade)===String(g)?'selected':''}>Grade ${g}</option>`).join('')}</select></div>
        <div class="field"><label>Section</label><select id="stuSectionForm"><option value="">Select grade first</option></select></div>
      </div>
      <div class="form-actions">
        <button class="btn ghost" onclick="${mode === 'edit' ? `navigate('profile',{id:'${esc(admissionNumber)}'})` : `navigate('students')`}">Cancel</button>
        <button class="btn" id="studentSaveBtn">${mode === 'edit' ? 'Save changes' : 'Add student'}</button>
      </div>
    </div>`;

  const nameInput = document.getElementById('stuNameForm');
  const admInput = document.getElementById('stuAdmForm');
  const gradeSel = document.getElementById('stuGradeForm');
  const sectionSel = document.getElementById('stuSectionForm');
  const saveBtn = document.getElementById('studentSaveBtn');

  async function loadFormSections(selected) {
    sectionSel.innerHTML = '<option value="">Select section</option>';
    if (!gradeSel.value) return;
    await loadSectionsInto(sectionSel, gradeSel.value, selected);
  }

  gradeSel.addEventListener('change', () => loadFormSections(''));
  await loadFormSections(existing ? existing.section : '');

  saveBtn.addEventListener('click', async () => {
    const studentName = nameInput.value.trim();
    const admission = admInput.value.trim();
    const grade = gradeSel.value;
    const section = sectionSel.value.trim();

    if (!studentName || !admission || !grade || !section) {
      toast('Please complete name, admission number, grade and section.');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = mode === 'edit' ? 'Saving…' : 'Adding…';

    try {
      if (mode === 'edit') {
        await apiPost('updateStudent', { admissionNumber: admission, studentName, grade, section });
        invalidateStudentCaches();
        toast('Student data updated.');
        setTimeout(() => navigate('profile', { id: admission }), 350);
      } else {
        await apiPost('addStudent', { admissionNumber: admission, studentName, grade, section });
        invalidateStudentCaches();
        toast('Student added.');
        setTimeout(() => navigate('students'), 350);
      }
    } catch (err) {
      toast('Could not save: ' + err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = mode === 'edit' ? 'Save changes' : 'Add student';
    }
  });
}

/* ---------------- MOVE STUDENT ---------------- */
async function viewMoveStudent(content, admissionNumber) {
  const p = await apiGet('studentProfile', { admissionNumber });
  const s = p.student;

  content.innerHTML = `
    <div class="link-back" onclick="navigate('profile',{id:'${esc(admissionNumber)}'})">← Back to profile</div>
    <div class="page-head">
      <div class="eyebrow">Section management</div>
      <h1>Move student</h1>
      <p>Move ${esc(s.studentName)} to another section in Grade ${esc(s.grade)}. Attendance and reading history remain linked to the student.</p>
    </div>

    <div class="card">
      <div class="student-row" style="margin-bottom:1rem">
        <div class="avatar">${esc(initials(s.studentName))}</div>
        <div class="main">
          <div class="title">${esc(s.studentName)}</div>
          <div class="meta">Grade ${esc(s.grade)} · Current section ${esc(s.section)} · Adm# ${esc(s.admissionNumber)}</div>
        </div>
      </div>

      <div class="field">
        <label>Move to existing section</label>
        <select id="moveSection"><option value="">Select section</option></select>
      </div>

      <div class="field">
        <label>Or enter a new section</label>
        <input id="moveNewSection" type="text" placeholder="Example: B">
      </div>

      <div class="form-actions">
        <button class="btn ghost" onclick="navigate('profile',{id:'${esc(admissionNumber)}'})">Cancel</button>
        <button class="btn" id="moveSave">Move to section</button>
      </div>
    </div>`;

  const select = document.getElementById('moveSection');
  const newSection = document.getElementById('moveNewSection');
  const save = document.getElementById('moveSave');
  await loadSectionsInto(select, s.grade, '');

  save.addEventListener('click', async () => {
    const target = newSection.value.trim() || select.value.trim();
    if (!target) { toast('Select or enter the destination section.'); return; }
    if (target === String(s.section)) { toast('Choose a different section.'); return; }

    save.disabled = true;
    save.textContent = 'Moving…';

    try {
      await apiPost('moveStudent', { admissionNumber: s.admissionNumber, grade: s.grade, section: target });
      invalidateStudentCaches();
      toast('Student moved to Section ' + target + '.');
      setTimeout(() => navigate('profile', { id: s.admissionNumber }), 350);
    } catch (err) {
      toast('Could not move student: ' + err.message);
    } finally {
      save.disabled = false;
      save.textContent = 'Move to section';
    }
  });
}

/* ---------------- ATTENDANCE ---------------- */
/* ---------------- ATTENDANCE ---------------- */
async function viewAttendance(content) {
  const params = state.params || {};
  const date = params.date || todayStr();
  content.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">Library session</div>
      <h1>Attendance</h1>
    </div>
    <div class="row-3">
      <div class="field"><label>Date</label><input id="attDate" type="date" value="${date}"></div>
      <div class="field"><label>Grade</label><select id="attGrade"><option value="">Select</option>${GRADES.map(g=>`<option value="${g}" ${g===params.grade?'selected':''}>Grade ${g}</option>`).join('')}</select></div>
      <div class="field"><label>Section</label><select id="attSection"><option value="">Select</option></select></div>
    </div>
    <div class="card" id="attList"><div class="empty">Choose a date, grade and section.</div></div>
    <button class="btn block" id="attSave" style="margin-top:1rem;display:none">Save Attendance</button>`;

  const gradeSel = document.getElementById('attGrade');
  const sectionSel = document.getElementById('attSection');
  const dateInput = document.getElementById('attDate');
  const list = document.getElementById('attList');
  const saveBtn = document.getElementById('attSave');
  let currentStudents = [];

  async function refreshSections(preselect) {
    sectionSel.innerHTML = '<option value="">Select</option>';
    if (!gradeSel.value) return;
    const sections = await apiGet('sections', { grade: gradeSel.value });
    sections.forEach(s => sectionSel.insertAdjacentHTML('beforeend', `<option value="${esc(s)}">Section ${esc(s)}</option>`));
    if (preselect && sections.includes(preselect)) sectionSel.value = preselect;
  }

  async function loadClass() {
    if (!gradeSel.value || !sectionSel.value) { list.innerHTML = '<div class="empty">Choose a date, grade and section.</div>'; saveBtn.style.display='none'; return; }
    setLoading(list);
    currentStudents = await apiGet('attendanceForClass', { dateStr: dateInput.value, grade: gradeSel.value, section: sectionSel.value });
    renderList();
    saveBtn.style.display = currentStudents.length ? 'flex' : 'none';
  }

  function renderList() {
    list.innerHTML = currentStudents.length ? currentStudents.map((s,i) => `
      <div class="att-row">
        <div class="main">
          <div class="title">${esc(s.studentName)}</div>
          <div class="meta">Adm# ${esc(s.admissionNumber)}</div>
        </div>
        <div class="att-toggle">
          <button class="present ${s.status==='Present'?'on':''}" onclick="setAttStatus(${i},'Present')">Present</button>
          <button class="absent ${s.status==='Absent'?'on':''}" onclick="setAttStatus(${i},'Absent')">Absent</button>
        </div>
      </div>`).join('') : '<div class="empty">No students found for this class.</div>';
  }

  window.setAttStatus = (i, status) => { currentStudents[i].status = status; renderList(); };

  saveBtn.addEventListener('click', async () => {
    const unmarked = currentStudents.filter(s => !s.status);
    if (unmarked.length) { toast(`Please mark all ${currentStudents.length} students first.`); return; }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      const records = currentStudents.map(s => ({ ...s, date: dateInput.value, grade: gradeSel.value, section: sectionSel.value }));
      await apiPost('saveAttendance', { records });
      toast('Attendance saved.');
    } catch (err) {
      toast('Could not save: ' + err.message);
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = 'Save Attendance';
    }
  });

  gradeSel.addEventListener('change', async () => { await refreshSections(); await loadClass(); });
  sectionSel.addEventListener('change', loadClass);
  dateInput.addEventListener('change', loadClass);

  if (params.grade) { await refreshSections(params.section); await loadClass(); }
}

/* ---------------- READING ASSESSMENT ---------------- */
async function viewAssess(content) {
  content.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">Reading rubric</div>
      <h1>Reading Assessment</h1>
    </div>
    <div class="row-3">
      <div class="field"><label>Date</label><input id="asDate" type="date" value="${todayStr()}"></div>
      <div class="field"><label>Grade</label><select id="asGrade"><option value="">Select</option>${GRADES.map(g=>`<option value="${g}">Grade ${g}</option>`).join('')}</select></div>
      <div class="field"><label>Section</label><select id="asSection"><option value="">Select</option></select></div>
    </div>
    <div class="field"><label>Student</label><select id="asStudent"><option value="">Select grade & section first</option></select></div>
    <div class="card" id="asForm" style="display:none">
      ${RUBRIC_KEYS.map(k => `
        <div class="rubric">
          <div class="rlabel"><span>${RUBRIC_LABELS[k]}</span><span class="score" id="asScore_${k}">3/5</span></div>
          <div class="dots" id="asDots_${k}">${[1,2,3,4,5].map(n=>`<button data-k="${k}" data-n="${n}">${n}</button>`).join('')}</div>
        </div>`).join('')}
      <div class="field"><label>Observation (optional)</label><textarea id="asObs" placeholder="Notes on this student's reading session…"></textarea></div>
      <button class="btn block" id="asSave">Save Assessment</button>
    </div>`;

  const gradeSel = document.getElementById('asGrade');
  const sectionSel = document.getElementById('asSection');
  const studentSel = document.getElementById('asStudent');
  const form = document.getElementById('asForm');
  const scores = {}; RUBRIC_KEYS.forEach(k => scores[k] = 3);

  function paintDots(k) {
    document.querySelectorAll(`#asDots_${k} button`).forEach(b => b.classList.toggle('on', Number(b.dataset.n) <= scores[k]));
    document.getElementById(`asScore_${k}`).textContent = scores[k] + '/5';
  }
  RUBRIC_KEYS.forEach(paintDots);
  document.querySelectorAll('.dots button').forEach(b => {
    b.addEventListener('click', () => { scores[b.dataset.k] = Number(b.dataset.n); paintDots(b.dataset.k); });
  });

  async function refreshSections() {
    sectionSel.innerHTML = '<option value="">Select</option>';
    studentSel.innerHTML = '<option value="">Select grade & section first</option>';
    form.style.display = 'none';
    if (!gradeSel.value) return;
    const sections = await apiGet('sections', { grade: gradeSel.value });
    sections.forEach(s => sectionSel.insertAdjacentHTML('beforeend', `<option value="${esc(s)}">Section ${esc(s)}</option>`));
  }

  async function refreshStudents() {
    studentSel.innerHTML = '<option value="">Select</option>';
    form.style.display = 'none';
    if (!gradeSel.value || !sectionSel.value) return;
    const students = await apiGet('students', { grade: gradeSel.value, section: sectionSel.value });
    students.forEach(s => studentSel.insertAdjacentHTML('beforeend', `<option value="${esc(s.admissionNumber)}" data-name="${esc(s.studentName)}">${esc(s.studentName)}</option>`));
  }

  studentSel.addEventListener('change', () => { form.style.display = studentSel.value ? 'block' : 'none'; });
  gradeSel.addEventListener('change', refreshSections);
  sectionSel.addEventListener('change', refreshStudents);

  document.getElementById('asSave').addEventListener('click', async (e) => {
    const btn = e.target; btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const opt = studentSel.selectedOptions[0];
      await apiPost('saveReadingAssessment', {
        date: document.getElementById('asDate').value,
        admissionNumber: studentSel.value,
        studentName: opt.dataset.name,
        grade: gradeSel.value,
        section: sectionSel.value,
        observation: document.getElementById('asObs').value,
        ...scores
      });
      toast('Assessment saved.');
      document.getElementById('asObs').value = '';
    } catch (err) {
      toast('Could not save: ' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Save Assessment';
    }
  });
}

/* ---------------- REPORTS ---------------- */
async function viewReports(content) {
  const month = todayStr().slice(0,7);
  content.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">Monthly summary</div>
      <h1>Reports</h1>
    </div>
    <div class="field" style="max-width:220px"><label>Month</label><input id="repMonth" type="month" value="${month}"></div>
    <div class="card" id="repList"><div class="loading"><div class="spinner"></div>Loading…</div></div>`;

  async function load() {
    const list = document.getElementById('repList');
    setLoading(list);
    const r = await apiGet('reports', { month: document.getElementById('repMonth').value });
    const rows = r.students.filter(s => s.attendanceTotal || s.assessments);
    list.innerHTML = rows.length ? rows.map(s => `
      <div class="list-row" style="cursor:pointer" onclick="navigate('profile',{id:'${esc(s.admissionNumber)}'})">
        <div class="main">
          <div class="title">${esc(s.studentName)}</div>
          <div class="meta">Grade ${esc(s.grade)} - ${esc(s.section)}</div>
        </div>
        <div style="display:flex;gap:.4rem">
          <span class="pill ${s.attendancePct>=75?'present':'absent'}">${s.attendancePct}% att.</span>
          <span class="pill amber">${s.readingScore}% read.</span>
        </div>
      </div>`).join('') : '<div class="empty">No activity recorded for this month yet.</div>';
  }
  document.getElementById('repMonth').addEventListener('change', load);
  load();
}

/* ---------------- boot ---------------- */
window.navigate = navigate;

function boot() {
  const parts = location.hash.replace('#/','').split('/');
  state.route = parts[0] || 'dashboard';
  state.params = parts[1] ? { id: decodeURIComponent(parts[1]) } : {};
  render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }
}
boot();
