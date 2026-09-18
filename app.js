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
function apiConfigured() {
  return typeof API_URL === 'string' && API_URL && !API_URL.includes('PASTE_YOUR');
}

function jsonpRequest(params) {
  return new Promise((resolve, reject) => {
    const cb = '__mmsPwaCb_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Request timed out')); }, 15000);
    function cleanup() {
      clearTimeout(timeout);
      delete window[cb];
      script.remove();
    }
    window[cb] = (json) => {
      cleanup();
      if (!json || !json.ok) reject(new Error((json && json.error) || 'Request failed'));
      else resolve(json.data);
    };
    script.onerror = () => { cleanup(); reject(new Error('Failed to reach library server')); };
    script.src = API_URL + '?' + new URLSearchParams({ ...params, callback: cb }).toString();
    document.head.appendChild(script);
  });
}

async function apiGet(action, params) {
  if (!apiConfigured()) throw new Error('CONFIG_MISSING');
  return jsonpRequest({ api: '1', action, ...(params || {}) });
}

async function apiPost(action, payload) {
  if (!apiConfigured()) throw new Error('CONFIG_MISSING');
  return jsonpRequest({ api: '1', action, payload: JSON.stringify(payload || {}) });
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
const routes = ['dashboard','timetable','students','attendance','reports','profile','assess'];

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
  content.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">${esc(d.day)}</div>
      <h1>Good day 👋</h1>
      <p>Here's what's happening in the library today.</p>
    </div>
    <div class="grid cols-3">
      <div class="stat dark"><div class="label">Present today</div><div class="value">${d.present}</div></div>
      <div class="stat"><div class="label">Absent today</div><div class="value">${d.absent}</div></div>
      <div class="stat"><div class="label">Reading cycle</div><div class="value">C${d.cycle}</div></div>
    </div>
    <div class="section-title">Today's timetable</div>
    <div class="card">
      ${d.timetable.length ? d.timetable.map(t => `
        <div class="list-row">
          <div class="main">
            <div class="title">${esc(t.classSection)}</div>
            <div class="meta">${esc(t.start)} – ${esc(t.end)}${t.note ? ' · ' + esc(t.note) : ''}</div>
          </div>
          <button class="btn ghost" onclick="navigate('attendance',{grade:'${esc(t.grade)}',section:'${esc(t.section)}'})">Mark</button>
        </div>`).join('') : '<div class="empty">No library sessions scheduled today.</div>'}
    </div>
    <div class="section-title">Quick actions</div>
    <div class="grid cols-2">
      <button class="btn block" onclick="navigate('attendance')">Mark Attendance</button>
      <button class="btn ghost block" onclick="navigate('assess')">Reading Assessment</button>
    </div>`;
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
async function viewStudents(content) {
  content.innerHTML = `
    <div class="page-head">
      <div class="eyebrow">Directory</div>
      <h1>Students</h1>
    </div>
    <div class="searchbox">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
      <input id="stuSearch" type="text" placeholder="Search by name or admission number">
    </div>
    <div class="row-2">
      <div class="field"><select id="stuGrade"><option value="">All grades</option>${GRADES.map(g=>`<option value="${g}">Grade ${g}</option>`).join('')}</select></div>
      <div class="field"><select id="stuSection"><option value="">All sections</option></select></div>
    </div>
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
      <div class="list-row" style="cursor:pointer" onclick="navigate('profile',{id:'${esc(s.admissionNumber)}'})">
        <div class="main">
          <div class="title">${esc(s.studentName)}</div>
          <div class="meta">Grade ${esc(s.grade)} - ${esc(s.section)} · Adm# ${esc(s.admissionNumber)}</div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      </div>`).join('') : '<div class="empty">No students match.</div>';
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
  content.innerHTML = `
    <div class="link-back" onclick="navigate('students')">← Back to students</div>
    <div class="page-head">
      <div class="eyebrow">Grade ${esc(p.student.grade)} - ${esc(p.student.section)}</div>
      <h1>${esc(p.student.studentName)}</h1>
      <p>Admission No. ${esc(p.student.admissionNumber)}</p>
    </div>
    <div class="grid cols-2">
      <div class="stat dark"><div class="label">Attendance</div><div class="value">${p.attendancePct}%</div></div>
      <div class="stat"><div class="label">Sessions logged</div><div class="value">${p.attendanceCount}</div></div>
    </div>
    <div class="section-title">Reading assessments</div>
    <div class="card">
      ${p.assessments.length ? p.assessments.slice().reverse().map(a => `
        <div style="padding:.9rem 0;border-bottom:1px solid var(--line)">
          <div class="list-row" style="border:none;padding:0 0 .6rem">
            <div class="main"><div class="title">Cycle ${a.cycle} · ${esc(a.date)}</div></div>
            <span class="pill amber">${a.overall}% overall</span>
          </div>
          ${RUBRIC_KEYS.map(k => `
            <div class="bar-row">
              <div class="lbl">${RUBRIC_LABELS[k]}</div>
              <div class="bar-track"><div class="bar-fill" style="width:${(a[k]||0)/5*100}%"></div></div>
              <div class="pct">${a[k]||0}/5</div>
            </div>`).join('')}
          ${a.observation ? `<p style="font-size:.85rem;color:var(--muted);margin:.5rem 0 0">${esc(a.observation)}</p>` : ''}
        </div>`).join('') : '<div class="empty">No assessments recorded yet.</div>'}
    </div>`;
}

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
