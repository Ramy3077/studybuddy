'use strict';
const $ = (id) => document.getElementById(id);
const state = {
  token: localStorage.getItem('sb_token') || null,
  user: JSON.parse(localStorage.getItem('sb_user') || 'null'),
  current: null, // current question
  settings: JSON.parse(localStorage.getItem('sb_settings') || '{"byok":false,"key":"","model":"claude-sonnet-4-6"}'),
};

async function api(path, opts = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const body = await res.json().catch(() => null);
  if (res.status === 401) { logout(); throw new Error('session expired'); }
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

// ---- auth -----------------------------------------------------------------
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
function setSession(token, user) {
  state.token = token; state.user = user;
  localStorage.setItem('sb_token', token); localStorage.setItem('sb_user', JSON.stringify(user));
  render();
}
function logout() {
  state.token = null; state.user = null;
  localStorage.removeItem('sb_token'); localStorage.removeItem('sb_user');
  render();
}

// ---- tabs -----------------------------------------------------------------
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== name));
  if (name === 'quiz') loadNext();
  if (name === 'progress') loadProgress();
  if (name === 'leaderboard') loadLeaderboard();
}

// ---- quiz -----------------------------------------------------------------
async function ensureEnrolled() {
  const { enrollments } = await api('/api/enrollments');
  return enrollments.some((e) => e.slug === 'ml');
}
async function loadNext() {
  $('quiz-card').hidden = true; $('quiz-empty').hidden = true; $('enroll-card').hidden = true;
  if (!(await ensureEnrolled())) { $('enroll-card').hidden = false; return; }
  const { questions } = await api('/api/quiz/next?limit=1');
  if (!questions.length) { $('quiz-empty').hidden = false; return; }
  state.current = questions[0];
  renderQuestion(state.current);
}
function renderQuestion(item) {
  const q = item.question;
  $('q-concept').textContent = item.concept.name + (item.concept.week ? ` · Week ${item.concept.week}` : '');
  $('q-reason').textContent = item.reason;
  $('q-text').textContent = q.question;
  const form = $('q-form'); form.innerHTML = '';
  if (q.type === 'mcq') {
    q.options.forEach((opt, i) => {
      const lab = document.createElement('label'); lab.className = 'opt';
      lab.innerHTML = `<input type="radio" name="opt" value="${i}"> ${escapeHtml(opt)}`;
      form.appendChild(lab);
    });
  } else {
    const ta = document.createElement('textarea'); ta.id = 'ff'; ta.placeholder = 'Type your answer...';
    form.appendChild(ta);
  }
  $('result').hidden = true; $('why-box').hidden = true; $('why').hidden = true;
  $('submit').disabled = false; $('quiz-card').hidden = false;
}
function readAnswer() {
  const q = state.current.question;
  if (q.type === 'mcq') {
    const sel = document.querySelector('input[name=opt]:checked');
    return sel ? q.options[Number(sel.value)] : null;
  }
  return $('ff').value.trim();
}
async function submitAnswer() {
  const answer = readAnswer();
  if (answer == null || answer === '') { alert('Choose or type an answer first.'); return; }
  $('submit').disabled = true;
  const r = await api('/api/quiz/answer', { method: 'POST', body: JSON.stringify({ question_id: state.current.question.id, answer }) });
  state.lastAnswer = answer;
  const v = $('verdict'); v.textContent = r.is_correct ? '✓ Correct' : '✗ Incorrect'; v.className = r.is_correct ? 'ok' : 'bad';
  $('feedback').textContent = r.feedback || '';
  $('correct-answer').textContent = r.correct_answer;
  $('explanation').textContent = r.explanation || '';
  $('why').hidden = r.is_correct; // offer "why" when wrong
  $('result').hidden = false;
}

