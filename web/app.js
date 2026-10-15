'use strict';
const $ = (id) => document.getElementById(id);
const SESSION = 10;
const MODULE = 'ml';

const state = {
  token: localStorage.getItem('sb_token') || null,
  user: safeParse(localStorage.getItem('sb_user'), null),
  settings: migrateSettings(safeParse(localStorage.getItem('sb_settings'), {})),
  current: null,
  answered: false,
  lastAnswer: '',
  session: null,
};

function safeParse(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }
function migrateSettings(s) {
  return { byok: !!s.byok, key: s.key || '', model: s.model || 'claude-sonnet-4-6', theme: s.theme || 'dark', exam: s.exam || '' };
}
function saveSettingsObj() { localStorage.setItem('sb_settings', JSON.stringify(state.settings)); }

/* ---- tiny DOM builder ---- */
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const k in props) {
    const v = props[k];
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'style') n.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null && v !== false) n.setAttribute(k, v);
  }
  for (const c of kids) { if (c == null || c === false) continue; n.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return n;
}

/* ---- KaTeX ---- */
function renderMath(node) {
  if (!node || !window.renderMathInElement) return;
  try {
    window.renderMathInElement(node, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true },
      ],
      throwOnError: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'kbd'],
    });
  } catch { /* never let math break the UI */ }
}

/* ---- toasts ---- */
function toast(msg, kind = 'err') {
  const wrap = $('toasts');
  const t = el('div', { class: `toast ${kind}` }, el('span', { class: 'dot' }), el('span', { text: msg }));
  wrap.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s, transform .3s'; t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; setTimeout(() => t.remove(), 320); }, kind === 'ok' ? 2600 : 4400);
}

/* ---- api ---- */
async function api(path, opts = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const body = await res.json().catch(() => null);
  if (res.status === 401) { logout(); throw new Error('Session expired. Please sign in again.'); }
  if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  return body;
}

/* ---- shared state fragments ---- */
function skeletonList(rows = 4) {
  return `<div class="card skeleton-card">${'<div class="sk sk-line"></div>'.repeat(rows)}</div>`;
}
function emptyState(title, sub) {
  return `<div class="card empty-state"><div class="empty-glyph">✦</div><h2 class="card-title">${esc(title)}</h2><p class="muted">${esc(sub)}</p></div>`;
}
function errorState(msg) {
  return `<div class="card empty-state"><div class="empty-glyph" style="color:var(--clay)">⚠</div><h2 class="card-title">Couldn't load</h2><p class="muted">${esc(msg)}</p></div>`;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ============================ AUTH ============================ */
async function signup() {
  $('auth-error').textContent = '';
  try {
    const r = await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value, display_name: $('display_name').value.trim() || 'Student' }) });
    setSession(r.token, r.user);
  } catch (e) { $('auth-error').textContent = e.message; }
}
async function login() {
  $('auth-error').textContent = '';
  try {
    const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }) });
    setSession(r.token, r.user);
  } catch (e) { $('auth-error').textContent = e.message; }
}
async function guest() {
  $('auth-error').textContent = '';
  $('guest').disabled = true;
  try {
    const r = await api('/api/auth/guest', { method: 'POST', body: '{}' });
    setSession(r.token, r.user);
  } catch (e) { $('auth-error').textContent = e.message; }
  finally { $('guest').disabled = false; }
}
async function loadDemoInfo() {
  try {
    const d = await fetch('/api/demo').then((r) => r.json());
    if (d.guests) { $('guest').hidden = false; $('guest-sub').hidden = false; $('or-line').hidden = false; $('login').className = 'btn ghost'; }
    else $('login').className = 'btn primary';
    if (d.account) {
      $('demo-email').textContent = d.account.email;
      $('demo-pass').textContent = d.account.password;
      $('demo-creds').hidden = false;
      $('demo-fill').onclick = () => { $('email').value = d.account.email; $('password').value = d.account.password; $('login').focus(); };
    }
    $('demo-box').hidden = !d.guests;
  } catch { /* demo info is optional */ }
}
function setSession(token, user) {
  state.token = token; state.user = user; state.session = null; state.current = null;
  localStorage.setItem('sb_token', token); localStorage.setItem('sb_user', JSON.stringify(user));
  render();
}
function logout() {
  state.token = null; state.user = null; state.session = null; state.current = null;
  localStorage.removeItem('sb_token'); localStorage.removeItem('sb_user');
  render();
}

