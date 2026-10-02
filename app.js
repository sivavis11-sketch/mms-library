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

const API_TIMEOUT_MS = 20000;
const API_RETRIES = 1;
const pendingGets = new Map();
const sectionCache = new Map();
const SECTION_CACHE_MS = 5 * 60 * 1000;

// Apps Script cold starts and large sheets regularly take longer than 12s.
const APPS_SCRIPT_RUN_TIMEOUT_MS = 45000;

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
    script.referrerPolicy = 'strict-origin-when-cross-origin';
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

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Failed to reach library server'));
    }, API_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      try { frame.remove(); } catch (err) {}
    }

    function onMessage(event) {
      const data = event && event.data;
      if (!data || data.source !== 'mms-library-api' || data.token !== token) return;

      settled = true;
      cleanup();

      if (!data.ok) {
        reject(new Error(data.error || 'Request failed'));
        return;
      }

      resolve(data.data);
    }

    window.addEventListener('message', onMessage);

    const query = new URLSearchParams({
      ...params,
      transport: 'message',
      token,
      origin: location.origin,
      _t: Date.now().toString()
    });

    frame.title = 'MMS Library API';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.position = 'fixed';
    frame.style.width = '1px';
    frame.style.height = '1px';
    frame.style.opacity = '0';
    frame.style.pointerEvents = 'none';
    frame.style.border = '0';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.src = API_URL + '?' + query.toString();
    document.body.appendChild(frame);
  });
}

async function apiGetWithPwaFallback(params) {
  try {
    return await jsonpRequest(params);
  } catch (jsonpError) {
    try {
      return await messageBridgeRequest(params);
    } catch (bridgeError) {
      // Surface the bridge error because it is the second transport's actual
      // failure and is more useful than the original JSONP error.
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
  const hash = '#/' + route + (params && params.id ? '/' + encodeURIComponent(params.id) : '');
  // Changing the hash fires hashchange, which would render a second time and
  // drop params such as grade/section. Remember the hash we set so that the
  // listener can ignore it.
  if (location.hash !== hash) {
    state.ignoreHash = hash;
    location.hash = hash;
  }
  window.scrollTo(0, 0);
  render();
}

window.addEventListener('hashchange', () => {
  if (state.ignoreHash && location.hash === state.ignoreHash) {
    state.ignoreHash = null;
    return;
  }
  state.ignoreHash = null;
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
        ${pageHead('Library connection', 'We couldn\'t load this page', '')}
        <div class="connection-error">
          <p>${esc(msg)}</p>
          <div class="actions-row">
            <button class="btn small" onclick="render()">Try again</button>
            <button class="btn soft small" onclick="navigate('dashboard')">Back to home</button>
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
    arrow: '<path d="M5 12h13M13 7l5 5-5 5"/>',
    play: '<path d="M7 4l13 8-13 8z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    swap: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>'
  };
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || paths.arrow) + '</svg>';
}

/* ---------------- page building blocks ---------------- */
function pageHead(chapter, title, meta, action) {
  return `
    <header class="page-head">
      <div class="page-head-top"><span class="chapter">${chapter}</span><span class="page-meta">${meta || ''}</span></div>
      <div class="page-title-row"><h1>${title}</h1>${action || ''}</div>
      <div class="rule"></div>
    </header>`;
}
function pageNum(n) { return `<div class="page-num">page ${n}</div>`; }
// The orange folder-tab panel used for each page's key figure.
function heroTab(label, body, extraClass) {
  return `
    <section class="hero-tab ${extraClass || ''}">
      <div class="hero-tab-top"><span>${label}</span><i></i></div>
      <div class="hero-tab-body on-orange">${body}</div>
    </section>`;
}
function tint(i) { return 't' + ((i % 5) + 1); }
function shortDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short' });
}
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
function scoreClass(n) {
  const v = Math.round(Number(n) || 0);
  return v >= 1 && v <= 5 ? 's' + v : '';
}

