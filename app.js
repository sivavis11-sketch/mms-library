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

const APPS_SCRIPT_RUN_TIMEOUT_MS = 12000;

function appsScriptGet(action, params) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Apps Script request timed out while loading ' + action + '.'));
    }, APPS_SCRIPT_RUN_TIMEOUT_MS);

    try {
      google.script.run
        .withSuccessHandler(data => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(data);
        })
        .withFailureHandler(err => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(String(err && err.message || err || 'Apps Script request failed')));
        })
        .libraryApiGet(action, params || {});
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
  });
}

function appsScriptPost(action, payload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Apps Script request timed out while saving ' + action + '.'));
    }, APPS_SCRIPT_RUN_TIMEOUT_MS);

    try {
      google.script.run
        .withSuccessHandler(data => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(data);
        })
        .withFailureHandler(err => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(String(err && err.message || err || 'Apps Script request failed')));
        })
        .libraryApiPost(action, payload || {});
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
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

    script.async = true;
    script.referrerPolicy = 'no-referrer';
    script.src = API_URL + '?' + query.toString();
    document.head.appendChild(script);
  });
}

/*
 * Mobile/PWA fallback.
 * Apps Script ContentService responses are redirected to a Google-hosted
 * URL. Some mobile standalone browsers are stricter about executing the
 * redirected JSONP response as a cross-origin script. The backend can
 * therefore return a tiny HTML bridge that posts the data to this window.
 */
function messageBridgeRequest(params) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    const token = '__mmsBridge_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    let settled = false;
    let ready = false;

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Failed to reach library server'));
    }, API_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      try { frame.remove(); } catch (err) {}
    }

    function sendRequest() {
      if (settled || !ready || !frame.contentWindow) return;
      try {
        frame.contentWindow.postMessage({
          source: 'mms-library-bridge',
          token,
          action: params.action,
          params: Object.fromEntries(
            Object.entries(params).filter(([key]) => key !== 'api')
          )
        }, '*');
      } catch (err) {
        cleanup();
        reject(err);
      }
    }

    function onMessage(event) {
      const data = event && event.data;

      if (data && data.source === 'mms-library-bridge' && data.ready) {
        if (event.source !== frame.contentWindow) return;
        ready = true;
        sendRequest();
        return;
      }

      if (!data || data.source !== 'mms-library-bridge' || data.token !== token) return;
      if (event.source !== frame.contentWindow) return;

      settled = true;
      cleanup();

      if (!data.ok) {
        reject(new Error(data.error || 'Request failed'));
        return;
      }

      resolve(data.data);
    }

    window.addEventListener('message', onMessage);

    frame.title = 'MMS Library API Bridge';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.position = 'fixed';
    frame.style.width = '1px';
    frame.style.height = '1px';
    frame.style.opacity = '0';
    frame.style.pointerEvents = 'none';
    frame.style.border = '0';

    frame.addEventListener('load', () => {
      ready = true;
      sendRequest();
    }, { once: false });

    frame.src = API_URL + '?bridge=1&_t=' + Date.now().toString();
    document.body.appendChild(frame);
  });
}

async function apiGetWithPwaFallback(params) {
  // Prefer the Apps Script iframe bridge on mobile/PWA. It uses
  // google.script.run inside the Apps Script origin and avoids JSONP
  // redirect/script execution issues in installed browsers.
  try {
    return await messageBridgeRequest(params);
  } catch (bridgeError) {
    try {
      return await jsonpRequest(params);
    } catch (jsonpError) {
      throw bridgeError;
    }
  }
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
        const data = await apiGetWithPwaFallback(requestParams);

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
  content.dataset.route = state.route;
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
      const msg = String(err && err.message || err || 'Unknown error');
      content.innerHTML = `
        <div class="connection-error dashboard-card">
          <div class="connection-error-icon">${iconSvg('activity')}</div>
          <div>
            <div class="eyebrow">Library connection</div>
            <h2>We couldn't load this screen</h2>
            <p>${esc(msg)}</p>
            <div class="connection-actions">
              <button class="btn" onclick="render()">Try again</button>
              <button class="btn ghost" onclick="navigate('dashboard')">Back to dashboard</button>
            </div>
          </div>
        </div>`;
    }
  }
}