/* ============================ NAV ============================ */
const SCREENS = ['auth', 'dashboard', 'quiz', 'progress', 'leaderboard', 'settings'];
function showScreen(name) {
  SCREENS.forEach((s) => { const node = $(`screen-${s}`); if (node) node.hidden = s !== name; });
  document.querySelectorAll('#nav .nav-link').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  try {
    if (name === 'dashboard') loadDashboard();
    else if (name === 'quiz') enterQuiz();
    else if (name === 'progress') loadProgress();
    else if (name === 'leaderboard') loadLeaderboard();
    else if (name === 'settings') loadSettings();
  } catch (e) { toast(e.message); }
}

/* ============================ DASHBOARD ============================ */
function setGreeting() {
  const h = new Date().getHours();
  // Greeting and section title come from the same local hour so they never disagree.
  const [g, t] = h >= 23 || h < 5 ? ['Burning the midnight oil', "Tonight's revision"]
    : h < 12 ? ['Good morning', "This morning's revision"]
    : h < 18 ? ['Good afternoon', "This afternoon's revision"]
    : ['Good evening', "Tonight's revision"];
  $('greeting').textContent = g;
  $('screen-title').textContent = t;
}
function isGuest() { return !!(state.user && /@guest\.studybuddy\.invalid$/.test(state.user.email || '')); }
function daysUntilExam() {
  if (!state.settings.exam) return null;
  const d = new Date(state.settings.exam + 'T00:00:00');
  if (isNaN(d)) return null;
  return Math.ceil((d - new Date()) / 86400000);
}
async function loadDashboard() {
  setGreeting();
  const body = $('dash-body');
  body.innerHTML = skeletonList(3);
  try {
    const d = await api('/api/stats');
    const concepts = d.concepts || [];
    const tested = concepts.filter((c) => c.score != null);
    const avg = tested.length ? Math.round((tested.reduce((a, c) => a + c.score, 0) / tested.length) * 100) : 0;
    const weakest = [...concepts].sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0];
    const days = daysUntilExam();
    body.innerHTML = '';
    body.appendChild(buildDashboard({ days, avg, tested: tested.length, weakest, totals: d.totals || { answered: 0, correct: 0 } }));
  } catch (e) { body.innerHTML = errorState(e.message); }
}
function buildDashboard({ days, avg, tested, weakest, totals }) {
  const grid = el('div', { class: 'dash-grid' });

  // hero
  const countdown = days == null
    ? el('div', {}, el('button', { class: 'btn ghost', onClick: () => showScreen('settings') }, 'Set your exam date →'))
    : el('div', {}, el('div', { class: 'countdown-num display', text: days <= 0 ? '0' : String(days) }),
        el('div', { class: 'countdown-label', text: days <= 0 ? 'exam is today, good luck' : days === 1 ? 'day until the exam' : 'days until the exam' }));
  const ring = el('div', { class: 'ring', style: `--p:${avg}` }, el('b', { text: tested ? `${avg}%` : '–' }), el('span', { text: 'confidence' }));
  grid.appendChild(el('div', { class: 'card dash-hero' }, countdown, ring));

  // revise next
  const next = el('div', { class: 'card revise-next' },
    el('p', { class: 'eyebrow', text: 'Revise next' }),
    el('p', { class: 'nxt-name', text: weakest ? weakest.name : 'Your first set' }),
    el('button', { class: 'btn primary', onClick: () => showScreen('quiz') }, weakest ? 'Begin revision' : 'Start revising'));
  grid.appendChild(next);

  // module confidence
  const mod = el('div', { class: 'card' },
    el('p', { class: 'eyebrow', text: 'Machine Learning' }),
    el('div', { class: 'bar', style: 'margin:12px 0 14px' }, el('span', { style: `width:${avg}%` })),
    el('div', { class: 'stat-row' },
      el('div', { class: 'stat' }, el('div', { class: 'n', text: String(totals.answered || 0) }), el('div', { class: 'l', text: 'answered' })),
      el('div', { class: 'stat' }, el('div', { class: 'n', text: String(totals.correct || 0) }), el('div', { class: 'l', text: 'correct' })),
      el('div', { class: 'stat' }, el('div', { class: 'n', text: String(tested) }), el('div', { class: 'l', text: 'concepts' }))));
  grid.appendChild(mod);

  if (isGuest()) grid.appendChild(el('p', { class: 'demo-sample', text: 'Demo account: some topics are pre-filled with sample progress so you can see the Atlas and Ranks. Your own answers add to it.' }));
  return grid;
}