/* ---------------- DASHBOARD ---------------- */
async function viewDashboard(content) {
  if (!apiConfigured()) {
    content.innerHTML = pageHead('Welcome', 'MMS Library', esc(shortDate(todayStr()))) + setupBanner();
    return;
  }

  const d = await apiGet('dashboard', { date: todayStr() });
  if (!d) throw new Error('The library server returned no data for the dashboard.');
  if (!Array.isArray(d.timetable)) d.timetable = [];
  const present = Number(d.present || 0), absent = Number(d.absent || 0);
  const totalMarked = present + absent;

  const sessions = d.timetable.map((t, i) => `
    <div class="ledger-row">
      <div class="time-block ${tint(i + 1)}"><strong>${esc(t.start)}</strong><span>${esc(t.end)}</span></div>
      <div class="row-main"><strong>${t.grade ? `Grade ${esc(t.grade)} · ${esc(t.section)}` : esc(t.classSection)}</strong><span>${esc(t.note || 'Regular library session')}</span></div>
      <button class="icon-btn" aria-label="Open attendance" onclick="navigate('attendance',{grade:'${esc(t.grade)}',section:'${esc(t.section)}'})">${iconSvg('arrow')}</button>
    </div>`).join('');

  content.innerHTML = `
    ${pageHead('Chapter I', greeting(), esc(shortDate(todayStr())))}
    ${heroTab('Attendance today', `
      <div class="hero-stack">
        <div class="big-num"><strong>${present}</strong><span>of ${totalMarked}</span></div>
        <div class="chips"><span class="chip present">${present} present</span><span class="chip absent">${absent} absent</span></div>
      </div>`, 'with-float')}
    <div class="float-action"><button class="btn soft small" onclick="navigate('attendance')">Mark attendance <span class="knob">${iconSvg('play')}</span></button></div>
    <div class="stat-strip">
      <div><strong>${d.timetable.length}</strong><span>Sessions today</span></div>
      <div><strong>${totalMarked}</strong><span>Marked today</span></div>
      <div><strong>${esc(d.cycle || '—')}</strong><span>Reading week</span></div>
    </div>
    <div class="section-title">Today's sessions</div>
    <div class="ledger">${sessions || '<div class="empty">No library sessions today.</div>'}</div>
    <div class="actions-row">
      <button class="btn soft" onclick="navigate('assess')">${iconSvg('book')} Reading</button>
      <button class="btn soft" onclick="navigate('students')">${iconSvg('users')} Students</button>
    </div>
    ${pageNum(1)}`;
}