// ---- why (grounded explanation) ------------------------------------------
async function explainWhy() {
  $('why').disabled = true; $('why-box').hidden = false;
  $('why-citations').innerHTML = '<span class="muted">Retrieving grounded sources…</span>';
  $('why-prose').textContent = '';
  const qid = state.current.question.id;
  if (state.settings.byok && state.settings.key) {
    // BYOK: fetch grounded citations from our server, generate prose in-browser.
    const ctx = await api(`/api/quiz/why/context?question_id=${qid}`);
    renderCitations(ctx.citations);
    await streamByok(ctx);
  } else {
    await streamServerWhy(qid);
  }
  $('why').disabled = false;
}
function renderCitations(citations) {
  $('why-citations').innerHTML = '';
  citations.forEach((c) => {
    const loc = c.locator && c.locator.kind === 'slides'
      ? `slides p.${c.locator.start_page}–${c.locator.end_page}`
      : (c.locator ? `chars ${c.locator.char_start}–${c.locator.char_end}${c.locator.heading ? ` · ${c.locator.heading}` : ''}` : '');
    const div = document.createElement('div'); div.className = 'cite';
    div.innerHTML = `<div class="lbl">${escapeHtml(c.source_label)}</div><div class="loc">${escapeHtml(loc)}</div><blockquote>“${escapeHtml(c.quote)}”</blockquote>`;
    $('why-citations').appendChild(div);
  });
}
async function streamServerWhy(qid) {
  const res = await fetch(`/api/quiz/why?question_id=${qid}&answer=${encodeURIComponent(state.lastAnswer || '')}`, { headers: { authorization: `Bearer ${state.token}` } });
  await parseSse(res.body, (ev, data) => {
    if (ev === 'citation') renderCitations(JSON.parse(data).citations);
    else if (ev === 'token') $('why-prose').textContent += JSON.parse(data).text;
  });
}
async function streamByok(ctx) {
  const passages = ctx.citations.map((c, i) => `[${i + 1}] ${c.source_label}: "${c.quote}"`).join('\n');
  const content = `Question: ${ctx.question}\nCorrect answer: ${ctx.correct_answer}\nSource passages to cite:\n${passages}\n\nExplain why the correct answer is right, citing the source label(s).`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': state.settings.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: state.settings.model || 'claude-sonnet-4-6', max_tokens: 600, stream: true, system: 'Explain using ONLY the provided passages; cite their labels. No invented facts or links.', messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) { $('why-prose').textContent = `(BYOK error: ${res.status}. Check your key in Settings.)`; return; }
  await parseSse(res.body, (ev, data) => {
    try { const j = JSON.parse(data); if (j.type === 'content_block_delta' && j.delta && j.delta.text) $('why-prose').textContent += j.delta.text; } catch {}
  });
}
async function parseSse(body, onEvent) {
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

// ---- progress / leaderboard ----------------------------------------------
async function loadProgress() {
  const d = await api('/api/stats');
  $('progress-totals').textContent = d.totals ? `${d.totals.correct}/${d.totals.answered} correct overall.` : 'No attempts yet.';
  const tb = $('progress-table').querySelector('tbody'); tb.innerHTML = '';
  (d.concepts || []).forEach((c) => {
    const pct = Math.round((c.score || 0) * 100);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(c.name)}</td><td>${c.week ?? ''}</td><td><div class="bar"><span style="width:${pct}%"></span></div>${pct}%</td><td>${c.last_tested ? new Date(c.last_tested).toLocaleDateString() : '—'}</td>`;
    tb.appendChild(tr);
  });
}
async function loadLeaderboard() {
  const d = await api('/api/leaderboard');
  const tb = $('lb-table').querySelector('tbody'); tb.innerHTML = '';
  d.leaderboard.forEach((r, i) => {
    const tr = document.createElement('tr'); if (r.user_id === d.me) tr.className = 'me';
    tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(r.display_name)}</td><td>${r.correct}</td><td>${r.answered}</td><td>${r.accuracy ?? 0}%</td>`;
    tb.appendChild(tr);
  });
  if (!d.leaderboard.length) tb.innerHTML = '<tr><td colspan="5" class="muted">No graded attempts yet.</td></tr>';
}

// ---- settings -------------------------------------------------------------
function loadSettings() {
  $('byok-enabled').checked = !!state.settings.byok;
  $('byok-key').value = state.settings.key || '';
  $('byok-model').value = state.settings.model || 'claude-sonnet-4-6';
}
function saveSettings() {
  state.settings = { byok: $('byok-enabled').checked, key: $('byok-key').value.trim(), model: $('byok-model').value.trim() };
  localStorage.setItem('sb_settings', JSON.stringify(state.settings));
  $('settings-saved').textContent = 'Saved. Your key stays in this browser only.';
}

// ---- render ---------------------------------------------------------------
function render() {
  const authed = !!state.token;
  $('auth').hidden = authed;
  $('userbar').hidden = !authed;
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = true));
  if (authed) { $('who').textContent = state.user ? state.user.display_name : ''; loadSettings(); showTab('quiz'); }
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---- wire up --------------------------------------------------------------
$('signup').onclick = signup;
$('login').onclick = login;
$('logout').onclick = logout;
$('enroll').onclick = async () => { await api('/api/enroll', { method: 'POST', body: '{}' }); loadNext(); };
$('submit').onclick = submitAnswer;
$('skip').onclick = loadNext;
$('next').onclick = loadNext;
$('why').onclick = explainWhy;
$('save-settings').onclick = saveSettings;
document.querySelectorAll('#userbar [data-tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
render();