/* ============================ QUIZ ============================ */
function quizShow(view) {
  $('enroll-card').hidden = view !== 'enroll';
  $('quiz-skeleton').hidden = view !== 'skeleton';
  $('quiz-empty').hidden = view !== 'empty';
  $('session-summary').hidden = view !== 'summary';
  $('quiz-card').hidden = view !== 'card';
}
async function ensureEnrolled() {
  const { enrollments } = await api('/api/enrollments');
  return (enrollments || []).some((e) => e.slug === MODULE);
}
async function enterQuiz() {
  if (state.session && (state.current || state.session.done)) return; // keep current state
  quizShow('skeleton');
  try {
    if (!(await ensureEnrolled())) { quizShow('enroll'); return; }
    startSession();
  } catch (e) { toast(e.message); quizShow('enroll'); }
}
function startSession() {
  state.session = { idx: 0, correct: 0, streak: 0, best: 0, done: false };
  loadQuestion();
}
async function loadQuestion() {
  quizShow('skeleton');
  try {
    const { questions } = await api('/api/quiz/next?limit=1');
    if (!questions || !questions.length) { quizShow('empty'); return; }
    state.current = questions[0];
    state.answered = false;
    renderQuestion(state.current);
  } catch (e) { toast(e.message); quizShow('empty'); $('quiz-empty').querySelector('.muted').textContent = e.message; }
}
function renderQuestion(item) {
  const q = item.question;
  // meta
  $('q-concept').textContent = item.concept.name + (item.concept.week ? ` · Week ${item.concept.week}` : '');
  $('q-reason').textContent = item.reason || 'practice';
  const diff = $('q-difficulty'); diff.innerHTML = '';
  const dn = Math.max(1, Math.min(5, item.concept.difficulty || 3));
  for (let i = 0; i < 5; i++) diff.appendChild(el('i', { class: i < dn ? 'on' : '' }));

  // question
  $('q-text').textContent = q.question;
  renderMath($('q-text'));

  // form
  const form = $('q-form'); form.innerHTML = '';
  if (q.type === 'mcq') {
    q.options.forEach((opt, i) => {
      const lab = el('label', { class: 'opt', 'data-i': i },
        el('input', { type: 'radio', name: 'opt', value: i }),
        el('span', { class: 'key', text: String(i + 1) }),
        el('span', { class: 'txt', text: opt }));
      form.appendChild(lab);
    });
    renderMath(form);
    $('kbd-hint').innerHTML = '<kbd>1</kbd>–<kbd>' + q.options.length + '</kbd> select · <kbd>Enter</kbd> submit';
  } else {
    form.appendChild(el('textarea', { id: 'ff', placeholder: 'Write your answer…', 'aria-label': 'Your answer' }));
    $('kbd-hint').innerHTML = '<kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> submit';
  }

  // reset result + why defensively
  $('result').hidden = true;
  $('why-box').hidden = true;
  $('why').hidden = true; $('why').disabled = false;
  $('why-status').hidden = true;
  $('reveal').open = false;
  $('submit').disabled = false; $('skip').disabled = false;

  // session tracker
  renderTracker();
  quizShow('card');
}
function renderTracker() {
  const ticks = $('set-ticks'); ticks.innerHTML = '';
  for (let i = 0; i < SESSION; i++) {
    const cls = i < state.session.idx ? 'done' : i === state.session.idx ? 'cur' : '';
    ticks.appendChild(el('i', { class: cls }));
  }
  $('progress-label').textContent = `Question ${Math.min(state.session.idx + 1, SESSION)} of ${SESSION}`;
  $('streak').textContent = state.session.streak > 1 ? `🔥 ${state.session.streak} streak` : '';
}
function selectOption(i) {
  const opts = [...document.querySelectorAll('#q-form .opt')];
  if (state.answered || !opts[i]) return;
  opts.forEach((o) => o.classList.remove('selected'));
  const target = opts[i];
  target.classList.add('selected');
  const input = target.querySelector('input'); if (input) input.checked = true;
  target.focus();
}
function readAnswer() {
  const q = state.current.question;
  if (q.type === 'mcq') {
    const sel = document.querySelector('#q-form input[name=opt]:checked');
    return sel ? q.options[Number(sel.value)] : null;
  }
  const ff = $('ff'); return ff ? ff.value.trim() : '';
}
async function submitAnswer() {
  if (!state.current || state.answered) return;
  const answer = readAnswer();
  if (answer == null || answer === '') { toast('Choose or type an answer first.'); return; }
  const btn = $('submit'); btn.disabled = true; $('skip').disabled = true;
  try {
    const r = await api('/api/quiz/answer', { method: 'POST', body: JSON.stringify({ question_id: state.current.question.id, answer }) });
    state.lastAnswer = answer; state.answered = true;
    applyGrade(r);
  } catch (e) {
    toast(e.message); btn.disabled = false; $('skip').disabled = false;
  }
}
function applyGrade(r) {
  const q = state.current.question;
  // option states
  if (q.type === 'mcq') {
    document.querySelectorAll('#q-form .opt').forEach((o) => {
      o.classList.add('locked'); o.classList.remove('selected');
      const txt = o.querySelector('.txt').textContent;
      if (txt === r.correct_answer) o.classList.add('correct');
      else if (txt === state.lastAnswer && !r.is_correct) { o.classList.add('incorrect'); o.classList.add('shake'); }
    });
  } else {
    const ff = $('ff'); if (ff) ff.disabled = true;
  }
  // verdict
  const v = $('verdict');
  v.textContent = r.is_correct ? 'Correct' : 'Not quite';
  v.className = 'verdict pop ' + (r.is_correct ? 'ok' : 'bad');
  $('feedback').textContent = r.feedback || '';
  $('correct-answer').textContent = r.correct_answer || '';
  $('explanation').textContent = r.explanation || '';
  renderMath($('correct-answer')); renderMath($('explanation'));
  $('why').hidden = !!r.is_correct; // why only offered when wrong (and server-gated)
  $('reveal').open = false;

  // session
  state.session.correct += r.is_correct ? 1 : 0;
  state.session.streak = r.is_correct ? state.session.streak + 1 : 0;
  state.session.best = Math.max(state.session.best, state.session.streak);
  $('streak').textContent = state.session.streak > 1 ? `🔥 ${state.session.streak} streak` : '';
  const tick = $('set-ticks').children[state.session.idx]; if (tick) { tick.className = 'done'; }

  $('result').hidden = false;
  $('next').focus({ preventScroll: true });
  if (!r.is_correct) {
    // open the grounded explanation straight away, whatever the question type, and bring it on screen
    explainWhy();
    try { $('why-box').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch { /* old browsers */ }
  }
}
function nextQuestion() {
  if (!state.session) { startSession(); return; }
  state.session.idx++;
  if (state.session.idx >= SESSION) { showSummary(); return; }
  state.current = null;
  loadQuestion();
}
function showSummary() {
  state.session.done = true; state.current = null;
  $('sum-score').textContent = `${state.session.correct}/${SESSION}`;
  const pct = Math.round((state.session.correct / SESSION) * 100);
  $('sum-detail').textContent = `${pct}% this set · best streak ${state.session.best}`;
  quizShow('summary');
}

/* ---- why : grounded explanation ---- */
async function explainWhy() {
  const btn = $('why');
  btn.disabled = true;
  $('why-box').hidden = false;
  $('why-status').hidden = true; $('why-status').textContent = '';
  $('why-citations').innerHTML = '<span class="muted small">Retrieving grounded sources…</span>';
  $('why-prose').textContent = '';
  const qid = state.current.question.id;
  try {
    if (state.settings.byok && state.settings.key) {
      const ctx = await api(`/api/quiz/why/context?question_id=${qid}`);
      renderCitations(ctx.citations, ctx.retrieval);
      await streamByok(ctx);
    } else {
      await streamServerWhy(qid);
    }
    renderMath($('why-prose'));
  } catch (e) {
    whyError(e.message || 'Could not load the explanation.');
  } finally {
    btn.disabled = false; // BUG FIX #1: always re-enable, even on failure
  }
}
function whyError(msg) {
  if (!$('why-citations').querySelector('.cite')) $('why-citations').innerHTML = '';
  const s = $('why-status'); s.hidden = false; s.textContent = msg;
  toast(msg);
}
function renderCitations(citations, retrieval) {
  const wrap = $('why-citations'); wrap.innerHTML = '';
  (citations || []).forEach((c, i) => {
    if (i === 1) {
      wrap.appendChild(el('p', { class: 'related-head', text: 'Related passages' }));
      if (retrieval === 'lexical') wrap.appendChild(el('p', { class: 'related-note', text: 'This demo finds related passages with offline keyword (BM25) matching. The full app uses OpenAI embeddings.' }));
    }
    const loc = c.locator && c.locator.kind === 'slides'
      ? `slides p.${c.locator.start_page}–${c.locator.end_page}`
      : (c.locator ? `chars ${c.locator.char_start}–${c.locator.char_end}${c.locator.heading ? ' · ' + c.locator.heading : ''}` : '');
    wrap.appendChild(el('div', { class: 'cite' },
      el('div', { class: 'lbl', text: c.source_label || '' }),
      loc ? el('div', { class: 'loc', text: loc }) : null,
      el('blockquote', { text: `“${c.quote}”` })));
  });
  renderMath(wrap);
}
async function streamServerWhy(qid) {
  const res = await fetch(`/api/quiz/why?question_id=${qid}&answer=${encodeURIComponent(state.lastAnswer || '')}`, { headers: { authorization: `Bearer ${state.token}` } });
  if (res.status === 401) { logout(); throw new Error('Session expired.'); }
  if (!res.ok) { // BUG FIX #2: guard non-2xx (429/403/400/500) JSON bodies
    const j = await res.json().catch(() => null);
    throw new Error((j && j.error) || `Explanation failed (${res.status})`);
  }
  let streamErr = null;
  await parseSse(res.body, (ev, data) => {
    if (ev === 'citation') { try { { const j = JSON.parse(data); renderCitations(j.citations, j.retrieval); }; } catch {} }
    else if (ev === 'token') { try { $('why-prose').textContent += JSON.parse(data).text; } catch {} }
    else if (ev === 'error') { try { streamErr = JSON.parse(data).error; } catch { streamErr = 'stream error'; } } // BUG FIX #2: in-stream error event
  });
  if (streamErr) throw new Error(streamErr);
  if (!$('why-prose').textContent.trim() && !$('why-citations').querySelector('.cite')) throw new Error('No explanation was returned.');
}
async function streamByok(ctx) {
  const passages = (ctx.citations || []).map((c, i) => `[${i + 1}] ${c.source_label}: "${c.quote}"`).join('\n');
  const content = `Question: ${ctx.question}\nCorrect answer: ${ctx.correct_answer}\nSource passages to cite:\n${passages}\n\nExplain why the correct answer is right, citing the source label(s).`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': state.settings.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: state.settings.model || 'claude-sonnet-4-6', max_tokens: 600, stream: true, system: 'Explain using ONLY the provided passages; cite their labels. No invented facts or links.', messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) throw new Error(`BYOK error ${res.status}. Check your key in Settings.`);
  await parseSse(res.body, (ev, data) => {
    try { const j = JSON.parse(data); if (j.type === 'content_block_delta' && j.delta && j.delta.text) $('why-prose').textContent += j.delta.text; } catch {}
  });
  if (!$('why-prose').textContent.trim()) throw new Error('No explanation was returned by your key.');
}
async function parseSse(body, onEvent) {
  if (!body) return;
  const reader = body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const events = buf.split('\n\n'); buf = events.pop();
    for (const e of events) {
      const ev = (e.match(/event: (.*)/) || [])[1] || 'message';
      const data = (e.match(/data: (.*)/s) || [])[1] || '';
      onEvent(ev, data);
    }
  }
}