/* ---------------- TIMETABLE ---------------- */
async function viewTimetable(content) {
  const week = await apiGet('weeklyTimetable', { date: todayStr() });
  const today = todayStr();
  let active = week.findIndex(w => w.date === today);
  if (active < 0) active = 0;
  const total = week.reduce((n, w) => n + w.classes.length, 0);

  function renderDay(idx) {
    const w = week[idx];
    const count = w.classes.length;
    document.getElementById('ttBody').innerHTML = `
      ${heroTab(esc(shortDate(w.date)), `
        <div class="big-num"><strong>${count}</strong><span>${count === 1 ? 'session' : 'sessions'}</span></div>
        <span class="chip lilac">${total} this week</span>`)}
      <div class="ledger">
      ${count ? w.classes.map((t, i) => `
        <div class="ledger-row">
          <div class="time-block ${tint(i)}"><strong>${esc(t.start)}</strong><span>${esc(t.end)}</span></div>
          <div class="row-main"><strong>Grade ${esc(t.grade)} · ${esc(t.section)}</strong><span>${esc(t.note || 'Regular library session')}</span></div>
          <span class="tag ${w.date === today ? 'now' : ''}">${w.date === today ? 'Today' : 'Planned'}</span>
          <button class="icon-btn" aria-label="Open attendance" onclick="navigate('attendance',{grade:'${esc(t.grade)}',section:'${esc(t.section)}',date:'${w.date}'})">${iconSvg('arrow')}</button>
        </div>`).join('') : '<div class="empty">No sessions on this day.</div>'}
      </div>`;
  }

  content.innerHTML = `
    ${pageHead('Chapter II', 'Timetable', 'This week', `<button class="btn soft tiny" onclick="toast('Adding sessions will be connected to the timetable sheet next.')">${iconSvg('plus')} Add session</button>`)}
    <div class="week-pills" id="ttTabs">
      ${week.map((w, i) => `<button data-i="${i}" class="${i === active ? 'on' : ''}"><span>${esc(w.day.slice(0, 3))}</span><strong>${Number(w.date.slice(8, 10))}</strong></button>`).join('')}
    </div>
    <div class="stack" id="ttBody"></div>
    ${pageNum(2)}`;

  document.querySelectorAll('#ttTabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#ttTabs button').forEach(x => x.classList.remove('on'));
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
  selectEl.innerHTML='<option value="">Choose</option>';
  if(!grade)return [];
  const sections=await apiGet('sections',{grade});
  sections.forEach(s=>selectEl.insertAdjacentHTML('beforeend',`<option value="${esc(s)}" ${String(s)===String(selected||'')?'selected':''}>Section ${esc(s)}</option>`));
  return sections;
}
async function viewStudents(content){
  content.innerHTML=`
    ${pageHead('Chapter III', 'Students', '<span id="stuCount"></span>')}
    <label class="searchbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input id="stuSearch" placeholder="Search by name or admission no." aria-label="Search students"></label>
    <div class="filter-grid">
      <div class="field"><select id="stuGrade" aria-label="Grade"><option value="">All grades</option>${GRADES.map(g=>`<option value="${g}">Grade ${g}</option>`).join('')}</select></div>
      <div class="field"><select id="stuSection" aria-label="Section"><option value="">All sections</option></select></div>
    </div>
    ${heroTab('<span id="stuHeroLabel">All students</span>', `
      <div class="big-num"><strong id="stuTotal">—</strong><span>students</span></div>
      <button class="btn soft small" onclick="navigate('add-student')">${iconSvg('plus')} Add student</button>`)}
    <div class="ledger" id="stuList"><div class="loading"><div class="spinner"></div>Loading…</div></div>
    ${pageNum(3)}`;

  const search=document.getElementById('stuSearch'), gradeSel=document.getElementById('stuGrade'), sectionSel=document.getElementById('stuSection'), list=document.getElementById('stuList');
  async function refreshSections(){sectionSel.innerHTML='<option value="">All sections</option>';if(!gradeSel.value)return;const sections=await apiGet('sections',{grade:gradeSel.value});sections.forEach(s=>sectionSel.insertAdjacentHTML('beforeend',`<option value="${esc(s)}">Section ${esc(s)}</option>`));}
  async function refreshList(){
    setLoading(list);
    const students=await apiGet('students',{search:search.value,grade:gradeSel.value,section:sectionSel.value});
    document.getElementById('stuCount').textContent=students.length+(students.length===1?' reader':' readers');
    document.getElementById('stuTotal').textContent=students.length;
    document.getElementById('stuHeroLabel').textContent=gradeSel.value?('Grade '+gradeSel.value+(sectionSel.value?' · Section '+sectionSel.value:'')):'All students';
    list.innerHTML=students.length?students.map((s,i)=>`
      <div class="ledger-row clickable" onclick="navigate('profile',{id:'${esc(s.admissionNumber)}'})">
        <span class="avatar ${tint(i)}">${esc(initials(s.studentName))}</span>
        <div class="row-main"><strong>${esc(s.studentName)}</strong><span>Adm ${esc(s.admissionNumber)} · Grade ${esc(s.grade)} · ${esc(s.section)}</span></div>
        <div class="row-actions">
          <button class="btn soft tiny" onclick="event.stopPropagation();navigate('edit-student',{id:'${esc(s.admissionNumber)}'})">Edit</button>
          <button class="icon-btn" title="Move section" aria-label="Move section" onclick="event.stopPropagation();navigate('move-student',{id:'${esc(s.admissionNumber)}'})">${iconSvg('swap')}</button>
        </div>
      </div>`).join(''):'<div class="empty">No students match these filters.</div>';
  }
  let timer;search.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(refreshList,250)});gradeSel.addEventListener('change',async()=>{await refreshSections();refreshList()});sectionSel.addEventListener('change',refreshList);refreshList();
}