function iconSvg(name) {
  const paths = {
    users: '<circle cx="9" cy="8" r="3"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 8.5a3 3 0 0 1 0 5.9M16 14.5c3.1.4 5.2 2.3 5.5 5.5"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21z"/><path d="M4 5.5v15M8 7h8M8 11h7"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M3 9h18M8 3v4M16 3v4M8 13h3M13 13h3M8 17h3"/>',
    document: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v5h4M9 12h6M9 16h6"/>',
    chart: '<path d="M4 19V9M12 19V5M20 19v-7"/><path d="M3 19h18"/>',
    check: '<path d="M9 12l2 2 4-4"/><rect x="3" y="4" width="18" height="17" rx="3"/>',
    activity: '<path d="M3 12h4l2-5 4 10 2-5h6"/><circle cx="5" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    arrow: '<path d="M5 12h13M13 7l5 5-5 5"/>'
  };
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || paths.arrow) + '</svg>';
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
  const totalMarked = Number(d.present || 0) + Number(d.absent || 0);

  content.innerHTML = `
    <section class="library-welcome premium-hero">
      <div class="welcome-copy">
        <div class="eyebrow">${esc(String(d.day || '').toUpperCase())} · ${esc(niceDate(todayStr()))}</div>
        <h1>Mathakondapalli<br>Model School</h1>
        <div class="library-wordmark">LIBRARY</div>
        <p class="hero-tagline">A reader today. A leader tomorrow.</p>
      </div>
      <div class="welcome-person">
        <div class="welcome-avatar icon-orb">${iconSvg('sun')}</div>
        <div>
          <div class="welcome-small">Good Morning,</div>
          <div class="welcome-name">Librarian!</div>
          <div class="welcome-date">${esc(niceDate(todayStr()))}</div>
        </div>
      </div>
    </section>

    <section class="dashboard-bento kpi-bento">
      <article class="dashboard-card kpi-card kpi-orange">
        <div class="kpi-icon">${iconSvg('users')}</div>
        <div class="kpi-copy"><span>Total Students</span><strong>—</strong><small>Student directory</small></div>
        <span class="kpi-arrow">${iconSvg('arrow')}</span>
      </article>
      <article class="dashboard-card kpi-card kpi-green">
        <div class="kpi-icon">${iconSvg('book')}</div>
        <div class="kpi-copy"><span>Active Readers</span><strong>—</strong><small>Reading tracking</small></div>
        <span class="kpi-arrow">${iconSvg('arrow')}</span>
      </article>
      <article class="dashboard-card kpi-card kpi-orange">
        <div class="kpi-icon">${iconSvg('calendar')}</div>
        <div class="kpi-copy"><span>Today's Attendance</span><strong>${d.present || 0}</strong><small>of ${totalMarked || 0} students marked</small></div>
        <span class="kpi-arrow">${iconSvg('arrow')}</span>
      </article>
      <article class="dashboard-card kpi-card kpi-green">
        <div class="kpi-icon">${iconSvg('document')}</div>
        <div class="kpi-copy"><span>Reading Records</span><strong>0</strong><small>Assessment records</small></div>
        <span class="kpi-arrow">${iconSvg('arrow')}</span>
      </article>
    </section>

    <section class="dashboard-bento main-bento">
      <article class="dashboard-card today-library bento-large">
        <div class="dash-card-head">
          <div class="heading-with-icon">
            <span class="section-icon orange-icon">${iconSvg('calendar')}</span>
            <div><h2>Today's Library</h2><p>Classes scheduled for today</p></div>
          </div>
          <span class="pill amber">${d.timetable.length} classes</span>
        </div>
        ${firstClass ? `
          <div class="today-session premium-session">
            <div class="session-time"><strong>${esc(firstClass.start)}</strong><strong>${esc(firstClass.end)}</strong></div>
            <div class="session-icon green-icon">${iconSvg('book')}</div>
            <div class="session-info">
              <strong>${esc(firstClass.classSection)}</strong>
              <span>Open attendance for this class</span>
            </div>
            <button class="btn" onclick="navigate('attendance',{grade:'${esc(firstClass.grade)}',section:'${esc(firstClass.section)}'})">Open <span>${iconSvg('arrow')}</span></button>
          </div>
        ` : '<div class="empty">No library sessions scheduled today.</div>'}
      </article>

      <article class="dashboard-card live-card">
        <div class="live-top"><span class="section-icon white-icon">${iconSvg('activity')}</span><span class="live-badge">NOW</span></div>
        <div class="live-title">Ongoing Activity</div>
        <div class="live-sub">Live library usage</div>
        <strong class="live-number">${totalMarked}</strong>
        <span class="live-label">Students marked today</span>
        <div class="mini-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
      </article>
    </section>

    <section class="dashboard-bento action-bento">
      <button class="dashboard-action action-orange" onclick="navigate('students')">
        <span class="action-icon">${iconSvg('users')}</span>
        <strong>Students</strong><small>View and manage<br>student data</small><span class="action-arrow">${iconSvg('arrow')}</span>
      </button>
      <button class="dashboard-action action-green" onclick="navigate('timetable')">
        <span class="action-icon">${iconSvg('calendar')}</span>
        <strong>Schedule</strong><small>Manage library<br>sessions</small><span class="action-arrow">${iconSvg('arrow')}</span>
      </button>
      <button class="dashboard-action action-orange" onclick="navigate('reports')">
        <span class="action-icon">${iconSvg('chart')}</span>
        <strong>Reports</strong><small>View insights<br>and analytics</small><span class="action-arrow">${iconSvg('arrow')}</span>
      </button>
    </section>

    <section class="dashboard-bento bottom-bento">
      <article class="dashboard-card attendance-card">
        <div class="dash-card-head">
          <div class="heading-with-icon"><span class="section-icon orange-icon">${iconSvg('check')}</span><div><h2>Attendance</h2><p>${totalMarked} students marked today</p></div></div>
          <span class="pill present"><span class="status-dot"></span>Updated</span>
        </div>
        <div class="attendance-split">
          <div><strong>${d.present || 0}</strong><span>Present</span></div>
          <div><strong>${d.absent || 0}</strong><span>Absent</span></div>
        </div>
        <button class="feature-button orange-button" onclick="navigate('attendance')">Mark / Edit Attendance <span>${iconSvg('arrow')}</span></button>
      </article>
      <article class="dashboard-card reading-card">
        <div class="dash-card-head">
          <div class="heading-with-icon"><span class="section-icon green-icon">${iconSvg('book')}</span><div><h2>Reading Tracking</h2><p>Current cycle: Week ${esc(d.cycle)}</p></div></div>
          <span class="pill">0 records</span>
        </div>
        <div class="reading-preview">
          <div class="reading-ring">${iconSvg('book')}</div>
          <div><strong>Four observations per month</strong><span>Track Fluency, Accuracy, Vocabulary and more.</span></div>
        </div>
        <button class="feature-button" onclick="navigate('assess')">Continue Reading Tracking <span>${iconSvg('arrow')}</span></button>
      </article>
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
    const count = w.classes.length;
    body.innerHTML = `
      <div class="bento-day-summary">
        <div class="day-orb">${iconSvg('calendar')}</div>
        <div><span class="eyebrow">${esc(w.day)}</span><h2>${esc(niceDate(w.date))}</h2><p>Library sessions and student activities</p></div>
        <div class="day-count"><strong>${count}</strong><span>sessions</span></div>
      </div>
      <div class="tt-session-grid">
      ${count ? w.classes.map((t,i) => `
        <article class="tt-session-card ${i===0?'featured':''}">
          <div class="tt-time"><strong>${esc(t.start)}</strong><span>${esc(t.end)}</span></div>
          <div class="tt-type-icon ${i%2?'teal':'orange'}">${iconSvg(i%2?'book':'calendar')}</div>
          <div class="tt-info"><strong>Grade ${esc(t.grade)} - ${esc(t.section)}</strong><span>${esc(t.classSection)}</span><small>${esc(t.note || 'Regular library session')}</small></div>
          <div class="tt-status">${w.date===today ? '<span class="pill amber">Today</span>' : '<span class="pill">Scheduled</span>'}</div>
          <button class="icon-button" title="Open attendance" onclick="navigate('attendance',{grade:'${esc(t.grade)}',section:'${esc(t.section)}',date:'${w.date}'})">${iconSvg('arrow')}</button>
        </article>`).join('') : '<div class="empty">No sessions this day.</div>'}
      </div>`;
  }

  content.innerHTML = `
    <section class="screen-hero timetable-hero">
      <div><div class="eyebrow">This week</div><h1>Timetable</h1><p>View library classes, activities and manage sessions.</p></div>
      <button class="btn hero-action" onclick="toast('Session creation will be connected to the timetable workflow.')">${iconSvg('calendar')} Add Session</button>
    </section>
    <div class="week-pills" id="ttTabs">
      ${week.map((w,i)=>`<button data-i="${i}" class="${i===active?'on':''}"><span>${esc(w.day.slice(0,3))}</span><strong>${esc(w.date.slice(8,10))}</strong></button>`).join('')}
    </div>
    <section class="tt-bento">
      <aside class="tt-side-card">
        <div class="tt-side-icon">${iconSvg('calendar')}</div>
        <h3>Weekly overview</h3>
        <div class="tt-side-stat"><strong>${week.reduce((n,w)=>n+w.classes.length,0)}</strong><span>Total sessions</span></div>
        <div class="tt-side-stat"><strong>${week.filter(w=>w.classes.length).length}</strong><span>Active days</span></div>
        <div class="quote-card">“Libraries build brighter futures.”<small>MMS LIBRARY</small></div>
      </aside>
      <div class="dashboard-card tt-body-card" id="ttBody"></div>
    </section>`;

  document.querySelectorAll('#ttTabs button').forEach(b=>b.addEventListener('click',()=>{
    document.querySelectorAll('#ttTabs button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); renderDay(Number(b.dataset.i));
  }));
  renderDay(active);
}

/* ---------------- STUDENTS ---------------- */
function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase() || '?';
}
function invalidateStudentCaches(){ sectionCache.clear(); }
async function loadSectionsInto(selectEl, grade, selected) {
  selectEl.innerHTML='<option value="">Select section</option>';
  if(!grade)return [];
  const sections=await apiGet('sections',{grade});
  sections.forEach(s=>selectEl.insertAdjacentHTML('beforeend',`<option value="${esc(s)}" ${String(s)===String(selected||'')?'selected':''}>Section ${esc(s)}</option>`));
  return sections;
}
async function viewStudents(content){
  content.innerHTML=`
    <section class="screen-hero students-hero">
      <div><div class="eyebrow">Student management</div><h1>Students</h1><p>Search, add and manage students without leaving the library workspace.</p></div>
      <button class="btn hero-action" onclick="navigate('add-student')">${iconSvg('users')} + Add Student</button>
    </section>
    <section class="student-kpis">
      <article><span class="mini-icon orange">${iconSvg('users')}</span><div><small>Total Students</small><strong id="stuTotal">—</strong><em>Directory</em></div></article>
      <article><span class="mini-icon teal">${iconSvg('check')}</span><div><small>Active Students</small><strong id="stuActive">—</strong><em>Current records</em></div></article>
      <article><span class="mini-icon orange">${iconSvg('book')}</span><div><small>Grade Groups</small><strong id="stuGrades">—</strong><em>Grades represented</em></div></article>
      <article><span class="mini-icon purple">${iconSvg('calendar')}</span><div><small>Sections</small><strong id="stuSections">—</strong><em>Active sections</em></div></article>
    </section>
    <section class="student-tools">
      <div class="searchbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg><input id="stuSearch" placeholder="Search name or admission number"></div>
      <div class="field"><select id="stuGrade"><option value="">All grades</option>${GRADES.map(g=>`<option value="${g}">Grade ${g}</option>`).join('')}</select></div>
      <div class="field"><select id="stuSection"><option value="">All sections</option></select></div>
    </section>
    <section class="student-bento">
      <article class="student-quick-card add"><div class="mini-icon orange">${iconSvg('users')}</div><h3>Add student</h3><p>Create a new library record.</p><button class="btn small" onclick="navigate('add-student')">Add student ${iconSvg('arrow')}</button></article>
      <article class="student-quick-card find"><div class="mini-icon teal">${iconSvg('activity')}</div><h3>Find student</h3><p>Search the directory by name or admission number.</p><button class="btn small green" onclick="document.getElementById('stuSearch').focus()">Search ${iconSvg('arrow')}</button></article>
      <div class="student-directory dashboard-card"><div class="dash-card-head"><div><div class="eyebrow">Directory</div><h2>Student records</h2></div><span class="pill" id="stuCount">0 records</span></div><div id="stuList"><div class="loading"><div class="spinner"></div>Loading…</div></div></div>
    </section>`;

  const search=document.getElementById('stuSearch'), gradeSel=document.getElementById('stuGrade'), sectionSel=document.getElementById('stuSection'), list=document.getElementById('stuList');
  async function refreshSections(){sectionSel.innerHTML='<option value="">All sections</option>';if(!gradeSel.value)return;const sections=await apiGet('sections',{grade:gradeSel.value});sections.forEach(s=>sectionSel.insertAdjacentHTML('beforeend',`<option value="${esc(s)}">Section ${esc(s)}</option>`));}
  async function refreshList(){
    setLoading(list);
    const students=await apiGet('students',{search:search.value,grade:gradeSel.value,section:sectionSel.value});
    document.getElementById('stuCount').textContent=students.length+' records';
    document.getElementById('stuTotal').textContent=students.length;
    document.getElementById('stuActive').textContent=students.length;
    document.getElementById('stuGrades').textContent=new Set(students.map(s=>String(s.grade))).size;
    document.getElementById('stuSections').textContent=new Set(students.map(s=>String(s.section))).size;
    list.innerHTML=students.length?students.map((s,i)=>`
      <div class="student-grid-row" onclick="navigate('profile',{id:'${esc(s.admissionNumber)}'})">
        <span class="row-num">${i+1}</span><div class="avatar">${esc(initials(s.studentName))}</div>
        <div class="student-main"><strong>${esc(s.studentName)}</strong><span>Adm# ${esc(s.admissionNumber)}</span></div>
        <span class="student-grade">Grade ${esc(s.grade)}</span><span class="student-section">${esc(s.section)}</span>
        <span class="pill present">Active</span>
        <div class="student-actions"><button class="btn small ghost" onclick="event.stopPropagation();navigate('edit-student',{id:'${esc(s.admissionNumber)}'})">Edit</button><button class="icon-button" onclick="event.stopPropagation();navigate('move-student',{id:'${esc(s.admissionNumber)}'})">${iconSvg('arrow')}</button></div>
      </div>`).join(''):'<div class="empty">No students match these filters.</div>';
  }
  let timer;search.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(refreshList,250)});gradeSel.addEventListener('change',async()=>{await refreshSections();refreshList()});sectionSel.addEventListener('change',refreshList);refreshList();
}

/* ---------------- STUDENT PROFILE ---------------- */
async function viewProfile(content, admissionNumber) {
  const p=await apiGet('studentProfile',{admissionNumber}); const s=p.student;
  content.innerHTML=`
    <div class="link-back" onclick="navigate('students')">← Students</div>
    <section class="profile-hero">
      <div class="profile-avatar">${esc(initials(s.studentName))}</div>
      <div class="profile-identity"><div class="eyebrow">Student profile</div><h1>${esc(s.studentName)}</h1><p>Grade ${esc(s.grade)} · Section ${esc(s.section)} · Admission No. ${esc(s.admissionNumber)}</p></div>
      <div class="profile-actions"><button class="btn" onclick="navigate('edit-student',{id:'${esc(s.admissionNumber)}'})">${iconSvg('document')} Edit</button><button class="btn green" onclick="navigate('move-student',{id:'${esc(s.admissionNumber)}'})">${iconSvg('arrow')} Move</button></div>
    </section>
    <section class="profile-kpis">
      <article class="profile-stat orange"><span>${iconSvg('check')}</span><div><small>Attendance</small><strong>${p.attendancePct}%</strong><em>Current record</em></div></article>
      <article class="profile-stat teal"><span>${iconSvg('calendar')}</span><div><small>Sessions logged</small><strong>${p.attendanceCount}</strong><em>Library visits</em></div></article>
      <article class="profile-stat orange"><span>${iconSvg('book')}</span><div><small>Reading assessments</small><strong>${p.assessments.length}</strong><em>Recorded cycles</em></div></article>
    </section>
    <section class="profile-grid">
      <article class="dashboard-card profile-rubric-card"><div class="dash-card-head"><div><div class="eyebrow">Reading history</div><h2>Assessment timeline</h2></div><button class="btn small" onclick="navigate('assess')">${iconSvg('book')} New assessment</button></div>
      ${p.assessments.length?p.assessments.slice().reverse().map(a=>`
        <div class="assessment-card"><div class="assessment-head"><div><strong>Cycle ${esc(a.cycle)}</strong><span>${esc(a.date)}</span></div><span class="pill amber">${a.overall}% overall</span></div>
        <div class="rubric-grid">${RUBRIC_KEYS.map(k=>`<div><span>${RUBRIC_LABELS[k]}</span><div class="rubric-track"><i style="width:${(a[k]||0)/5*100}%"></i></div><strong>${a[k]||0}/5</strong></div>`).join('')}</div>
        ${a.observation?`<p class="assessment-note">${esc(a.observation)}</p>`:''}</div>`).join(''):'<div class="empty">No assessments recorded yet.</div>'}</article>
      <aside class="dashboard-card profile-side-card"><div class="section-icon green-icon">${iconSvg('users')}</div><h2>Student information</h2><div class="info-line"><span>Grade</span><strong>${esc(s.grade)}</strong></div><div class="info-line"><span>Section</span><strong>${esc(s.section)}</strong></div><div class="info-line"><span>Admission</span><strong>${esc(s.admissionNumber)}</strong></div><div class="info-line"><span>Attendance</span><strong>${p.attendancePct}%</strong></div></aside>
    </section>`;
}

/* ---------------- ADD / EDIT STUDENT ---------------- */
async function viewStudentForm(content, mode, admissionNumber) {
  let existing=null;if(mode==='edit'){const p=await apiGet('studentProfile',{admissionNumber});existing=p.student;}
  const edit=mode==='edit';
  content.innerHTML=`
    <div class="link-back" onclick="${edit?`navigate('profile',{id:'${esc(admissionNumber)}'})`:`navigate('students')`}">← Back</div>
    <section class="screen-hero form-hero"><div><div class="eyebrow">${edit?'Student management':'New record'}</div><h1>${edit?'Edit student':'Add student'}</h1><p>${edit?'Update student information without changing the permanent admission key.':'Create a student record for library attendance and reading tracking.'}</p></div><div class="form-hero-icon">${iconSvg('users')}</div></section>
    <section class="form-bento">
      <article class="dashboard-card form-main"><div class="dash-card-head"><div><div class="eyebrow">Student details</div><h2>${edit?'Update record':'Create record'}</h2></div><span class="pill">${edit?'EDIT':'NEW'}</span></div>
        <div class="form-grid"><div class="field wide"><label>Student name</label><input id="stuNameForm" type="text" value="${esc(existing?existing.studentName:'')}" placeholder="Full student name"></div>
        <div class="field"><label>Admission number</label><input id="stuAdmForm" type="text" value="${esc(existing?existing.admissionNumber:'')}" placeholder="Admission number" ${edit?'readonly':''}></div>
        <div class="field"><label>Grade</label><select id="stuGradeForm"><option value="">Select grade</option>${GRADES.map(g=>`<option value="${g}" ${existing&&String(existing.grade)===String(g)?'selected':''}>Grade ${g}</option>`).join('')}</select></div>
        <div class="field"><label>Section</label><select id="stuSectionForm"><option value="">Select grade first</option></select></div></div>
        <div class="form-actions"><button class="btn ghost" onclick="${edit?`navigate('profile',{id:'${esc(admissionNumber)}'})`:`navigate('students')`}">Cancel</button><button class="btn" id="studentSaveBtn">${edit?'Save changes':'Add student'} ${iconSvg('arrow')}</button></div>
      </article>
      <aside class="dashboard-card form-side"><div class="section-icon orange-icon">${iconSvg('check')}</div><h3>${edit?'Permanent key':'Before saving'}</h3><p>${edit?'The admission number remains locked because attendance and reading history are connected to it.':'Make sure the admission number is unique and stable before creating the record.'}</p><div class="form-tip"><span>${iconSvg('document')}</span><strong>Library record</strong><small>Attendance and reading history stay connected.</small></div></aside>
    </section>`;
  const nameInput=document.getElementById('stuNameForm'),admInput=document.getElementById('stuAdmForm'),gradeSel=document.getElementById('stuGradeForm'),sectionSel=document.getElementById('stuSectionForm'),saveBtn=document.getElementById('studentSaveBtn');
  async function loadFormSections(selected){sectionSel.innerHTML='<option value="">Select section</option>';if(!gradeSel.value)return;await loadSectionsInto(sectionSel,gradeSel.value,selected)}
  gradeSel.addEventListener('change',()=>loadFormSections(''));await loadFormSections(existing?existing.section:'');
  saveBtn.addEventListener('click',async()=>{const studentName=nameInput.value.trim(),admission=admInput.value.trim(),grade=gradeSel.value,section=sectionSel.value.trim();if(!studentName||!admission||!grade||!section){toast('Please complete name, admission number, grade and section.');return}saveBtn.disabled=true;saveBtn.textContent=edit?'Saving…':'Adding…';try{if(edit){await apiPost('updateStudent',{admissionNumber:admission,studentName,grade,section});invalidateStudentCaches();toast('Student data updated.');setTimeout(()=>navigate('profile',{id:admission}),350)}else{await apiPost('addStudent',{admissionNumber:admission,studentName,grade,section});invalidateStudentCaches();toast('Student added.');setTimeout(()=>navigate('students'),350)}}catch(err){toast('Could not save: '+err.message)}finally{saveBtn.disabled=false;saveBtn.textContent=edit?'Save changes':'Add student'}});
}

/* ---------------- MOVE STUDENT ---------------- */
async function viewMoveStudent(content, admissionNumber) {
  const p=await apiGet('studentProfile',{admissionNumber}),s=p.student;
  content.innerHTML=`
    <div class="link-back" onclick="navigate('profile',{id:'${esc(admissionNumber)}'})">← Back to profile</div>
    <section class="screen-hero move-hero"><div><div class="eyebrow">Section management</div><h1>Move student</h1><p>Move this student to another section while preserving attendance and reading history.</p></div><div class="move-orb">${iconSvg('arrow')}</div></section>
    <section class="move-bento">
      <article class="dashboard-card current-student-card"><div class="avatar large">${esc(initials(s.studentName))}</div><div class="eyebrow">Current record</div><h2>${esc(s.studentName)}</h2><p>Admission ${esc(s.admissionNumber)}</p><div class="current-class"><span>Grade</span><strong>${esc(s.grade)}</strong><span>Section</span><strong>${esc(s.section)}</strong></div></article>
      <article class="dashboard-card move-form-card"><div class="section-icon green-icon">${iconSvg('arrow')}</div><div class="eyebrow">Destination</div><h2>Choose new section</h2><p>Keep the same student record and move only the section.</p><div class="field"><label>Existing section</label><select id="moveSection"><option value="">Select section</option></select></div><div class="field"><label>Or enter new section</label><input id="moveNewSection" type="text" placeholder="Example: B"></div><div class="form-actions"><button class="btn ghost" onclick="navigate('profile',{id:'${esc(admissionNumber)}'})">Cancel</button><button class="btn green" id="moveSave">Move to section ${iconSvg('arrow')}</button></div></article>
    </section>`;
  const select=document.getElementById('moveSection'),newSection=document.getElementById('moveNewSection'),save=document.getElementById('moveSave');await loadSectionsInto(select,s.grade,'');
  save.addEventListener('click',async()=>{const target=newSection.value.trim()||select.value.trim();if(!target){toast('Select or enter the destination section.');return}if(target===String(s.section)){toast('Choose a different section.');return}save.disabled=true;save.textContent='Moving…';try{await apiPost('moveStudent',{admissionNumber:s.admissionNumber,grade:s.grade,section:target});invalidateStudentCaches();toast('Student moved to Section '+target+'.');setTimeout(()=>navigate('profile',{id:s.admissionNumber}),350)}catch(err){toast('Could not move student: '+err.message)}finally{save.disabled=false;save.textContent='Move to section'}});
}

/* ---------------- ATTENDANCE ---------------- */
async function viewAttendance(content){
  const params=state.params||{}, date=params.date||todayStr();
  content.innerHTML=`
    <section class="screen-hero attendance-hero">
      <div><div class="eyebrow">Library session</div><h1>Attendance</h1><p>Mark and manage student attendance for library sessions.</p></div>
      <div class="quick-actions"><button class="btn ghost" onclick="toast('Select a class first.')">${iconSvg('check')} Mark All Present</button><button class="btn ghost" onclick="toast('Import workflow ready for integration.')">${iconSvg('document')} Import</button><button class="btn ghost" onclick="toast('Reports can be exported from Reports.')">${iconSvg('chart')} Export</button></div>
    </section>
    <section class="attendance-filters dashboard-card"><div class="field"><label>Date</label><input id="attDate" type="date" value="${date}"></div><div class="field"><label>Grade</label><select id="attGrade"><option value="">Select</option>${GRADES.map(g=>`<option value="${g}" ${g===params.grade?'selected':''}>Grade ${g}</option>`).join('')}</select></div><div class="field"><label>Section</label><select id="attSection"><option value="">Select</option></select></div><button class="btn" id="attLoad">Load Students</button></section>
    <section class="attendance-bento">
      <article class="selected-session dashboard-card" id="attSummary"><div class="empty">Choose a date, grade and section.</div></article>
      <article class="attendance-list dashboard-card"><div class="dash-card-head"><div><div class="eyebrow">Student list</div><h2>Attendance register</h2></div><span class="pill" id="attCount">0</span></div><div id="attList"><div class="empty">No session loaded.</div></div><button class="btn block" id="attSave" style="display:none;margin-top:1rem">Save Attendance</button></article>
    </section>`;

  const gradeSel=document.getElementById('attGrade'),sectionSel=document.getElementById('attSection'),dateInput=document.getElementById('attDate'),list=document.getElementById('attList'),saveBtn=document.getElementById('attSave'),summary=document.getElementById('attSummary');let currentStudents=[];
  async function refreshSections(pre){sectionSel.innerHTML='<option value="">Select</option>';if(!gradeSel.value)return;const ss=await apiGet('sections',{grade:gradeSel.value});ss.forEach(s=>sectionSel.insertAdjacentHTML('beforeend',`<option value="${esc(s)}">Section ${esc(s)}</option>`));if(pre&&ss.includes(pre))sectionSel.value=pre}
  async function loadClass(){if(!gradeSel.value||!sectionSel.value){summary.innerHTML='<div class="empty">Choose a date, grade and section.</div>';list.innerHTML='<div class="empty">No session loaded.</div>';saveBtn.style.display='none';return}setLoading(list);currentStudents=await apiGet('attendanceForClass',{dateStr:dateInput.value,grade:gradeSel.value,section:sectionSel.value});const present=currentStudents.filter(s=>s.status==='Present').length,absent=currentStudents.filter(s=>s.status==='Absent').length;summary.innerHTML=`<div class="selected-icon">${iconSvg('book')}</div><div><div class="eyebrow">Selected session</div><h2>Grade ${esc(gradeSel.value)} - ${esc(sectionSel.value)}</h2><p>${esc(dateInput.value)}</p></div><div class="attendance-total"><strong>${currentStudents.length}</strong><span>Total students</span></div><div class="attendance-mini"><div><strong>${present}</strong><span>Present</span></div><div><strong>${absent}</strong><span>Absent</span></div></div>`;renderList();saveBtn.style.display=currentStudents.length?'flex':'none';document.getElementById('attCount').textContent=currentStudents.length+' students'}
  function renderList(){const present=currentStudents.filter(s=>s.status==='Present').length;list.innerHTML=currentStudents.length?currentStudents.map((s,i)=>`<div class="att-grid-row"><span class="row-num">${i+1}</span><div class="avatar">${esc(initials(s.studentName))}</div><div class="student-main"><strong>${esc(s.studentName)}</strong><span>Adm# ${esc(s.admissionNumber)}</span></div><div class="att-toggle"><button class="present ${s.status==='Present'?'on':''}" onclick="setAttStatus(${i},'Present')">Present</button><button class="absent ${s.status==='Absent'?'on':''}" onclick="setAttStatus(${i},'Absent')">Absent</button></div></div>`).join(''):'<div class="empty">No students found for this class.</div>'}
  window.setAttStatus=(i,status)=>{currentStudents[i].status=status;renderList()};
  saveBtn.addEventListener('click',async()=>{if(currentStudents.some(s=>!s.status)){toast('Please mark all students first.');return}saveBtn.disabled=true;saveBtn.textContent='Saving…';try{await apiPost('saveAttendance',{records:currentStudents.map(s=>({...s,date:dateInput.value,grade:gradeSel.value,section:sectionSel.value}))});toast('Attendance saved.');await loadClass()}catch(err){toast('Could not save: '+err.message)}finally{saveBtn.disabled=false;saveBtn.textContent='Save Attendance'}});
  document.getElementById('attLoad').addEventListener('click',loadClass);gradeSel.addEventListener('change',async()=>{await refreshSections();});if(params.grade){await refreshSections(params.section);await loadClass()}
}