/* ============================ PROGRESS ============================ */
async function loadProgress() {
  const body = $('progress-body'); body.innerHTML = skeletonList(5);
  $('progress-totals').textContent = '';
  try {
    const d = await api('/api/stats');
    const concepts = d.concepts || [];
    $('progress-totals').textContent = d.totals && d.totals.answered
      ? `${d.totals.correct} of ${d.totals.answered} correct · ${concepts.length} concept${concepts.length === 1 ? '' : 's'} tracked`
      : '';
    if (isGuest() && concepts.length) $('progress-totals').textContent += ' · includes demo sample progress';
    if (!concepts.length) { body.innerHTML = emptyState('Nothing tracked yet', 'Take a quiz to start mapping your confidence across the module.'); return; }
    body.innerHTML = '';
    const atlas = el('div', { class: 'atlas' });
    concepts.forEach((c) => atlas.appendChild(atlasRow(c)));
    body.appendChild(atlas);
    renderMath(atlas);
  } catch (e) { body.innerHTML = errorState(e.message); }
}
function atlasRow(c) {
  const pct = Math.round((c.score || 0) * 100);
  const days = c.last_tested ? Math.floor((Date.now() - new Date(c.last_tested)) / 86400000) : null;
  const stale = days != null && days >= 10;
  return el('details', { class: 'atlas-row' },
    el('summary', {},
      el('div', { class: 'atlas-meta' }, el('span', { class: 'atlas-name', text: c.name }), c.week ? el('span', { class: 'atlas-week', text: `W${c.week}` }) : null),
      el('div', { class: 'conf' }, el('div', { class: 'bar' }, el('span', { style: `width:${pct}%` })), el('span', { class: 'pct', text: `${pct}%` }))),
    el('div', { class: 'atlas-detail' },
      el('dl', {},
        el('dt', { text: 'Confidence' }), el('dd', { text: `${pct}%${stale ? '' : ''}` }),
        el('dt', { text: 'Last tested' }), el('dd', { class: stale ? 'stale' : '', text: c.last_tested ? `${new Date(c.last_tested).toLocaleDateString()}${days != null ? ` · ${days} day${days === 1 ? '' : 's'} ago` : ''}` : 'never' }),
        el('dt', { text: 'Decay' }), el('dd', { text: stale ? 'Fading: confidence decays toward 0 with a ~14-day half-life. Revisit to refresh it.' : 'Fresh: within the 14-day half-life window.' }))));
}