/* ---------------- STUDENT PROFILE ---------------- */
async function viewProfile(content, admissionNumber) {
  const p=await apiGet('studentProfile',{admissionNumber}); const s=p.student;
  const history=p.assessments.slice().reverse().map(a=>`
    <div class="ledger-row column">
      <div class="row-top">
        <div class="row-main"><strong>Cycle ${esc(a.cycle)}</strong><span>${esc(a.date)}</span></div>
        <span class="chip dot ${scoreClass((Number(a.overall)||0)/20)}">${esc(a.overall)}% overall</span>
      </div>
      <div class="mini-scores">${RUBRIC_KEYS.map(k=>`<div>${RUBRIC_LABELS[k]}<span class="dot ${scoreClass(a[k])}">${Number(a[k])||'–'}</span></div>`).join('')}</div>
      ${a.observation?`<p class="quote">“${esc(a.observation)}”</p>`:''}
    </div>`).join('');
  content.innerHTML=`
    <button class="link-back" onclick="navigate('students')">← Students</button>
    ${pageHead('Student profile', esc(s.studentName), 'Adm '+esc(s.admissionNumber))}
    ${heroTab(`Grade ${esc(s.grade)} · Section ${esc(s.section)}`, `
      <div class="hero-stack">
        <div class="big-num"><strong>${Number(p.attendancePct)||0}%</strong><span>attendance</span></div>
        <div class="chips"><span class="chip present">${esc(p.attendanceCount)} sessions</span><span class="chip sand">${p.assessments.length} reading checks</span></div>
      </div>
      <div class="hero-actions">
        <button class="btn soft tiny" onclick="navigate('edit-student',{id:'${esc(s.admissionNumber)}'})">Edit</button>
        <button class="btn soft tiny" onclick="navigate('move-student',{id:'${esc(s.admissionNumber)}'})">Move</button>
      </div>`)}
    <div class="page-title-row"><div class="section-title">Reading history</div><button class="btn soft tiny" onclick="navigate('assess')">${iconSvg('book')} New check</button></div>
    <div class="ledger">${history||'<div class="empty">No reading checks recorded yet.</div>'}</div>`;
}

/* ---------------- ADD / EDIT STUDENT ---------------- */
async function viewStudentForm(content, mode, admissionNumber) {
  let existing=null;if(mode==='edit'){const p=await apiGet('studentProfile',{admissionNumber});existing=p.student;}
  const edit=mode==='edit';
  const back=edit?`navigate('profile',{id:'${esc(admissionNumber)}'})`:`navigate('students')`;
  content.innerHTML=`
    <button class="link-back" onclick="${back}">← Back</button>
    ${pageHead(edit?'Student record':'New record', edit?'Edit student':'Add student', '')}
    <div class="card stack">
      <div class="form-grid">
        <div class="field wide"><label for="stuNameForm">Student name</label><input id="stuNameForm" type="text" value="${esc(existing?existing.studentName:'')}" placeholder="Full student name"></div>
        <div class="field wide"><label for="stuAdmForm">Admission number</label><input id="stuAdmForm" type="text" value="${esc(existing?existing.admissionNumber:'')}" placeholder="Admission number" ${edit?'readonly':''}></div>
        <div class="field"><label for="stuGradeForm">Grade</label><select id="stuGradeForm"><option value="">Choose</option>${GRADES.map(g=>`<option value="${g}" ${existing&&String(existing.grade)===String(g)?'selected':''}>Grade ${g}</option>`).join('')}</select></div>
        <div class="field"><label for="stuSectionForm">Section</label><select id="stuSectionForm"><option value="">Pick grade</option></select></div>
      </div>
      <p class="note">${edit?'The admission number stays locked because attendance and reading history are linked to it.':'Use a unique admission number. Attendance and reading history are linked to it.'}</p>
      <div class="form-actions"><button class="btn soft small" onclick="${back}">Cancel</button><button class="btn small" id="studentSaveBtn">${edit?'Save changes':'Add student'}</button></div>
    </div>`;
  const nameInput=document.getElementById('stuNameForm'),admInput=document.getElementById('stuAdmForm'),gradeSel=document.getElementById('stuGradeForm'),sectionSel=document.getElementById('stuSectionForm'),saveBtn=document.getElementById('studentSaveBtn');
  async function loadFormSections(selected){sectionSel.innerHTML='<option value="">Choose</option>';if(!gradeSel.value)return;await loadSectionsInto(sectionSel,gradeSel.value,selected)}
  gradeSel.addEventListener('change',()=>loadFormSections(''));await loadFormSections(existing?existing.section:'');
  saveBtn.addEventListener('click',async()=>{const studentName=nameInput.value.trim(),admission=admInput.value.trim(),grade=gradeSel.value,section=sectionSel.value.trim();if(!studentName||!admission||!grade||!section){toast('Please complete name, admission number, grade and section.');return}saveBtn.disabled=true;saveBtn.textContent=edit?'Saving…':'Adding…';try{if(edit){await apiPost('updateStudent',{admissionNumber:admission,studentName,grade,section});invalidateStudentCaches();toast('Student data updated.');setTimeout(()=>navigate('profile',{id:admission}),350)}else{await apiPost('addStudent',{admissionNumber:admission,studentName,grade,section});invalidateStudentCaches();toast('Student added.');setTimeout(()=>navigate('students'),350)}}catch(err){toast('Could not save: '+err.message)}finally{saveBtn.disabled=false;saveBtn.textContent=edit?'Save changes':'Add student'}});
}