/* ---------------- READING ASSESSMENT ---------------- */
async function viewAssess(content) {
  content.innerHTML=`
    <section class="screen-hero assess-hero"><div><div class="eyebrow">Reading rubric</div><h1>Reading Assessment</h1><p>Capture the six reading dimensions with a simple visual scorecard.</p></div><div class="assess-orb">${iconSvg('book')}</div></section>
    <section class="assess-bento">
      <article class="dashboard-card assess-context"><div class="section-icon green-icon">${iconSvg('book')}</div><div class="eyebrow">Session setup</div><h2>Choose student</h2><div class="field"><label>Date</label><input id="asDate" type="date" value="${todayStr()}"></div><div class="field"><label>Grade</label><select id="asGrade"><option value="">Select</option>${GRADES.map(g=>`<option value="${g}">Grade ${g}</option>`).join('')}</select></div><div class="field"><label>Section</label><select id="asSection"><option value="">Select</option></select></div><div class="field"><label>Student</label><select id="asStudent"><option value="">Select grade & section first</option></select></div></article>
      <article class="dashboard-card rubric-card" id="asForm" style="display:none"><div class="dash-card-head"><div><div class="eyebrow">Six dimensions</div><h2>Reading scorecard</h2></div><span class="pill amber">1–5 scale</span></div>
        <div class="rubric-bento">${RUBRIC_KEYS.map(k=>`<div class="rubric-tile"><div><strong>${RUBRIC_LABELS[k]}</strong><span class="score" id="asScore_${k}">3/5</span></div><div class="dots" id="asDots_${k}">${[1,2,3,4,5].map(n=>`<button data-k="${k}" data-n="${n}">${n}</button>`).join('')}</div></div>`).join('')}</div>
        <div class="field"><label>Observation</label><textarea id="asObs" placeholder="Notes on this student's reading session…"></textarea></div><button class="btn block" id="asSave">Save Assessment ${iconSvg('check')}</button>
      </article>
      <aside class="dashboard-card assess-scale"><div class="section-icon orange-icon">${iconSvg('chart')}</div><h3>Scoring guide</h3><div class="scale-line"><strong>1</strong><span>Rarely</span></div><div class="scale-line"><strong>2</strong><span>Sometimes</span></div><div class="scale-line"><strong>3</strong><span>Often</span></div><div class="scale-line"><strong>4</strong><span>Consistent</span></div><div class="scale-line"><strong>5</strong><span>Highly consistent</span></div></aside>
    </section>`;
  const gradeSel=document.getElementById('asGrade'),sectionSel=document.getElementById('asSection'),studentSel=document.getElementById('asStudent'),formEl=document.getElementById('asForm'),scores={};RUBRIC_KEYS.forEach(k=>scores[k]=3);
  function paintDots(k){document.querySelectorAll(`#asDots_${k} button`).forEach(b=>b.classList.toggle('on',Number(b.dataset.n)<=scores[k]));document.getElementById(`asScore_${k}`).textContent=scores[k]+'/5'}
  RUBRIC_KEYS.forEach(paintDots);document.querySelectorAll('.dots button').forEach(b=>b.addEventListener('click',()=>{scores[b.dataset.k]=Number(b.dataset.n);paintDots(b.dataset.k)}));
  async function refreshSections(){sectionSel.innerHTML='<option value="">Select</option>';studentSel.innerHTML='<option value="">Select grade & section first</option>';formEl.style.display='none';if(!gradeSel.value)return;const sections=await apiGet('sections',{grade:gradeSel.value});sections.forEach(s=>sectionSel.insertAdjacentHTML('beforeend',`<option value="${esc(s)}">Section ${esc(s)}</option>`))}
  async function refreshStudents(){studentSel.innerHTML='<option value="">Select</option>';formEl.style.display='none';if(!gradeSel.value||!sectionSel.value)return;const students=await apiGet('students',{grade:gradeSel.value,section:sectionSel.value});students.forEach(s=>studentSel.insertAdjacentHTML('beforeend',`<option value="${esc(s.admissionNumber)}" data-name="${esc(s.studentName)}">${esc(s.studentName)}</option>`))}
  studentSel.addEventListener('change',()=>{formEl.style.display=studentSel.value?'block':'none'});gradeSel.addEventListener('change',refreshSections);sectionSel.addEventListener('change',refreshStudents);
  document.getElementById('asSave').addEventListener('click',async e=>{const btn=e.target;btn.disabled=true;btn.textContent='Saving…';try{const opt=studentSel.selectedOptions[0];await apiPost('saveReadingAssessment',{date:document.getElementById('asDate').value,admissionNumber:studentSel.value,studentName:opt.dataset.name,grade:gradeSel.value,section:sectionSel.value,observation:document.getElementById('asObs').value,...scores});toast('Assessment saved.');document.getElementById('asObs').value=''}catch(err){toast('Could not save: '+err.message)}finally{btn.disabled=false;btn.textContent='Save Assessment'}});
}