/* ============================ LEADERBOARD ============================ */
async function loadLeaderboard() {
  const body = $('leaderboard-body'); body.innerHTML = skeletonList(5);
  try {
    const d = await api('/api/leaderboard');
    if (!d.leaderboard || !d.leaderboard.length) { body.innerHTML = emptyState('No graded attempts yet', 'Be the first to put a score on the board.'); return; }
    body.innerHTML = '';
    const lb = el('div', { class: 'lb' });
    d.leaderboard.forEach((r, i) => {
      const me = r.user_id === d.me;
      lb.appendChild(el('div', { class: 'lb-row' + (me ? ' me' : '') },
        el('div', { class: 'lb-rank', text: String(i + 1) }),
        el('div', { class: 'lb-name' }, r.display_name, me ? el('span', { class: 'lb-you', text: 'you' }) : null),
        el('div', { class: 'lb-nums' },
          el('span', {}, el('b', { text: String(r.correct) }), ' correct'),
          el('span', {}, el('b', { text: String(r.answered) }), ' answered'),
          el('span', { text: `${r.accuracy ?? 0}%` }))));
    });
    body.appendChild(lb);
  } catch (e) { body.innerHTML = errorState(e.message); }
}

/* ============================ SETTINGS ============================ */
function loadSettings() {
  $('byok-enabled').checked = !!state.settings.byok;
  $('byok-key').value = state.settings.key || '';
  $('byok-model').value = state.settings.model || 'claude-sonnet-4-6';
  $('exam-date').value = state.settings.exam || '';
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.classList.toggle('active', b.dataset.themeSet === state.settings.theme));
}
function saveSettings() {
  state.settings.byok = $('byok-enabled').checked;
  state.settings.key = $('byok-key').value.trim();
  state.settings.model = $('byok-model').value.trim() || 'claude-sonnet-4-6';
  state.settings.exam = $('exam-date').value || '';
  saveSettingsObj();
  $('settings-saved').textContent = 'Saved. Your key stays in this browser only.';
  toast('Preferences saved', 'ok');
}