/* ---------------- MOVE STUDENT ---------------- */
async function viewMoveStudent(content, admissionNumber) {
  const p=await apiGet('studentProfile',{admissionNumber}),s=p.student;
  const back=`navigate('profile',{id:'${esc(admissionNumber)}'})`;
  content.innerHTML=`
    <button class="link-back" onclick="${back}">← Back to profile</button>
    ${pageHead('Section change', 'Move student', 'Adm '+esc(s.admissionNumber))}
    ${heroTab('Current section', `
      <div class="hero-stack">
        <div class="hero-name">${esc(s.studentName)}</div>
        <div class="chips"><span class="chip">Grade ${esc(s.grade)}</span><span class="chip">Section ${esc(s.section)}</span></div>
      </div>`)}
    <div class="card stack">
      <div class="form-grid">
        <div class="field"><label for="moveSection">Existing section</label><select id="moveSection"><option value="">Choose</option></select></div>
        <div class="field"><label for="moveNewSection">Or a new section</label><input id="moveNewSection" type="text" placeholder="Example: B"></div>
      </div>
      <p class="note">The student keeps the same record. Attendance and reading history move with them.</p>
      <div class="form-actions"><button class="btn soft small" onclick="${back}">Cancel</button><button class="btn small" id="moveSave">Move to section</button></div>
    </div>`;
  const select=document.getElementById('moveSection'),newSection=document.getElementById('moveNewSection'),save=document.getElementById('moveSave');await loadSectionsInto(select,s.grade,'');
  save.addEventListener('click',async()=>{const target=newSection.value.trim()||select.value.trim();if(!target){toast('Select or enter the destination section.');return}if(target===String(s.section)){toast('Choose a different section.');return}save.disabled=true;save.textContent='Moving…';try{await apiPost('moveStudent',{admissionNumber:s.admissionNumber,grade:s.grade,section:target});invalidateStudentCaches();toast('Student moved to Section '+target+'.');setTimeout(()=>navigate('profile',{id:s.admissionNumber}),350)}catch(err){toast('Could not move student: '+err.message)}finally{save.disabled=false;save.textContent='Move to section'}});
}