/* ---------------- REPORTS ---------------- */
async function viewReports(content){
  const month=todayStr().slice(0,7);
  content.innerHTML=`
    <section class="screen-hero reports-hero"><div><div class="eyebrow">Monthly summary</div><h1>Reports</h1><p>View library attendance and reading progress at a glance.</p></div><div class="field report-month"><label>Month</label><input id="repMonth" type="month" value="${month}"></div></section>
    <section class="report-kpis"><article><span class="mini-icon orange">${iconSvg('check')}</span><div><small>Students tracked</small><strong id="repStudents">—</strong></div></article><article><span class="mini-icon teal">${iconSvg('calendar')}</span><div><small>Attendance records</small><strong id="repAttendance">—</strong></div></article><article><span class="mini-icon purple">${iconSvg('book')}</span><div><small>Reading assessments</small><strong id="repReading">—</strong></div></article><article><span class="mini-icon orange">${iconSvg('chart')}</span><div><small>Avg attendance</small><strong id="repAvg">—</strong></div></article></section>
    <section class="reports-bento"><article class="report-chart-card dashboard-card"><div class="dash-card-head"><div><div class="eyebrow">Student performance</div><h2>Monthly activity</h2></div><span class="pill">Live data</span></div><div class="report-bars" id="repBars"></div></article><article class="report-export-card dashboard-card"><div class="mini-icon orange">${iconSvg('document')}</div><h2>Export Reports</h2><p>Use the monthly data for school records and parent communication.</p><button class="btn block" onclick="toast('PDF export can be connected next.')">PDF Report</button><button class="btn green block" onclick="toast('Excel export can be connected next.')">Excel Report</button></article><article class="report-list-card dashboard-card"><div class="dash-card-head"><div><div class="eyebrow">Monthly student report</div><h2>Student insights</h2></div><span class="pill" id="repCount">0</span></div><div id="repList"><div class="loading"><div class="spinner"></div>Loading…</div></div></article></section>`;
  async function load(){const list=document.getElementById('repList');setLoading(list);const r=await apiGet('reports',{month:document.getElementById('repMonth').value});const rows=r.students.filter(s=>s.attendanceTotal||s.assessments);const avg=rows.length?Math.round(rows.reduce((n,s)=>n+Number(s.attendancePct||0),0)/rows.length):0;document.getElementById('repStudents').textContent=rows.length;document.getElementById('repAttendance').textContent=rows.reduce((n,s)=>n+Number(s.attendanceTotal||0),0);document.getElementById('repReading').textContent=rows.reduce((n,s)=>n+Number(s.assessments||0),0);document.getElementById('repAvg').textContent=avg+'%';document.getElementById('repCount').textContent=rows.length+' students';document.getElementById('repBars').innerHTML=rows.slice(0,12).map((s,i)=>`<div class="report-bar"><span>${esc(s.studentName.split(' ')[0])}</span><i><b style="width:${Math.min(100,Number(s.attendancePct||0))}%"></b></i><strong>${Number(s.attendancePct||0)}%</strong></div>`).join('')||'<div class="empty">No monthly activity recorded.</div>';list.innerHTML=rows.length?rows.map(s=>`<div class="report-row" onclick="navigate('profile',{id:'${esc(s.admissionNumber)}'})"><div class="avatar">${esc(initials(s.studentName))}</div><div class="student-main"><strong>${esc(s.studentName)}</strong><span>Grade ${esc(s.grade)} - ${esc(s.section)}</span></div><span class="pill ${Number(s.attendancePct)>=75?'present':'absent'}">${Number(s.attendancePct||0)}% att.</span><span class="pill amber">${Number(s.readingScore||0)}% read.</span></div>`).join(''):'<div class="empty">No activity recorded for this month yet.</div>'}
  document.getElementById('repMonth').addEventListener('change',load);load();
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