/* ============================ THEME ============================ */
const mq = window.matchMedia('(prefers-color-scheme: light)');
function resolveTheme(pref) { return pref === 'auto' ? (mq.matches ? 'light' : 'dark') : pref; }
function applyTheme() {
  document.documentElement.dataset.theme = resolveTheme(state.settings.theme || 'dark');
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.classList.toggle('active', b.dataset.themeSet === state.settings.theme));
}
mq.addEventListener('change', () => { if (state.settings.theme === 'auto') applyTheme(); });

/* ============================ RENDER / WIRE ============================ */
function render() {
  document.documentElement.classList.remove('has-token'); // JS now owns which screen shows
  const authed = !!state.token;
  $('topbar').hidden = !authed;
  applyTheme();
  if (authed) {
    $('who').textContent = state.user ? state.user.display_name : '';
    showScreen('dashboard');
  } else {
    showScreen('auth');
  }
}

function wire() {
  // auth
  $('auth-form').addEventListener('submit', (e) => { e.preventDefault(); login(); });
  $('signup').onclick = signup;
  $('guest').onclick = guest;
  $('logout').onclick = logout;
  // nav
  document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); showScreen(b.dataset.nav); }));
  // theme
  $('theme-toggle').onclick = () => { const cur = resolveTheme(state.settings.theme); state.settings.theme = cur === 'dark' ? 'light' : 'dark'; saveSettingsObj(); applyTheme(); };
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.addEventListener('click', () => { state.settings.theme = b.dataset.themeSet; saveSettingsObj(); applyTheme(); }));
  // quiz
  $('enroll').onclick = async () => { try { $('enroll').disabled = true; await api('/api/enroll', { method: 'POST', body: '{}' }); startSession(); } catch (e) { toast(e.message); } finally { $('enroll').disabled = false; } };
  $('submit').onclick = submitAnswer;
  $('skip').onclick = () => { if (state.session) loadQuestion(); };
  $('next').onclick = nextQuestion;
  $('why').onclick = explainWhy;
  $('new-set').onclick = startSession;
  $('q-form').addEventListener('change', (e) => { if (e.target.name === 'opt') selectOption(Number(e.target.value)); });
  // settings
  $('save-settings').onclick = saveSettings;
  $('exam-date').addEventListener('change', () => { state.settings.exam = $('exam-date').value; saveSettingsObj(); });
  // keyboard quiz
  document.addEventListener('keydown', onQuizKey);
  // global backstop
  window.addEventListener('unhandledrejection', (e) => { console.warn('unhandledrejection:', e.reason); toast((e.reason && e.reason.message) || 'Something went wrong.'); });
}

function onQuizKey(e) {
  if ($('screen-quiz').hidden || $('quiz-card').hidden) return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  const typing = tag === 'TEXTAREA' || tag === 'INPUT';
  const q = state.current && state.current.question;

  if (!state.answered && q && q.type === 'mcq' && !typing) {
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= q.options.length) { e.preventDefault(); selectOption(n - 1); return; }
  }
  if (e.key === 'Enter') {
    if (state.answered) { if (!$('result').hidden) { e.preventDefault(); nextQuestion(); } return; }
    if (q && q.type === 'free_form') { if (e.metaKey || e.ctrlKey) { e.preventDefault(); submitAnswer(); } return; }
    e.preventDefault(); submitAnswer();
  }
}

wire();
render();
loadDemoInfo();