/* ---------------- ATTENDANCE ---------------- */
async function viewAttendance(content){
  const params=state.params||{}, date=params.date||todayStr();
  content.innerHTML=`
    ${pageHead('Chapter IV', 'Attendance', '<span id="attDateLabel">'+esc(shortDate(date))+'</span>')}
    <div class="card">
      <div class="filter-grid four">
        <div class="field"><label for="attDate">Date</label><input id="attDate" type="date" value="${date}"></div>
        <div class="field"><label for="attGrade">Grade</label><select id="attGrade"><option value="">Select</option>${GRADES.map(g=>`<option value="${g}" ${g===params.grade?'selected':''}>Grade ${g}</option>`).join('')}</select></div>
        <div class="field"><label for="attSection">Section</label><select id="attSection"><option value="">Select</option></select></div>
        <button class="btn small" id="attLoad">Open register</button>
      </div>
    </div>
    <div id="attSummary"></div>
    <div class="ledger" id="attList"><div class="empty">Choose a date, grade and section.</div></div>
    <button class="btn block" id="attSave" hidden>Save attendance ${iconSvg('check')}</button>
    ${pageNum(4)}`;

  const gradeSel=document.getElementById('attGrade'),sectionSel=document.getElementById('attSection'),dateInput=document.getElementById('attDate'),list=document.getElementById('attList'),saveBtn=document.getElementById('attSave'),summary=document.getElementById('attSummary');let currentStudents=[];
  async function refreshSections(pre){sectionSel.innerHTML='<option value="">Select</option>';if(!gradeSel.value)return;const ss=await apiGet('sections',{grade:gradeSel.value});ss.forEach(s=>sectionSel.insertAdjacentHTML('beforeend',`<option value="${esc(s)}">Section ${esc(s)}</option>`));if(pre&&ss.includes(pre))sectionSel.value=pre}
  function renderSummary(){
    const present=currentStudents.filter(s=>s.status==='Present').length,absent=currentStudents.filter(s=>s.status==='Absent').length;
    summary.innerHTML=heroTab(`Grade ${esc(gradeSel.value)} · Section ${esc(sectionSel.value)}`,`
      <div class="hero-stack">
        <div class="big-num"><strong>${present}</strong><span>of ${currentStudents.length}</span></div>
        <div class="chips"><span class="chip present">${present} present</span><span class="chip absent">${absent} absent</span></div>
      </div>
      ${currentStudents.length?'<button class="btn soft tiny" id="attAllPresent">All present</button>':''}`);
    const all=document.getElementById('attAllPresent');
    if(all)all.addEventListener('click',()=>{currentStudents.forEach(s=>{s.status='Present'});renderList();renderSummary()});
  }
  function renderList(){list.innerHTML=currentStudents.length?currentStudents.map((s,i)=>`
    <div class="ledger-row">
      <span class="avatar ${tint(i)}">${esc(initials(s.studentName))}</span>
      <div class="row-main"><strong>${esc(s.studentName)}</strong><span>Adm ${esc(s.admissionNumber)}</span></div>
      <button class="mark present ${s.status==='Present'?'on':''}" aria-label="Present" aria-pressed="${s.status==='Present'}" onclick="setAttStatus(${i},'Present')">P</button>
      <button class="mark absent ${s.status==='Absent'?'on':''}" aria-label="Absent" aria-pressed="${s.status==='Absent'}" onclick="setAttStatus(${i},'Absent')">A</button>
    </div>`).join(''):'<div class="empty">No students found for this class.</div>'}
  async function loadClass(){
    document.getElementById('attDateLabel').textContent=shortDate(dateInput.value||todayStr());
    if(!gradeSel.value||!sectionSel.value){summary.innerHTML='';list.innerHTML='<div class="empty">Choose a date, grade and section.</div>';saveBtn.hidden=true;return}
    setLoading(list);
    currentStudents=await apiGet('attendanceForClass',{dateStr:dateInput.value,grade:gradeSel.value,section:sectionSel.value});
    renderSummary();renderList();saveBtn.hidden=!currentStudents.length;
  }
  window.setAttStatus=(i,status)=>{currentStudents[i].status=status;renderList();renderSummary()};
  saveBtn.addEventListener('click',async()=>{if(currentStudents.some(s=>!s.status)){toast('Please mark all students first.');return}saveBtn.disabled=true;saveBtn.textContent='Saving…';try{await apiPost('saveAttendance',{records:currentStudents.map(s=>({...s,date:dateInput.value,grade:gradeSel.value,section:sectionSel.value}))});toast('Attendance saved.');await loadClass()}catch(err){toast('Could not save: '+err.message)}finally{saveBtn.disabled=false;saveBtn.innerHTML='Save attendance '+iconSvg('check')}});
  document.getElementById('attLoad').addEventListener('click',loadClass);gradeSel.addEventListener('change',async()=>{await refreshSections();});if(params.grade){await refreshSections(params.section);await loadClass()}
}

/* ---------------- READING ASSESSMENT ---------------- */
const SCORE_SCALE = [['1','Rarely'],['2','Sometimes'],['3','Often'],['4','Consistent'],['5','Highly consistent']];
async function viewAssess(content) {
  content.innerHTML=`
    ${pageHead('Chapter V', 'Reading check', esc(shortDate(todayStr())))}
    <div class="card">
      <div class="form-grid">
        <div class="field"><label for="asDate">Date</label><input id="asDate" type="date" value="${todayStr()}"></div>
        <div class="field"><label for="asGrade">Grade</label><select id="asGrade"><option value="">Select</option>${GRADES.map(g=>`<option value="${g}">Grade ${g}</option>`).join('')}</select></div>
        <div class="field"><label for="asSection">Section</label><select id="asSection"><option value="">Select</option></select></div>
        <div class="field"><label for="asStudent">Student</label><select id="asStudent"><option value="">Choose grade & section</option></select></div>
      </div>
    </div>
    <div class="stack" id="asForm" hidden>
      <div id="asHero"></div>
      <div class="ledger">${RUBRIC_KEYS.map(k=>`<div class="rubric-row"><span>${RUBRIC_LABELS[k]}</span><div class="dots" id="asDots_${k}">${[1,2,3,4,5].map(n=>`<button data-k="${k}" data-n="${n}" aria-label="${RUBRIC_LABELS[k]} ${n}">${n}</button>`).join('')}</div></div>`).join('')}</div>
      <div class="scale">${SCORE_SCALE.map(([n,l])=>`<span class="chip dot s${n}">${n} · ${l}</span>`).join('')}</div>
      <div class="field"><label for="asObs">Note</label><textarea id="asObs" placeholder="A note on this reading…"></textarea></div>
      <button class="btn block" id="asSave">Save assessment ${iconSvg('check')}</button>
    </div>
    ${pageNum(5)}`;
  const gradeSel=document.getElementById('asGrade'),sectionSel=document.getElementById('asSection'),studentSel=document.getElementById('asStudent'),formEl=document.getElementById('asForm'),scores={};RUBRIC_KEYS.forEach(k=>scores[k]=3);
  function renderHero(){
    const opt=studentSel.selectedOptions[0];if(!opt||!studentSel.value)return;
    const avg=RUBRIC_KEYS.reduce((n,k)=>n+scores[k],0)/RUBRIC_KEYS.length;
    document.getElementById('asHero').innerHTML=heroTab(`Grade ${esc(gradeSel.value)} · ${esc(sectionSel.value)} · Adm ${esc(studentSel.value)}`,`
      <div class="hero-name">${esc(opt.dataset.name)}</div>
      <div class="hero-side"><strong>${avg.toFixed(1)}</strong><span>AVERAGE</span></div>`);
  }
  function paintDots(k){const box=document.getElementById(`asDots_${k}`);box.className='dots s'+scores[k];box.querySelectorAll('button').forEach(b=>b.classList.toggle('on',Number(b.dataset.n)<=scores[k]))}
  RUBRIC_KEYS.forEach(paintDots);document.querySelectorAll('.dots button').forEach(b=>b.addEventListener('click',()=>{scores[b.dataset.k]=Number(b.dataset.n);paintDots(b.dataset.k);renderHero()}));
  async function refreshSections(){sectionSel.innerHTML='<option value="">Select</option>';studentSel.innerHTML='<option value="">Choose grade & section</option>';formEl.hidden=true;if(!gradeSel.value)return;const sections=await apiGet('sections',{grade:gradeSel.value});sections.forEach(s=>sectionSel.insertAdjacentHTML('beforeend',`<option value="${esc(s)}">Section ${esc(s)}</option>`))}
  async function refreshStudents(){studentSel.innerHTML='<option value="">Select</option>';formEl.hidden=true;if(!gradeSel.value||!sectionSel.value)return;const students=await apiGet('students',{grade:gradeSel.value,section:sectionSel.value});students.forEach(s=>studentSel.insertAdjacentHTML('beforeend',`<option value="${esc(s.admissionNumber)}" data-name="${esc(s.studentName)}">${esc(s.studentName)}</option>`))}
  studentSel.addEventListener('change',()=>{formEl.hidden=!studentSel.value;renderHero()});gradeSel.addEventListener('change',refreshSections);sectionSel.addEventListener('change',refreshStudents);
  document.getElementById('asSave').addEventListener('click',async e=>{const btn=e.currentTarget;if(!studentSel.value){toast('Select a student first.');return}btn.disabled=true;btn.textContent='Saving…';try{const opt=studentSel.selectedOptions[0];await apiPost('saveReadingAssessment',{date:document.getElementById('asDate').value,admissionNumber:studentSel.value,studentName:opt.dataset.name,grade:gradeSel.value,section:sectionSel.value,observation:document.getElementById('asObs').value,...scores});toast('Assessment saved.');document.getElementById('asObs').value=''}catch(err){toast('Could not save: '+err.message)}finally{btn.disabled=false;btn.innerHTML='Save assessment '+iconSvg('check')}});
}

/* ---------------- REPORTS ---------------- */
async function viewReports(content){
  const month=todayStr().slice(0,7);
  content.innerHTML=`
    ${pageHead('Chapter VI', 'Reports', 'Monthly summary', `<div class="field month-field"><input id="repMonth" type="month" value="${month}" aria-label="Month"></div>`)}
    <div class="stat-grid">
      <div><span><i class="t3"></i>Students tracked</span><strong id="repStudents">—</strong></div>
      <div><span><i class="t4"></i>Attendance records</span><strong id="repAttendance">—</strong></div>
      <div><span><i class="t1"></i>Reading checks</span><strong id="repReading">—</strong></div>
      <div><span><i class="t2"></i>Average attendance</span><strong id="repAvg">—</strong></div>
    </div>
    ${heroTab('Attendance by student', '<div class="bars" id="repBars"></div>')}
    <div class="actions-row">
      <button class="btn soft" onclick="toast('PDF export can be connected next.')">${iconSvg('download')} PDF</button>
      <button class="btn soft" onclick="toast('Excel export can be connected next.')">${iconSvg('download')} Excel</button>
    </div>
    <div class="page-title-row"><div class="section-title">Student insights</div><span class="page-meta" id="repCount"></span></div>
    <div class="ledger" id="repList"><div class="loading"><div class="spinner"></div>Loading…</div></div>
    ${pageNum(6)}`;
  async function load(){
    const list=document.getElementById('repList');setLoading(list);
    const r=await apiGet('reports',{month:document.getElementById('repMonth').value});
    const rows=r.students.filter(s=>s.attendanceTotal||s.assessments);
    const avg=rows.length?Math.round(rows.reduce((n,s)=>n+Number(s.attendancePct||0),0)/rows.length):0;
    document.getElementById('repStudents').textContent=rows.length;
    document.getElementById('repAttendance').textContent=rows.reduce((n,s)=>n+Number(s.attendanceTotal||0),0);
    document.getElementById('repReading').textContent=rows.reduce((n,s)=>n+Number(s.assessments||0),0);
    document.getElementById('repAvg').textContent=avg+'%';
    document.getElementById('repCount').textContent=rows.length+(rows.length===1?' student':' students');
    document.getElementById('repBars').innerHTML=rows.slice(0,8).map(s=>{const pct=Math.min(100,Number(s.attendancePct||0));return `<div class="bar"><b>${pct}</b><i style="height:${Math.max(6,Math.round(pct*1.1))}px"></i><span>${esc(String(s.studentName||'').split(' ')[0])}</span></div>`}).join('')||'<div class="empty">No activity recorded this month.</div>';
    list.innerHTML=rows.length?rows.map((s,i)=>`
      <div class="ledger-row clickable" onclick="navigate('profile',{id:'${esc(s.admissionNumber)}'})">
        <span class="avatar ${tint(i)}">${esc(initials(s.studentName))}</span>
        <div class="row-main"><strong>${esc(s.studentName)}</strong><span>Grade ${esc(s.grade)} · ${esc(s.section)}</span></div>
        <div class="row-chips"><span class="chip ${Number(s.attendancePct)>=75?'present':'absent'}">${Number(s.attendancePct||0)}% present</span><span class="chip sand">${Number(s.readingScore||0)}% reading</span></div>
      </div>`).join(''):'<div class="empty">No activity recorded for this month yet.</div>';
  }
  document.getElementById('repMonth').addEventListener('change',load);load();
}

/* ---------------- cover ---------------- */
// The book cover greets the librarian once per browser session.
function showCover() {
  const cover = document.getElementById('cover');
  if (!cover) return;
  let seen = false;
  try { seen = sessionStorage.getItem('mmsCoverSeen') === '1'; } catch (err) {}
  if (seen) return;
  document.getElementById('coverDate').textContent = new Date().toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long' });
  cover.hidden = false;
  document.getElementById('openBook').addEventListener('click', () => {
    try { sessionStorage.setItem('mmsCoverSeen', '1'); } catch (err) {}
    cover.classList.add('leaving');
    setTimeout(() => { cover.hidden = true; cover.classList.remove('leaving'); }, 450);
  });
}

/* ---------------- boot ---------------- */
window.navigate = navigate;

function boot() {
  const parts = location.hash.replace('#/','').split('/');
  state.route = parts[0] || 'dashboard';
  state.params = parts[1] ? { id: decodeURIComponent(parts[1]) } : {};
  showCover();
  render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }
}
boot();
