'use strict';
/* EA LUBHO front end. Talks to /api only. No secrets live here. */
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { user: null, view: 'overview', adminTab: 'dashboard', eas: [], accounts: [], sessions: [], hostable: [], platform: null, projects: [], currentProject: null, logs: [], loading: 0 };
const isAdmin = () => state.user?.role === 'super_admin';

// ---------- small helpers ----------
const fmt = (ts) => (ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtDay = (ts) => (ts ? new Date(ts).toLocaleDateString([], { dateStyle: 'medium' }) : '—');
const ago = (ts) => {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const num = (n, d = 2) => (Number.isFinite(n) ? n.toLocaleString([], { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (kind === 'error' ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'error' ? 5200 : 2800);
}
const loading = (d) => { state.loading = Math.max(0, state.loading + d); $('#loadbar').classList.toggle('on', state.loading > 0); };

async function api(method, path, body, opts = {}) {
  loading(1);
  try {
    const init = { method, credentials: 'same-origin', headers: { 'x-requested-with': 'lubho' } };
    if (opts.raw !== undefined) { init.body = opts.raw; init.headers['content-type'] = 'application/octet-stream'; }
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    let res;
    try { res = await fetch('/api' + path, init); }
    catch { throw Object.assign(new Error('Cannot reach the server. Check your internet connection and try again.'), { network: true }); }
    if (opts.blob && res.ok) return await res.blob();
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
    if (!res.ok || !data || data.ok === false) {
      const err = new Error(data?.message || `The server answered with an error (${res.status}).`);
      err.status = res.status; err.code = data?.error;
      if (res.status === 401 && state.user && !opts.quiet) { state.user = null; showAuth('login', 'Your session has ended. Please sign in again.'); }
      throw err;
    }
    return data;
  } finally { loading(-1); }
}

// Disables a button while an action runs and reports errors.
async function run(btn, fn, okMsg) {
  const label = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(e.message, 'error'); return undefined; }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; } }
}

const badge = (cls, text) => `<span class="badge ${cls}">${esc(text)}</span>`;
function sessionBadge(s) {
  const m = { running: ['ok', 'RUNNING'], requested: ['warn', 'WAITING FOR HOST'], starting: ['warn', 'STARTING'], stop_requested: ['warn', 'STOPPING'], stopped: ['', 'STOPPED'], failed: ['err', 'FAILED'], unknown: ['warn', 'UNKNOWN'] }[s] || ['', String(s).toUpperCase()];
  return badge(m[0], m[1]);
}
function accountBadge(s) { return ({ connected: badge('ok', 'CONNECTED'), failed: badge('err', 'FAILED'), unverified: badge('warn', 'NOT VERIFIED') })[s] || badge('', s); }
function licenceBadge(s) { return ({ active: badge('ok', 'ACTIVE'), suspended: badge('warn', 'SUSPENDED'), revoked: badge('err', 'REVOKED'), expired: badge('err', 'EXPIRED') })[s] || badge('', s); }
const emptyRow = (cols, msg) => `<tr><td colspan="${cols}" class="muted">${esc(msg)}</td></tr>`;
const table = (heads, rows) => `<div class="table-wrap"><table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
const btnA = (act, id, label, cls = 'ghost', extra = '') => `<button class="btn ${cls}" data-act="${act}" data-id="${esc(id)}" ${extra}>${label}</button>`;

// ---------- modal ----------
let modalHandler = null;
function fieldHtml(f) {
  const id = 'f_' + f.id, req = f.required ? 'required' : '';
  let input;
  if (f.type === 'select') input = `<select id="${id}">${f.options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(f.value ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
  else if (f.type === 'textarea') input = `<textarea id="${id}" placeholder="${esc(f.placeholder || '')}" maxlength="${f.max || 600}">${esc(f.value || '')}</textarea>`;
  else input = `<input id="${id}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" ${f.accept ? `accept="${f.accept}"` : ''} ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : 'autocomplete="off"'} ${req}>`;
  return `<div class="field ${f.full ? 'full' : ''}"><label for="${id}">${esc(String(f.label).toUpperCase())}</label>${input}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
}
function modal({ title, desc = '', fields = [], html = '', submit = 'Save', onSubmit = null, danger = false, wide = false }) {
  $('#modalTitle').textContent = title;
  $('#modalDesc').textContent = desc; $('#modalDesc').hidden = !desc;
  $('#modalFields').innerHTML = fields.map(fieldHtml).join(''); $('#modalFields').hidden = !fields.length;
  $('#modalBody').innerHTML = html;
  const sb = $('#modalSubmit'); sb.hidden = !onSubmit; sb.textContent = submit; sb.className = 'btn ' + (danger ? 'danger' : 'primary'); sb.disabled = false;
  $('#cancelModal').textContent = onSubmit ? 'Cancel' : 'Close';
  $('#modalError').hidden = true;
  $('#modalBox').classList.toggle('wide', wide);
  modalHandler = onSubmit ? { fn: onSubmit, fields } : null;
  $('#modalBackdrop').classList.add('open');
  setTimeout(() => { const f = $('#modalFields input,#modalFields select,#modalFields textarea'); if (f && !$('#modalBox').contains(document.activeElement)) f.focus(); }, 30); // never steal focus from a field the person already clicked or typed in
}
const closeModal = () => { $('#modalBackdrop').classList.remove('open'); modalHandler = null; $('#modalBody').innerHTML = ''; $('#modalFields').innerHTML = ''; }; // clears one-time secrets from the page
const modalOpen = () => $('#modalBackdrop').classList.contains('open');
function confirmBox(title, desc, submit, onYes, danger = true) { modal({ title, desc, submit, danger, onSubmit: async () => await onYes() }); }
function secretBox(title, desc, secret, extraHtml = '') {
  modal({ title, desc, html: `<div class="secret-box"><code class="mono" id="secretText">${esc(secret)}</code><button class="btn" type="button" data-act="copy" data-text="${esc(secret)}">Copy</button></div>${extraHtml}<div class="notice">This is shown only once. Store it somewhere safe now.</div>` });
}
$('#closeModal').onclick = $('#cancelModal').onclick = closeModal;
$('#modalBackdrop').addEventListener('mousedown', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalOpen()) closeModal(); });
$('#modalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!modalHandler) return;
  const vals = {};
  for (const f of modalHandler.fields) { const el = $('#f_' + f.id); vals[f.id] = f.type === 'file' ? el.files[0] : f.type === 'number' ? el.value : el.value; if (f.required && !String(vals[f.id] ?? '').trim() && f.type !== 'file') { return showModalError(`${f.label} is required.`); } if (f.required && f.type === 'file' && !vals[f.id]) return showModalError('Choose a file first.'); }
  const sb = $('#modalSubmit'); sb.disabled = true; $('#modalError').hidden = true;
  try { const keep = await modalHandler.fn(vals); if (keep !== false) closeModal(); }
  catch (err) { showModalError(err.message); }
  finally { sb.disabled = false; }
});
function showModalError(m) { const e = $('#modalError'); e.textContent = m; e.hidden = false; }

// ---------- auth ----------
function showAuth(which, note = '') {
  $('#app').hidden = true; $('#auth').classList.add('open');
  for (const id of ['authLoading', 'authUnreachable', 'loginForm', 'registerForm', 'setupForm']) $('#' + id).hidden = true;
  if (which === 'loading') $('#authLoading').hidden = false;
  else if (which === 'unreachable') { $('#authUnreachable').hidden = false; $('#authUnreachableMsg').textContent = note; }
  else { $('#' + which + 'Form').hidden = false; if (which === 'login') $('#loginNote').textContent = note || 'Use the account you registered with.'; setTimeout(() => { const f = $('#' + which + 'Form'); if (f && !f.contains(document.activeElement)) f.querySelector('input')?.focus(); }, 30); }
}
$$('[data-auth]').forEach((b) => b.addEventListener('click', () => showAuth(b.dataset.auth)));
$('#authRetry').onclick = boot;
function formError(id, msg) { const e = $('#' + id); e.textContent = msg; e.hidden = !msg; }
async function submitForm(form, btnId, errId, fn) {
  formError(errId, ''); const b = $('#' + btnId), t = b.textContent; b.disabled = true; b.textContent = 'Please wait…';
  try { await fn(); } catch (e) { formError(errId, e.message); } finally { b.disabled = false; b.textContent = t; }
}
$('#loginForm').addEventListener('submit', (e) => { e.preventDefault(); submitForm(e.target, 'loginSubmit', 'loginError', async () => {
  const r = await api('POST', '/auth/login', { email: $('#loginEmail').value, password: $('#loginPassword').value }, { quiet: true });
  $('#loginPassword').value = ''; await enter(r.user);
}); });
$('#registerForm').addEventListener('submit', (e) => { e.preventDefault(); submitForm(e.target, 'registerSubmit', 'registerError', async () => {
  const r = await api('POST', '/auth/register', { name: $('#regName').value, email: $('#regEmail').value, password: $('#regPassword').value }, { quiet: true });
  $('#regPassword').value = '';
  if (r.pending) { showAuth('login', 'Registration received. An administrator must approve your account before you can sign in.'); return; }
  await enter(r.user);
}); });
$('#setupForm').addEventListener('submit', (e) => { e.preventDefault(); submitForm(e.target, 'setupSubmit', 'setupError', async () => {
  const email = $('#setupEmail').value, password = $('#setupPassword').value;
  await api('POST', '/setup', { setupToken: $('#setupToken').value, name: $('#setupName').value, email, password }, { quiet: true });
  $('#setupToken').value = ''; $('#setupPassword').value = '';
  const r = await api('POST', '/auth/login', { email, password }, { quiet: true });
  await enter(r.user);
}); });

async function enter(user) {
  state.user = user;
  $('#auth').classList.remove('open'); $('#app').hidden = false;
  document.body.classList.toggle('is-admin', user.role === 'super_admin');
  const label = user.role === 'super_admin' ? 'SUPER ADMIN' : 'MEMBER';
  $('#roleTag').textContent = label; $('#roleBadgeMobile').textContent = label;
  $('#avatarBtn').textContent = (user.name || user.email || '?').trim().charAt(0).toUpperCase();
  go('overview');
  refreshNotifDot();
  if (user.mustChange) openChangePassword(true);
}
async function boot() {
  showAuth('loading');
  try {
    const s = await api('GET', '/setup/status', undefined, { quiet: true });
    $('#approvalNote').hidden = !s.approvalRequired;
    if (s.needsSetup) return showAuth('setup');
    try { const me = await api('GET', '/me', undefined, { quiet: true }); await enter(me.user); }
    catch (e) { if (e.network) throw e; showAuth('login'); }
  } catch (e) { showAuth('unreachable', e.message); }
}

// ---------- account ----------
function openAccount() {
  const u = state.user;
  modal({ title: 'Your account', desc: `${u.email} · ${u.role === 'super_admin' ? 'Super Admin' : 'Member'}`,
    fields: [{ id: 'name', label: 'Display name', value: u.name, required: true, full: true }], submit: 'Save name',
    html: `<div class="form-actions" style="justify-content:flex-start;flex-wrap:wrap"><button type="button" class="btn" data-act="change-password">Change password</button><button type="button" class="btn" data-act="logout">Sign out</button>${u.role === 'super_admin' ? '' : '<button type="button" class="btn danger" data-act="delete-me">Delete my account</button>'}</div>`,
    onSubmit: async (v) => { const r = await api('PATCH', '/me', { name: v.name }); state.user = { ...state.user, ...r.user }; $('#avatarBtn').textContent = r.user.name.charAt(0).toUpperCase(); toast('Name saved.'); } });
}
function openChangePassword(forced = false) {
  modal({ title: forced ? 'Choose a new password' : 'Change password', desc: forced ? 'The administrator gave you a temporary password. Set your own now.' : 'You will stay signed in here; other devices are signed out.',
    fields: [{ id: 'current', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password', full: true }, { id: 'next', label: 'New password (10+ characters)', type: 'password', required: true, autocomplete: 'new-password', full: true }],
    submit: 'Change password', onSubmit: async (v) => { await api('POST', '/me/password', { current: v.current, next: v.next }); state.user.mustChange = false; toast('Password changed.'); } });
}
async function logout() { try { await api('POST', '/auth/logout', {}, { quiet: true }); } catch {} state.user = null; closeModal(); document.body.classList.remove('is-admin'); showAuth('login', 'You have been signed out.'); }

// ---------- navigation ----------
const titles = { overview: 'Overview', robots: 'Master Robot Hub', 'lubho-core': 'LUBHO Core', 'jumbo-scalper': 'Jumbo Scalper', brokers: 'Broker Connections', trades: 'Live Trade Monitor', hosting: 'EA Cloud Hosting', config: 'Client Trading Configuration', settings: 'Profile & Settings', licenses: 'Licence Centre', analytics: 'Analytics Centre', notifications: 'Notifications Centre', admin: 'Super Admin Dashboard', 'ea-studio': 'EA Development Studio' };
const adminViews = ['admin', 'ea-studio'];
function go(v) {
  if (adminViews.includes(v) && !isAdmin()) v = 'overview';
  state.view = v;
  $$('.view').forEach((x) => x.classList.toggle('active', x.id === 'view-' + v));
  $$('[data-view]').forEach((x) => x.classList.toggle('active', x.dataset.view === v));
  $('#pageTitle').textContent = titles[v] || 'EA LUBHO';
  window.scrollTo({ top: 0 });
  loadView(v);
}
const loaders = {};
async function loadView(v, silent = false) {
  const fn = loaders[v]; if (!fn) return;
  try { await fn(); } catch (e) { if (!silent && state.user) toast(e.message, 'error'); }
}
$$('[data-view]').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.robot-open-card')) { e.preventDefault(); go(e.target.dataset.go); } });

// ---------- action dispatcher ----------
const acts = {};
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]'); if (g) { closeModal(); return go(g.dataset.go); }
  const a = e.target.closest('[data-act]'); if (!a) return;
  const fn = acts[a.dataset.act]; if (fn) fn(a.dataset.id, a, e);
});
acts.account = () => openAccount();
acts.logout = () => logout();
acts['change-password'] = () => openChangePassword();
acts.copy = async (_, el) => { try { await navigator.clipboard.writeText(el.dataset.text); toast('Copied.'); } catch { const r = document.createRange(); r.selectNodeContents($('#secretText')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Press Ctrl+C to copy the selected text.'); } };
acts.more = () => {
  const items = [['trades', '↗ Live Trade Monitor'], ['config', '☰ Client Trading Configuration'], ['settings', '☺ Profile & Settings'], ['licenses', '⌑ Licence Centre'], ['analytics', '▥ Analytics Centre'], ['notifications', '♧ Notifications'], ['lubho-core', '◈ LUBHO Core'], ['jumbo-scalper', '◈ Jumbo Scalper']];
  if (isAdmin()) items.push(['admin', '⚙ Super Admin'], ['ea-studio', '⌘ EA Development Studio']);
  modal({ title: 'More', html: `<div class="more-list">${items.map(([v, l]) => `<button class="btn" data-go="${v}">${l}</button>`).join('')}<button class="btn ghost" data-act="account">Account · Sign out</button></div>` });
};
acts['delete-me'] = () => modal({ title: 'Delete your account', desc: 'This permanently removes your account, robots, files and saved MT5 accounts. Stop all hosting sessions first.', danger: true, submit: 'Delete everything',
  fields: [{ id: 'password', label: 'Confirm with your password', type: 'password', required: true, full: true }],
  onSubmit: async (v) => { await api('DELETE', '/me', { password: v.password }); state.user = null; showAuth('login', 'Your account was deleted.'); } });

// ---------- platform status (sidebar, top bar) ----------
async function loadPlatform() {
  try {
    const p = (await api('GET', '/platform')).platform; state.platform = p;
    const online = p.hostsOnline > 0, none = p.hostsRegistered === 0;
    $('#sideStatusTitle').textContent = online ? '● Hosting machine: online' : none ? '● Hosting machine: none' : '● Hosting machine: offline';
    $('#sideStatusText').textContent = online ? 'The agent is reporting in. Sessions can start.' : none ? 'The administrator has not connected a hosting machine yet. Hosting cannot start.' : 'No hosting machine has reported in recently. Sessions will wait.';
    $('#topStatus').innerHTML = `<i class="${online ? 'ok' : 'bad'}"></i>${online ? 'Host online' : none ? 'No host' : 'Host offline'}`;
  } catch {}
  return state.platform;
}
async function refreshNotifDot() {
  try { const r = await api('GET', '/notifications', undefined, { quiet: true }); const d = $('#notifDot'); d.hidden = !r.unread; d.textContent = r.unread; } catch {}
}

// ---------- overview ----------
loaders.overview = async () => {
  const [st, eas, ses, accts] = await Promise.all([api('GET', '/stats'), api('GET', '/eas'), api('GET', '/sessions'), api('GET', '/accounts')]);
  const p = (await loadPlatform()) || { hostsOnline: 0, hostsRegistered: 0 };
  const s = st.stats;
  $('#robotCount').textContent = s.eas; $('#robotNote').textContent = `${s.files} EX5 file(s) · ${bytes(s.storageBytes)}`;
  $('#brokerCount').textContent = s.accounts; $('#brokerNote').textContent = `${s.accountsConnected} confirmed by the host`;
  $('#licenseCount').textContent = s.licencesActive;
  $('#runningCount').textContent = s.sessionsRunning; $('#runningNote').textContent = `${s.sessionsTotal} session(s) in total`;
  $('#overviewRobots').innerHTML = eas.eas.slice(0, 4).map((e) => `<div class="row-card robot-open-card" role="button" tabindex="0" data-act="ea-open" data-id="${esc(e.id)}"><span class="robot-icon">◈</span><div class="row-main"><b>${esc(e.name)}</b><small>v${esc(e.version)} · ${e.files} file(s)</small></div>${badge(e.status === 'published' ? 'ok' : '', e.status.toUpperCase())}<span class="btn ghost">Open →</span></div>`).join('') || '<div class="empty"><strong>No robots yet</strong>Add a robot and upload its EX5 file in the Master Robot Hub.</div>';
  const row = (cls, t, title, sub) => `<div class="row-card">${badge(cls, t)}<div class="row-main"><b>${title}</b><small>${sub}</small></div></div>`;
  $('#overviewChecklist').innerHTML = [
    p.hostsOnline > 0 ? row('ok', 'ONLINE', 'Hosting machine', `${p.hostsOnline} of ${p.hostsRegistered} reporting in`) : row('warn', p.hostsRegistered ? 'OFFLINE' : 'NOT SET UP', 'Hosting machine', p.hostsRegistered ? 'Not reporting in; sessions will wait' : 'The administrator must connect one'),
    s.accounts ? (s.accountsConnected ? row('ok', 'VERIFIED', 'MT5 accounts', `${s.accountsConnected} of ${s.accounts} confirmed`) : row('warn', 'NOT VERIFIED', 'MT5 accounts', 'None confirmed by the host yet')) : row('', 'NONE', 'MT5 accounts', 'Add an account to host an EA'),
    s.files ? row('ok', 'READY', 'EX5 files', `${s.files} uploaded`) : row('', 'NONE', 'EX5 files', 'Upload a compiled EA'),
    s.sessionsRunning ? row('ok', 'RUNNING', 'Hosting', `${s.sessionsRunning} session(s) confirmed running`) : row('', 'IDLE', 'Hosting', 'Nothing running'),
  ].join('');
};

// ---------- robots (EAs) ----------
loaders.robots = async () => {
  const [mine, cat] = await Promise.all([api('GET', '/eas'), api('GET', '/catalogue')]);
  state.eas = mine.eas;
  $('#robotTable').innerHTML = mine.eas.map((e) => `<tr><td><b>${esc(e.name)}</b><span class="sub">${esc(e.description)}</span></td><td>${esc(e.version)}</td><td>${badge(e.status === 'published' ? 'ok' : '', e.status === 'published' ? 'PUBLISHED' : 'PRIVATE')}</td><td>${e.files}</td><td>${fmtDay(e.updatedAt)}</td><td class="actions-cell">${btnA('ea-open', e.id, 'Open')} ${btnA('ea-delete', e.id, 'Remove', 'danger')}</td></tr>`).join('') || emptyRow(6, 'No robots yet. Press "Add robot" to register your first Expert Advisor.');
  const others = cat.eas.filter((e) => !mine.eas.some((m) => m.id === e.id));
  $('#catalogueList').innerHTML = others.map((e) => `<div class="row-card"><span class="robot-icon">◈</span><div class="row-main"><b>${esc(e.name)}</b><small>v${esc(e.version)} · ${esc(e.description)}</small></div>${badge('ok', 'PUBLISHED')}</div>`).join('') || '<div class="empty">Nothing is published yet.</div>';
};
const eaFields = (e = {}) => [{ id: 'name', label: 'Robot name', value: e.name, required: true, full: true, placeholder: 'e.g. LUBHO Core' }, { id: 'version', label: 'Version', value: e.version || '1.0', required: true }, { id: 'description', label: 'Description (optional)', type: 'textarea', value: e.description, full: true }];
acts['ea-new'] = () => modal({ title: 'Add a robot', desc: 'Registers the robot. Upload its compiled EX5 file next.', fields: eaFields(), submit: 'Add robot',
  onSubmit: async (v) => { const r = await api('POST', '/eas', v); toast('Robot added.'); loadView(state.view); openEa(r.id); return false; } });
acts['ea-delete'] = (id) => { const e = state.eas.find((x) => x.id === id) || {}; confirmBox('Remove robot?', `"${e.name}" and all its EX5 files will be permanently deleted.`, 'Remove', async () => { await api('DELETE', '/eas/' + id); toast('Robot removed.'); loadView(state.view); }); };
acts['ea-open'] = (id) => openEa(id);
async function openEa(id) {
  let d;
  try { d = await api('GET', '/eas/' + id); } catch (e) { return toast(e.message, 'error'); }
  const ea = d.ea, mine = ea.ownerId === state.user.id || isAdmin();
  const files = d.files.map((f) => `<tr><td>${esc(f.filename)}</td><td>${bytes(f.size)}</td><td>${fmtDay(f.uploadedAt)}</td><td class="actions-cell">${btnA('file-download', f.id, 'Download', 'ghost', `data-name="${esc(f.filename)}"`)} ${btnA('file-delete', f.id, 'Delete', 'danger', `data-ea="${esc(ea.id)}"`)}</td></tr>`).join('') || emptyRow(4, 'No files uploaded.');
  modal({ title: ea.name, desc: `v${ea.version} · ${ea.status === 'published' ? 'Published in the catalogue' : 'Private'}${ea.ownerEmail && isAdmin() ? ' · owner ' + ea.ownerEmail : ''}`, wide: true,
    html: `<p class="sub">${esc(ea.description) || 'No description.'}</p>
      <h3 style="font-size:14px;margin:14px 0 6px">EX5 files</h3>${table(['File', 'Size', 'Uploaded', ''], files)}
      ${mine ? `<div class="field" style="margin-top:12px"><label for="uploadFile">UPLOAD A COMPILED EX5</label><input id="uploadFile" type="file" accept=".ex5"><div class="hint">Stored privately. Compile your .mq5 in MetaEditor first. Maximum size depends on the server storage (shown in the error if exceeded).</div></div>
      <div class="form-actions" style="justify-content:flex-start;flex-wrap:wrap"><button type="button" class="btn primary" data-act="file-upload" data-id="${esc(ea.id)}">Upload file</button><button type="button" class="btn" data-act="ea-edit" data-id="${esc(ea.id)}">Edit details</button>${isAdmin() ? btnA('ea-publish', ea.id, ea.status === 'published' ? 'Unpublish' : 'Publish', 'btn', `data-to="${ea.status === 'published' ? 'draft' : 'published'}"`) : ''}</div>` : ''}` });
}
acts['ea-edit'] = async (id) => {
  const d = await api('GET', '/eas/' + id).catch((e) => toast(e.message, 'error')); if (!d) return;
  modal({ title: 'Edit robot', fields: eaFields(d.ea), submit: 'Save changes', onSubmit: async (v) => { await api('PATCH', '/eas/' + id, v); toast('Saved.'); loadView(state.view); openEa(id); return false; } });
};
acts['ea-publish'] = (id, el) => run(el, async () => { await api('POST', `/admin/eas/${id}/status`, { status: el.dataset.to }); loadView(state.view); openEa(id); }, 'Visibility updated.');
acts['file-upload'] = (id, el) => {
  const f = $('#uploadFile')?.files[0]; if (!f) return toast('Choose an .ex5 file first.', 'error');
  run(el, async () => { await api('POST', `/eas/${id}/files?name=${encodeURIComponent(f.name)}`, undefined, { raw: await f.arrayBuffer() }); loadView(state.view); await openEa(id); }, 'File uploaded.');
};
acts['file-download'] = (id, el) => run(el, async () => {
  const blob = await api('GET', `/files/${id}/download`, undefined, { blob: true });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = el.dataset.name || 'file.ex5'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});
acts['file-delete'] = (id, el) => { const ea = el.dataset.ea; confirmBox('Delete file?', 'The EX5 file will be permanently deleted.', 'Delete', async () => { await api('DELETE', '/files/' + id); toast('File deleted.'); loadView(state.view); if (ea) openEa(ea); }); };

// ---------- MT5 accounts ----------
loaders.brokers = async () => {
  state.accounts = (await api('GET', '/accounts')).accounts;
  $('#brokerList').innerHTML = state.accounts.map((a) => {
    const i = a.info ? `<br>Last snapshot: ${a.info.balance !== undefined ? 'balance ' + num(a.info.balance) + ' ' + esc(a.info.currency || '') : ''} (${ago(a.infoAt)})` : '';
    return `<div class="row-card"><span class="robot-icon">◎</span><div class="row-main"><b>${esc(a.label || a.login)} · ${esc(a.login)}</b><small>${esc(a.server)} · ${esc(a.kind.toUpperCase())}<br>${esc(a.statusDetail || 'Not checked yet.')}${i}</small></div><div class="row-end" style="display:grid;gap:6px;justify-items:end">${accountBadge(a.status)}<span class="actions-cell">${btnA('acct-verify', a.id, 'Verify')} ${btnA('acct-edit', a.id, 'Edit')} ${btnA('acct-delete', a.id, '×', 'danger')}</span></div></div>`;
  }).join('') || '<div class="empty"><strong>No MT5 accounts yet</strong>Add an account so the hosting machine can log in and run your EA.</div>';
};
const acctFields = (a) => [
  { id: 'label', label: 'Label (optional)', value: a?.label, placeholder: 'e.g. Gold demo' },
  { id: 'kind', label: 'Type', type: 'select', options: state.platform?.liveAccountsAllowed ? [['demo', 'Demo'], ['live', 'Live']] : [['demo', 'Demo (live accounts are off during testing)']], value: a?.kind || 'demo' },
  ...(a ? [] : [{ id: 'login', label: 'MT5 login (number)', required: true, placeholder: 'e.g. 12345678' }, { id: 'server', label: 'Server', required: true, placeholder: 'e.g. JustMarkets-Demo' }]),
  { id: 'password', label: a ? 'New MT5 password (leave empty to keep)' : 'MT5 password', type: 'password', required: !a, full: true, autocomplete: 'off', hint: 'Encrypted on the server. Never shown again.' }];
acts['acct-new'] = () => modal({ title: 'Add MT5 account', desc: 'The hosting machine will try to log in to confirm it.', fields: acctFields(), submit: 'Save account',
  onSubmit: async (v) => { await api('POST', '/accounts', v); toast('Account saved. Waiting for the hosting machine to verify it.'); loadView('brokers'); } });
acts['acct-edit'] = (id) => { const a = state.accounts.find((x) => x.id === id); modal({ title: `Edit ${a.login}`, fields: acctFields(a), submit: 'Save',
  onSubmit: async (v) => { const body = { label: v.label, kind: v.kind }; if (v.password) body.password = v.password; await api('PATCH', '/accounts/' + id, body); toast('Saved.'); loadView('brokers'); } }); };
acts['acct-verify'] = (id, el) => run(el, async () => { await api('POST', `/accounts/${id}/verify`, {}); loadView('brokers'); }, 'Check queued. The hosting machine will answer shortly.');
acts['acct-delete'] = (id) => { const a = state.accounts.find((x) => x.id === id); confirmBox('Delete MT5 account?', `${a.login}@${a.server} and its stored (encrypted) password will be deleted.`, 'Delete', async () => { await api('DELETE', '/accounts/' + id); toast('Account deleted.'); loadView('brokers'); }); };

// ---------- trade monitor (snapshots only) ----------

// ---------- hosting ----------
loaders.hosting = async () => {
  const [ses, p] = await Promise.all([api('GET', '/sessions'), loadPlatform()]);
  state.sessions = ses.sessions;
  const hb = $('#hostBadge');
  hb.className = 'badge ' + (p.hostsOnline ? 'ok' : 'warn');
  hb.textContent = p.hostsOnline ? `HOSTING MACHINE ONLINE (${p.hostsOnline}/${p.hostsRegistered})` : p.hostsRegistered ? 'HOSTING MACHINE OFFLINE' : 'NO HOSTING MACHINE CONNECTED';
  $('#hostingNote').textContent = p.hostsOnline ? 'The agent is reporting in.' : 'Sessions cannot be started until a hosting machine is online.';
  $('#sessionTable').innerHTML = state.sessions.map((s) => {
    const live = ['requested', 'starting', 'running', 'stop_requested', 'unknown'].includes(s.status);
    return `<tr><td><b>${esc(s.eaName || 'Removed EA')}</b><span class="sub">${esc(s.fileName || '')}</span></td><td>${esc(s.accountLabel || s.accountLogin || '—')}<span class="sub">${esc(s.accountLogin || '')}</span></td><td>${esc(s.hostName || '—')}<span class="sub">${s.hostId ? (s.hostOnline ? 'online' : 'offline') : ''}</span></td><td>${sessionBadge(s.status)}<span class="sub">${esc(s.detail)}</span></td><td>${s.lastReportAt ? ago(s.lastReportAt) : fmt(s.createdAt)}</td><td class="actions-cell">${live && s.status !== 'stop_requested' ? btnA('session-stop', s.id, 'Stop', 'danger') : ''}${!live ? btnA('session-restart', s.id, 'Start again') + ' ' + btnA('session-delete', s.id, 'Remove') : ''}</td></tr>`;
  }).join('') || emptyRow(6, 'No hosting sessions yet. Press "Start hosting".');
};
acts['session-new'] = async () => {
  let h, a;
  try { [h, a] = await Promise.all([api('GET', '/hostable'), api('GET', '/accounts')]); } catch (e) { return toast(e.message, 'error'); }
  const ok = a.accounts.filter((x) => x.status === 'connected');
  if (!h.files.length) return modal({ title: 'Nothing to host yet', html: '<p>Upload an EX5 file in the Master Robot Hub (or redeem a licence for a published EA) first.</p>' });
  if (!ok.length) return modal({ title: 'No verified MT5 account', html: '<p>An account must be confirmed by the hosting machine before it can host an EA. Add one in Broker Connections and press Verify, then wait for it to show <b>Connected</b>.</p>' });
  modal({ title: 'Start hosting', desc: 'Asks the hosting machine to open MT5 with this account and attach the EA.', submit: 'Start hosting',
    fields: [{ id: 'fileId', label: 'Robot / EX5 file', type: 'select', full: true, options: h.files.map((f) => [f.fileId, `${f.eaName} v${f.eaVersion} · ${f.filename}${f.source === 'licensed' ? ' (licensed)' : ''}`]) }, { id: 'accountId', label: 'MT5 account', type: 'select', full: true, options: ok.map((x) => [x.id, `${x.label || x.login} · ${x.login} · ${x.server} (${x.kind})`]) },
      ...configFields({}), ],
    onSubmit: async (v) => { await api('POST', '/sessions', { fileId: v.fileId, accountId: v.accountId, ...(await configBody(v)) }); toast('Requested. It will show Running only after the host confirms.'); loadView('hosting'); } });
};
acts['session-stop'] = (id, el) => run(el, async () => { await api('POST', `/sessions/${id}/stop`, {}); loadView('hosting'); }, 'Stop requested.');
acts['session-restart'] = (id, el) => run(el, async () => { await api('POST', `/sessions/${id}/restart`, {}); loadView('hosting'); }, 'Start requested.');
acts['session-delete'] = (id, el) => run(el, async () => { await api('DELETE', '/sessions/' + id); loadView('hosting'); }, 'Removed.');

// ---------- licences (user) ----------
loaders.licenses = async () => {
  const l = (await api('GET', '/licences')).licences;
  $('#licenseTable').innerHTML = l.map((x) => `<tr><td class="mono">${esc(x.hint)}<span class="sub">${esc(x.label)}</span></td><td>${esc(x.eaName || 'Any published EA')}</td><td>${x.accountsUsed}/${x.maxAccounts}</td><td>${x.expiresAt ? fmtDay(x.expiresAt) : x.durationDays ? 'Starts on first use' : 'Never'}</td><td>${licenceBadge(x.status)}</td></tr>`).join('') || emptyRow(5, 'No licences redeemed yet.');
};
$('#redeemForm').addEventListener('submit', (e) => { e.preventDefault(); run($('#redeemBtn'), async () => { await api('POST', '/licences/redeem', { key: $('#redeemKey').value }); $('#redeemKey').value = ''; loadView('licenses'); }, 'Licence redeemed.'); });

// ---------- notifications ----------
loaders.notifications = async () => {
  const r = await api('GET', '/notifications');
  $('#noticeList').innerHTML = r.notifications.map((n) => `<div class="row-card ${n.read ? '' : 'unread'}"><span class="robot-icon">${{ error: '✕', warning: '!', success: '✓' }[n.kind] || 'i'}</span><div class="row-main"><b>${esc(n.title)}</b><small>${esc(n.detail)}</small></div><div class="row-end"><small>${ago(n.createdAt)}</small></div></div>`).join('') || '<div class="empty">No notifications.</div>';
  const d = $('#notifDot'); d.hidden = !r.unread; d.textContent = r.unread;
};
$('#markRead').onclick = (e) => run(e.target, async () => { await api('POST', '/notifications/read-all', {}); loadView('notifications'); });
$('#clearNotices').onclick = (e) => run(e.target, async () => { await api('DELETE', '/notifications'); loadView('notifications'); }, 'Cleared.');

// ---------- Jumbo Scalper workspace ----------
const lstore = { get(k, d) { try { return JSON.parse(localStorage.getItem('lubho_' + k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem('lubho_' + k, JSON.stringify(v)); } catch {} } };
loaders['jumbo-scalper'] = async () => {
  const s = lstore.get('jumbo_settings', { symbol: 'XAUUSD', timeframe: 'M5', risk: '0.5', maxTrades: '2' });
  $('#jumboSymbol').value = s.symbol; $('#jumboTimeframe').value = s.timeframe; $('#jumboRisk').value = s.risk; $('#jumboMaxTrades').value = s.maxTrades;
  const [eas, ses] = await Promise.all([api('GET', '/eas'), api('GET', '/sessions')]);
  const ea = eas.eas.find((e) => /jumbo/i.test(e.name));
  const sess = ea && ses.sessions.find((x) => x.eaId === ea.id && !['stopped', 'failed'].includes(x.status));
  $('#jumboVersion').textContent = ea ? ea.version : '—'; $('#jumboVersionNote').textContent = ea ? ea.name : 'No robot named "Jumbo…" registered';
  $('#jumboFiles').textContent = ea ? ea.files : '—';
  $('#jumboSession').textContent = sess ? sess.status.replace('_', ' ').toUpperCase() : ea ? 'NOT HOSTED' : '—';
  $('#jumboSessionNote').textContent = sess ? sess.detail : '';
  const st = $('#jumboStatus'); st.className = 'badge ' + (sess?.status === 'running' ? 'ok' : 'warn'); st.textContent = sess?.status === 'running' ? 'RUNNING ON THE HOSTING MACHINE' : ea ? 'REGISTERED · NOT RUNNING' : 'NOT REGISTERED';
};
$('#saveJumboSettings').onclick = () => { lstore.set('jumbo_settings', { symbol: $('#jumboSymbol').value.trim(), timeframe: $('#jumboTimeframe').value, risk: $('#jumboRisk').value, maxTrades: $('#jumboMaxTrades').value }); toast('Notes saved in this browser only.'); };

// ---------- EA Development Studio (Super Admin, stored on the server) ----------
const starterSource = `//+------------------------------------------------------------------+
//| New EA - starter template                                        |
//+------------------------------------------------------------------+
#property strict
#property version   "1.00"

int OnInit()
{
   Print("EA initialised. Test safely in Strategy Tester/demo.");
   return(INIT_SUCCEEDED);
}

void OnTick()
{
   // Add and test your strategy logic here.
   // This starter template does not place trades.
}

void OnDeinit(const int reason)
{
   Print("EA stopped.");
}`;
const setSave = (t, cls = 'warn') => { const b = $('#eaSaveStatus'); b.textContent = t; b.className = 'badge ' + cls; };
function fillProject(p) { state.currentProject = p?.id || null; $('#eaProjectName').value = p?.name || 'New EA Project'; $('#eaProjectVersion').value = p?.version || '1.0'; $('#eaPlatform').value = p?.platform || 'MT5'; $('#eaCodeEditor').value = p ? p.code : starterSource; }
loaders['ea-studio'] = async () => {
  state.projects = (await api('GET', '/admin/studio')).projects;
  $('#eaProjectList').innerHTML = state.projects.map((p) => `<button class="row-card" style="width:100%;text-align:left;color:inherit" data-act="studio-open" data-id="${esc(p.id)}"><span class="robot-icon">⌘</span><span class="row-main"><b>${esc(p.name)}</b><small>${esc(p.platform)} · v${esc(p.version)} · ${fmt(p.updatedAt)}</small></span><span class="badge">OPEN</span></button>`).join('') || '<div class="empty"><strong>No saved projects</strong>Create your first EA project.</div>';
  if (!$('#eaCodeEditor').value) fillProject(null);
};
acts['studio-open'] = async (id) => { const r = await api('GET', '/admin/studio/' + id).catch((e) => toast(e.message, 'error')); if (r) { fillProject(r.project); setSave('SAVED', 'ok'); } };
$('#newEaProject').onclick = () => { fillProject(null); setSave('UNSAVED'); };
$('#saveEaProject').onclick = (e) => run(e.target, async () => {
  const body = { name: $('#eaProjectName').value, version: $('#eaProjectVersion').value, platform: $('#eaPlatform').value, code: $('#eaCodeEditor').value };
  if (state.currentProject) await api('PUT', '/admin/studio/' + state.currentProject, body); else state.currentProject = (await api('POST', '/admin/studio', body)).id;
  setSave('SAVED', 'ok'); loadView('ea-studio');
}, 'Project saved on the server.');
$('#deleteEaProject').onclick = () => { if (!state.currentProject) return toast('This project is not saved yet.', 'error'); confirmBox('Delete project?', 'The saved source will be deleted.', 'Delete', async () => { await api('DELETE', '/admin/studio/' + state.currentProject); fillProject(null); setSave('UNSAVED'); loadView('ea-studio'); }); };
$('#downloadEaProject').onclick = () => {
  const ext = $('#eaPlatform').value === 'MT4' ? 'mq4' : 'mq5', name = ($('#eaProjectName').value.trim() || 'EA_Project').replace(/[^a-z0-9_-]+/gi, '_');
  const url = URL.createObjectURL(new Blob([$('#eaCodeEditor').value], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name + '.' + ext; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Source download prepared. Compile it in MetaEditor.');
};
$('#importEaProject').onclick = () => $('#eaImportFile').click();
$('#eaImportFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 190000) { e.target.value = ''; return toast('That file is too large for the Studio (190 KB limit).', 'error'); }
  $('#eaCodeEditor').value = await f.text(); $('#eaProjectName').value = f.name.replace(/\.(mq5|mq4|txt)$/i, ''); $('#eaPlatform').value = /\.mq4$/i.test(f.name) ? 'MT4' : 'MT5'; state.currentProject = null; setSave('IMPORTED · UNSAVED'); e.target.value = '';
});
['eaCodeEditor', 'eaProjectName', 'eaProjectVersion', 'eaPlatform'].forEach((id) => $('#' + id).addEventListener('input', () => setSave('UNSAVED')));

// ---------- Super Admin ----------
const tabLoaders = {};
loaders.admin = () => tabLoaders[state.adminTab]();
$('#adminTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  state.adminTab = b.dataset.tab; $$('#adminTabs button').forEach((x) => x.classList.toggle('active', x === b)); loadView('admin');
});
const adminBody = (html) => { $('#adminBody').innerHTML = html; };
const stat = (h, v, n = '', cls = '') => `<div class="stat"><div class="stat-head">${h}</div><div class="stat-value">${v}</div><div class="stat-note ${cls}">${n}</div></div>`;
const cnt = (o, k) => (o && o[k]) || 0;

tabLoaders.dashboard = async () => {
  const [st, sys] = await Promise.all([api('GET', '/admin/stats'), api('GET', '/admin/system')]);
  const s = st.stats, y = sys.system;
  const row = (ok, title, sub, okText = 'OK', badText = 'ACTION NEEDED') => `<div class="row-card">${badge(ok ? 'ok' : 'warn', ok ? okText : badText)}<div class="row-main"><b>${title}</b><small>${sub}</small></div></div>`;
  adminBody(`<div class="grid stats">
    ${stat('MEMBERS', s.users, `${s.usersSuspended} suspended`)}
    ${stat('WAITING FOR APPROVAL', s.usersPending, s.usersPending ? 'Open the Users tab to approve' : 'Nobody is waiting', s.usersPending ? 'bad' : '')}
    ${stat('ROBOTS', cnt(s.eas, 'published') + cnt(s.eas, 'draft'), `${cnt(s.eas, 'published')} published · ${cnt(s.eas, 'draft')} private`)}
    ${stat('EX5 FILES', s.files, bytes(s.storageBytes) + ' stored')}
    ${stat('MT5 ACCOUNTS', Object.values(s.accounts).reduce((a, b) => a + b, 0), `${cnt(s.accounts, 'connected')} connected · ${cnt(s.accounts, 'failed')} failed · ${cnt(s.accounts, 'unverified')} unverified`)}
    ${stat('LICENCES', cnt(s.licences, 'active') - s.licencesExpired, `${cnt(s.licences, 'suspended')} suspended · ${cnt(s.licences, 'revoked')} revoked · ${s.licencesExpired} expired`)}
    ${stat('SESSIONS RUNNING', cnt(s.sessions, 'running'), `${cnt(s.sessions, 'failed')} failed · ${cnt(s.sessions, 'requested') + cnt(s.sessions, 'starting')} waiting`)}
    ${stat('HOSTING MACHINES', `${s.hosts.online}/${s.hosts.total}`, 'online / registered', s.hosts.total && !s.hosts.online ? 'bad' : '')}
    ${stat('PENDING HOST TASKS', s.pendingTasks, 'Waiting for the agent', s.pendingTasks && !s.hosts.online ? 'bad' : '')}
  </div>
  <div class="grid two-col"><div class="panel"><div class="panel-head"><h3>System status</h3></div><div class="list">
    ${row(y.credentialKeyConfigured, 'CREDENTIAL_KEY', y.credentialKeyConfigured ? 'Set. MT5 passwords can be encrypted.' : 'Missing: saving MT5 accounts will fail until you set it in Cloudflare.')}
    ${row(y.setupTokenConfigured, 'SETUP_TOKEN', y.setupTokenConfigured ? 'Set (only used for first-time setup).' : 'Not set. Only needed before the first admin exists.', 'OK', 'NOT SET')}
    ${row(y.fileStorage === 'r2', 'File storage', y.fileStorage === 'r2' ? 'Cloudflare R2 (files up to 20 MB).' : 'Database storage (files up to 3 MB). Bind an R2 bucket named FILES for bigger EX5 files.', 'R2', 'D1 · SMALL FILES')}
    ${row(y.hostsOnline > 0, 'Hosting machine', y.hostsRegistered ? `${y.hostsOnline} of ${y.hostsRegistered} online` : 'None registered. Add one in "Hosting machines".', 'ONLINE', y.hostsRegistered ? 'OFFLINE' : 'NONE')}
  </div></div>
  <div class="panel"><h3>Workspace</h3><div class="panel-sub">Brand and app information</div><div style="margin-top:15px"><div class="field"><label>PLATFORM NAME</label><input value="EA LUBHO" readonly></div><div class="field" style="margin-top:12px"><label>PLATFORM</label><input value="MetaTrader 5 (MT5)" readonly></div></div><div class="notice blue">Secrets (SETUP_TOKEN, CREDENTIAL_KEY) live only in Cloudflare, never in the website files or GitHub.</div></div></div>`);
};

tabLoaders.users = async () => {
  const q = $('#userSearch')?.value || '';
  const r = await api('GET', '/admin/users?q=' + encodeURIComponent(q));
  adminBody(`<div class="panel"><div class="panel-head"><div><h3>Users</h3><div class="panel-sub">${r.users.length} shown</div></div><input class="search field" style="padding:9px;border:1px solid #28455d;border-radius:10px;background:#081827;color:#fff" id="userSearch" placeholder="Search email or name" value="${esc(q)}"></div>` +
    table(['User', 'Role', 'Status', 'Robots', 'Accounts', 'Active', 'Last sign-in', ''], r.users.map((u) => `<tr><td><b>${esc(u.name)}</b><span class="sub">${esc(u.email)}</span></td><td>${u.role === 'super_admin' ? badge('sim', 'SUPER ADMIN') : 'Member'}</td><td>${badge(u.status === 'active' ? 'ok' : u.status === 'pending' ? 'warn' : 'err', u.status === 'pending' ? 'WAITING FOR APPROVAL' : u.status.toUpperCase())}</td><td>${u.eas}</td><td>${u.accounts}</td><td>${u.activeSessions}</td><td>${u.lastLogin ? ago(u.lastLogin) : 'never'}</td><td class="actions-cell">${u.role === 'super_admin' ? '' : (u.status === 'pending' ? btnA('user-approve', u.id, 'Approve', 'primary') + btnA('user-reject', u.id, 'Reject') : u.status === 'rejected' ? btnA('user-approve', u.id, 'Approve', 'primary') : u.status === 'active' ? btnA('user-suspend', u.id, 'Suspend') : btnA('user-restore', u.id, 'Restore')) + btnA('user-reset', u.id, 'Reset password') + btnA('user-delete', u.id, 'Delete', 'danger', `data-email="${esc(u.email)}"`)}</td></tr>`).join('') || emptyRow(8, 'No users found.')) + '</div>');
  const s = $('#userSearch'); let t; s.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { const pos = s.selectionStart; tabLoaders.users().then(() => { const n = $('#userSearch'); n.focus(); n.setSelectionRange(pos, pos); }); }, 350); });
};
acts['user-approve'] = (id, el) => run(el, async () => { await api('POST', `/admin/users/${id}/approve`, {}); loadView('admin'); }, 'User approved.');
acts['user-reject'] = (id, el) => confirmBox('Reject registration?', 'They will not be able to sign in. You can still approve them later.', 'Reject', async () => { await api('POST', `/admin/users/${id}/reject`, {}); toast('Registration rejected.'); loadView('admin'); }, false);
acts['user-suspend'] = (id, el) => confirmBox('Suspend user?', 'They are signed out at once and their hosting sessions are asked to stop.', 'Suspend', async () => { const r = await api('POST', `/admin/users/${id}/suspend`, {}); toast(`Suspended. Stop requested for ${r.stoppedSessions} session(s).`); loadView('admin'); }, false);
acts['user-restore'] = (id, el) => run(el, async () => { await api('POST', `/admin/users/${id}/restore`, {}); loadView('admin'); }, 'User restored.');
acts['user-reset'] = (id) => confirmBox('Reset password?', 'A temporary password is created and the user is signed out everywhere. You give it to them yourself.', 'Reset', async () => { const r = await api('POST', `/admin/users/${id}/reset-password`, {}); secretBox('Temporary password', 'Give this to the user. They must choose their own after signing in.', r.temporaryPassword); return false; }, false);
acts['user-delete'] = (id, el) => confirmBox('Delete user?', `${el.dataset.email} and everything they own will be permanently deleted.`, 'Delete user', async () => { await api('DELETE', '/admin/users/' + id); toast('User deleted.'); loadView('admin'); });

tabLoaders.eas = async () => {
  const r = await api('GET', '/eas?all=1'); state.eas = r.eas;
  adminBody(`<div class="panel"><div class="panel-head"><div><h3>All robots</h3><div class="panel-sub">Publish a robot to put it in the catalogue (a licence is then needed to host it).</div></div><button class="btn primary" data-act="ea-new">＋ Add robot</button></div>` +
    table(['Robot', 'Owner', 'Version', 'Visibility', 'Files', ''], r.eas.map((e) => `<tr><td><b>${esc(e.name)}</b></td><td>${esc(e.ownerEmail)}</td><td>${esc(e.version)}</td><td>${badge(e.status === 'published' ? 'ok' : '', e.status === 'published' ? 'PUBLISHED' : 'PRIVATE')}</td><td>${e.files}</td><td class="actions-cell">${btnA('ea-open', e.id, 'Open')}${btnA('ea-publish-row', e.id, e.status === 'published' ? 'Unpublish' : 'Publish', 'ghost', `data-to="${e.status === 'published' ? 'draft' : 'published'}"`)}${btnA('ea-delete', e.id, 'Delete', 'danger')}</td></tr>`).join('') || emptyRow(6, 'No robots yet.')) + '</div>');
};
acts['ea-publish-row'] = (id, el) => run(el, async () => { await api('POST', `/admin/eas/${id}/status`, { status: el.dataset.to }); loadView('admin'); }, 'Visibility updated.');

tabLoaders.files = async () => {
  const r = await api('GET', '/admin/files');
  adminBody(`<div class="panel"><div class="panel-head"><div><h3>EX5 files</h3><div class="panel-sub">${bytes(r.totalBytes)} stored in total. Files are private; only owners and you can download them.</div></div></div>` +
    table(['File', 'Robot', 'Owner', 'Size', 'Storage', 'Uploaded', ''], r.files.map((f) => `<tr><td>${esc(f.filename)}<span class="sub mono">${esc(f.sha256.slice(0, 16))}…</span></td><td>${esc(f.eaName)}</td><td>${esc(f.ownerEmail)}</td><td>${bytes(f.size)}</td><td>${esc(f.storage.toUpperCase())}</td><td>${fmtDay(f.uploadedAt)}</td><td class="actions-cell">${btnA('file-download', f.id, 'Download', 'ghost', `data-name="${esc(f.filename)}"`)}${btnA('file-delete', f.id, 'Delete', 'danger')}</td></tr>`).join('') || emptyRow(7, 'No files uploaded.')) + '</div>');
};

tabLoaders.accounts = async () => {
  const r = await api('GET', '/admin/accounts');
  adminBody(`<div class="panel"><div class="panel-head"><div><h3>MT5 account connections</h3><div class="panel-sub">Status as confirmed by the hosting machine. Passwords are never shown here.</div></div></div>` +
    table(['Owner', 'Account', 'Server', 'Type', 'Status', 'Snapshot'], r.accounts.map((a) => `<tr><td>${esc(a.userEmail)}</td><td>${esc(a.label || '')} <span class="mono">${esc(a.login)}</span></td><td>${esc(a.server)}</td><td>${esc(a.kind)}</td><td>${accountBadge(a.status)}<span class="sub">${esc(a.statusDetail)}</span></td><td>${a.info ? num(a.info.balance) + ' ' + esc(a.info.currency || '') + '<span class="sub">' + ago(a.infoAt) + '</span>' : '—'}</td></tr>`).join('') || emptyRow(6, 'No MT5 accounts saved.')) + '</div>');
};

tabLoaders.licences = async () => {
  const r = await api('GET', '/admin/licences');
  adminBody(`<div class="panel"><div class="panel-head"><div><h3>Licence keys</h3><div class="panel-sub">Keys are shown once when created. Only a hash is stored.</div></div><button class="btn primary" data-act="lic-new">＋ Create key</button></div>` +
    table(['Licence', 'Covers', 'Holder', 'Seats', 'Expires', 'Status', ''], r.licences.map((l) => `<tr><td class="mono">${esc(l.hint)}<span class="sub">${esc(l.label)}</span></td><td>${esc(l.eaName || 'Any published EA')}</td><td>${esc(l.userEmail || 'Not redeemed')}</td><td>${l.accountsUsed}/${l.maxAccounts}</td><td>${l.expiresAt ? fmtDay(l.expiresAt) : l.durationDays ? l.durationDays + ' days from first use' : 'Never'}</td><td>${licenceBadge(l.status)}</td><td class="actions-cell">${l.storedStatus === 'revoked' ? '' : (l.storedStatus === 'suspended' ? btnA('lic-restore', l.id, 'Restore') : btnA('lic-suspend', l.id, 'Suspend')) + btnA('lic-reset', l.id, 'Reset seats') + btnA('lic-revoke', l.id, 'Revoke', 'danger')}</td></tr>`).join('') || emptyRow(7, 'No licences created yet.')) + '</div>');
};
acts['lic-new'] = async () => {
  const eas = (await api('GET', '/eas?all=1')).eas.filter((e) => e.status === 'published');
  modal({ title: 'Create licence key', desc: 'The key is shown once after creating.', submit: 'Create key',
    fields: [
      { id: 'label', label: 'Label (e.g. client name)', placeholder: 'Bob trial', full: true },
      { id: 'eaId', label: 'Covers', type: 'select', full: true, options: [['', 'Any published EA'], ...eas.map((e) => [e.id, e.name])] },
      { id: 'maxAccounts', label: 'MT5 accounts allowed', type: 'number', value: 1, min: 1, max: 50 },
      { id: 'durationDays', label: 'Duration in days (empty = lifetime)', type: 'number', placeholder: '30', min: 1, max: 3650 },
      { id: 'startOn', label: 'Clock starts', type: 'select', options: [['first_use', 'When the client first uses it'], ['now', 'Now']] },
      { id: 'clientEmail', label: 'Client email (optional)', type: 'email', hint: 'Only used to open your own email app with the key; the server sends no email.' }],
    onSubmit: async (v) => {
      const r = await api('POST', '/admin/licences', { label: v.label, eaId: v.eaId || null, maxAccounts: Number(v.maxAccounts), durationDays: v.durationDays ? Number(v.durationDays) : null, startOn: v.startOn });
      loadView('admin');
      const subject = encodeURIComponent('Your EA LUBHO licence key'), body = encodeURIComponent(`Your licence key:\n\n${r.key}\n\nSign in to EA LUBHO, open Licence Centre and press Redeem.`);
      setTimeout(() => secretBox('Licence key created', 'Copy it or send it to the client.', r.key, `<div class="form-actions" style="justify-content:flex-start"><a class="btn" href="mailto:${encodeURIComponent(v.clientEmail || '')}?subject=${subject}&body=${body}">Send by email (opens your email app)</a></div>`), 50);
      return true;
    } });
};
for (const [a, path, msg] of [['lic-suspend', 'suspend', 'Licence suspended.'], ['lic-restore', 'restore', 'Licence restored.'], ['lic-reset', 'reset-accounts', 'MT5 seats cleared.']]) acts[a] = (id, el) => run(el, async () => { await api('POST', `/admin/licences/${id}/${path}`, {}); loadView('admin'); }, msg);
acts['lic-revoke'] = (id) => confirmBox('Revoke licence?', 'This cannot be undone.', 'Revoke', async () => { await api('POST', `/admin/licences/${id}/revoke`, {}); loadView('admin'); });

tabLoaders.hosts = async () => {
  const r = await api('GET', '/admin/hosts');
  adminBody(`<div class="panel"><div class="panel-head"><div><h3>Hosting machines</h3><div class="panel-sub">Windows computers running MT5 and the EA LUBHO agent. Online = reported in within 90 seconds.</div></div><button class="btn primary" data-act="host-new">＋ Add machine</button></div>` +
    table(['Machine', 'Status', 'Last seen', 'Agent', 'Active sessions', ''], r.hosts.map((h) => `<tr><td><b>${esc(h.name)}</b><span class="sub">${esc(h.info?.os || '')}${h.info ? (h.info.mt5Found ? '' : ' · MT5 not found') : ''}</span></td><td>${badge(h.online ? 'ok' : 'warn', h.online ? 'ONLINE' : h.lastSeen ? 'OFFLINE' : 'NEVER CONNECTED')}${h.info?.simulated ? ' ' + badge('sim', 'SIMULATED') : ''}</td><td>${ago(h.lastSeen)}</td><td>${esc(h.agentVersion || '—')}</td><td>${h.activeSessions}</td><td class="actions-cell">${btnA('host-rename', h.id, 'Rename', 'ghost', `data-name="${esc(h.name)}"`)}${btnA('host-rotate', h.id, 'New token')}${btnA('host-delete', h.id, 'Delete', 'danger', `data-name="${esc(h.name)}"`)}</td></tr>`).join('') || emptyRow(6, 'No hosting machine yet. Add one, then install the agent on the Windows computer.')) + '<div class="notice">See agent/README.md in the project for the Windows setup steps.</div></div>');
};
const hostSnippet = (token) => `<p class="sub">Put this in the agent's <b>config.json</b> on the Windows machine:</p><pre class="mono" style="white-space:pre-wrap;background:#06111d;border:1px solid #28455d;border-radius:10px;padding:10px;font-size:11px">{\n  "serverUrl": "${esc(location.origin)}",\n  "token": "${esc(token)}"\n}</pre>`;
acts['host-new'] = () => modal({ title: 'Add hosting machine', fields: [{ id: 'name', label: 'Name', required: true, placeholder: 'HP laptop', full: true }], submit: 'Create',
  onSubmit: async (v) => { const r = await api('POST', '/admin/hosts', v); loadView('admin'); setTimeout(() => secretBox('Host token', 'Keep this token private: it lets a machine collect MT5 passwords for its tasks.', r.token, hostSnippet(r.token)), 50); return true; } });
acts['host-rotate'] = (id) => confirmBox('Create a new token?', 'The old token stops working immediately. Update config.json on the machine.', 'New token', async () => { const r = await api('POST', `/admin/hosts/${id}/rotate-token`, {}); setTimeout(() => secretBox('New host token', '', r.token, hostSnippet(r.token)), 50); return true; }, false);
acts['host-rename'] = (id, el) => modal({ title: 'Rename machine', fields: [{ id: 'name', label: 'Name', value: el.dataset.name, required: true, full: true }], submit: 'Save', onSubmit: async (v) => { await api('PATCH', '/admin/hosts/' + id, v); loadView('admin'); } });
acts['host-delete'] = (id, el) => confirmBox('Delete machine?', `${el.dataset.name} will no longer be able to connect.`, 'Delete', async () => { await api('DELETE', '/admin/hosts/' + id); loadView('admin'); });

tabLoaders.sessions = async () => {
  const r = await api('GET', '/admin/sessions');
  adminBody(`<div class="panel"><div class="panel-head"><div><h3>All hosting sessions</h3><div class="panel-sub">Status is what the hosting machine last confirmed. "Unknown" means the machine stopped reporting.</div></div></div>` +
    table(['User', 'Robot', 'Account', 'Machine', 'Status', 'Updated', ''], r.sessions.map((s) => `<tr><td>${esc(s.userEmail)}</td><td>${esc(s.eaName || '—')}</td><td class="mono">${esc(s.accountLogin || '—')}</td><td>${esc(s.hostName || '—')}</td><td>${sessionBadge(s.status)}<span class="sub">${esc(s.detail)}</span></td><td>${s.lastReportAt ? ago(s.lastReportAt) : fmt(s.createdAt)}</td><td class="actions-cell">${['requested', 'starting', 'running', 'unknown'].includes(s.status) ? btnA('admin-session-stop', s.id, 'Stop', 'danger') : ''}</td></tr>`).join('') || emptyRow(7, 'No sessions.')) + '</div>');
};
acts['admin-session-stop'] = (id, el) => run(el, async () => { await api('POST', `/admin/sessions/${id}/stop`, {}); loadView('admin'); }, 'Stop requested.');

tabLoaders.logs = async () => {
  const q = $('#logSearch')?.value || '';
  const r = await api('GET', '/admin/logs?limit=100&q=' + encodeURIComponent(q)); state.logs = r.logs;
  adminBody(`<div class="panel"><div class="panel-head"><div><h3>Activity log</h3><div class="panel-sub">Newest first. Secrets are never logged.</div></div><input id="logSearch" class="search" style="padding:9px;border:1px solid #28455d;border-radius:10px;background:#081827;color:#fff" placeholder="Search action, email, detail" value="${esc(q)}"></div>` +
    table(['Time', 'Who', 'Action', 'Detail', 'IP'], r.logs.map((l) => `<tr><td>${fmt(l.createdAt)}</td><td>${esc(l.actor)}</td><td class="mono">${esc(l.action)}</td><td>${esc(l.detail)}</td><td class="mono">${esc(l.ip)}</td></tr>`).join('') || emptyRow(5, 'Nothing logged.')) + '</div>');
  const s = $('#logSearch'); let t; s.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { const pos = s.selectionStart; tabLoaders.logs().then(() => { const n = $('#logSearch'); n.focus(); n.setSelectionRange(pos, pos); }); }, 350); });
};

// ---------- install prompt, service worker ----------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('#installSide').hidden = false; });
$('#installSide').onclick = async () => { if (!installPrompt) return toast('Use your browser menu and choose Install app or Add to Home Screen.'); installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('#installSide').hidden = true; };
window.addEventListener('appinstalled', () => { $('#installSide').hidden = true; });
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));


// ---------- charts (plain SVG, no libraries) ----------
function lineChart(points, fmtY = (v) => num(v)) {
  const pts = points.filter((p) => Number.isFinite(p.v));
  if (pts.length < 2) return '<div class="empty"><strong>Not enough data yet</strong>A line appears after the host has reported at least two snapshots.</div>';
  const W = 640, H = 190, L = 58, R = 12, T = 12, B = 26;
  const xs = pts.map((p) => p.t), ys = pts.map((p) => p.v);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = (y1 - y0) * 0.08 || Math.abs(y1) * 0.01 || 1;
  const lo = y0 - pad, hi = y1 + pad;
  const X = (t) => L + ((t - x0) / (x1 - x0 || 1)) * (W - L - R), Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const line = pts.map((p) => `${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart"><line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="ax"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="ax"/>
    <text x="${L - 6}" y="${T + 8}" class="tx" text-anchor="end">${esc(fmtY(hi))}</text><text x="${L - 6}" y="${H - B}" class="tx" text-anchor="end">${esc(fmtY(lo))}</text>
    <text x="${L}" y="${H - 8}" class="tx">${esc(fmt(x0))}</text><text x="${W - R}" y="${H - 8}" class="tx" text-anchor="end">${esc(fmt(x1))}</text>
    <polyline points="${line}" fill="none" stroke="#20b8f2" stroke-width="2.2" stroke-linejoin="round"/></svg>`;
}
function barChart(items, unit = '') {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length || items.every((i) => !i.value)) return '<div class="empty"><strong>No data yet</strong>Bars appear once there is activity to count.</div>';
  const W = 640, H = 170, L = 30, B = 24, bw = (W - L - 8) / items.length;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart"><line x1="${L}" y1="${H - B}" x2="${W - 4}" y2="${H - B}" class="ax"/><text x="${L - 4}" y="14" class="tx" text-anchor="end">${max}</text><text x="${L - 4}" y="${H - B}" class="tx" text-anchor="end">0</text>` +
    items.map((i, k) => { const h = (i.value / max) * (H - B - 18); const x = L + k * bw + bw * 0.15; return `<rect x="${x.toFixed(1)}" y="${(H - B - h).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="#20b8f2"><title>${esc(i.label)}: ${i.value}${esc(unit)}</title></rect>`; }).join('') +
    `<text x="${L}" y="${H - 8}" class="tx">${esc(items[0].label)}</text><text x="${W - 4}" y="${H - 8}" class="tx" text-anchor="end">${esc(items[items.length - 1].label)}</text></svg>`;
}
const hours = (sec) => (sec < 3600 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} h`);
const pl = (v) => (Number.isFinite(v) ? `<span style="color:${v >= 0 ? '#35d07f' : '#ff7b7b'}">${v >= 0 ? '+' : ''}${num(v)}</span>` : '—');

// ---------- Client Trading Configuration ----------
const TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN1'];
function configFields(c) {
  return [
    { id: 'symbol', label: 'Symbol (optional)', value: c.symbol || '', placeholder: 'e.g. XAUUSD.m', hint: 'Chart the EA is attached to. Must match your broker\'s symbol. Blank uses the host default.' },
    { id: 'timeframe', label: 'Timeframe', type: 'select', options: TIMEFRAMES, value: c.timeframe || 'M1' },
    { id: 'presetFile', label: 'Preset file (.set, optional)', type: 'file', accept: '.set,text/plain', full: true, hint: 'EA input values exported from MetaTrader (max 20 KB). Stored privately.' },
    ...(c.hasPreset ? [{ id: 'clearPreset', label: 'Existing preset', type: 'select', full: true, options: [['keep', `Keep ${c.presetName}`], ['clear', 'Remove it']], value: 'keep' }] : []),
  ];
}
async function configBody(v) {
  const body = { symbol: (v.symbol || '').trim(), timeframe: v.timeframe };
  if (v.presetFile) {
    if (v.presetFile.size > 20000) throw new Error('The preset file is too large (max 20 KB).');
    body.preset = await v.presetFile.text(); body.presetName = v.presetFile.name;
  } else if (v.clearPreset === 'clear') body.preset = '';
  return body;
}
loaders.config = async () => {
  const [ses, acc, p] = await Promise.all([api('GET', '/sessions'), api('GET', '/accounts'), loadPlatform()]);
  state.sessions = ses.sessions;
  const liveOk = p?.liveAccountsAllowed;
  $('#configBody').innerHTML = `<div class="notice blue">These settings tell the hosting machine how to start your EA in MetaTrader. EA LUBHO hosts and monitors your robot — it does not place, manage or advise on trades. Your EA makes all trading decisions.</div>
  <div class="panel" style="margin-top:14px"><div class="panel-head"><div><h3>Hosting configuration per session</h3><div class="panel-sub">Edit a configuration while its session is stopped or failed, then start it again.</div></div><button class="btn primary" data-act="session-new">＋ New hosting session</button></div>` +
    table(['Robot', 'Account', 'Symbol', 'Timeframe', 'Preset', 'Status', ''], ses.sessions.map((s) => `<tr><td><b>${esc(s.eaName || 'Removed EA')}</b></td><td>${esc(s.accountLabel || s.accountLogin || '—')}</td><td>${esc(s.symbol || 'host default')}</td><td>${esc(s.timeframe)}</td><td>${s.hasPreset ? esc(s.presetName) : '—'}</td><td>${sessionBadge(s.status)}</td><td class="actions-cell">${['stopped', 'failed'].includes(s.status) ? btnA('config-edit', s.id, 'Edit') + btnA('session-restart', s.id, 'Start', 'primary') : ''}</td></tr>`).join('') || emptyRow(7, 'No hosting sessions yet. Press "New hosting session".')) + '</div>' +
    `<div class="panel" style="margin-top:14px"><div class="panel-head"><div><h3>Broker accounts</h3><div class="panel-sub">Demo and live accounts from any MT5 broker. ${liveOk ? 'Live accounts are enabled.' : 'Live (real-money) accounts are switched off while the platform is being tested: use demo accounts.'}</div></div><button class="btn" data-go="brokers">Manage accounts</button></div>` +
    table(['Broker server', 'Account', 'Type', 'Status'], acc.accounts.map((a) => `<tr><td>${esc(a.server)}</td><td>${esc(a.label || '')} <span class="mono">${esc(a.login)}</span></td><td>${badge(a.kind === 'live' ? 'warn' : '', a.kind.toUpperCase())}</td><td>${accountBadge(a.status)}</td></tr>`).join('') || emptyRow(4, 'No MT5 accounts yet.')) + '</div>';
};
acts['config-edit'] = (id) => {
  const s = state.sessions.find((x) => x.id === id); if (!s) return;
  modal({ title: `Configuration · ${s.eaName || 'EA'}`, desc: `${s.accountLabel || s.accountLogin}. Applied the next time this session starts.`, fields: configFields(s), submit: 'Save configuration',
    onSubmit: async (v) => { await api('PATCH', `/sessions/${id}/config`, await configBody(v)); toast('Configuration saved.'); loadView('config'); } });
};

// ---------- Live Trade Monitor ----------
loaders.trades = async () => {
  const [a, s, m] = await Promise.all([api('GET', '/accounts'), api('GET', '/sessions'), api('GET', '/monitor')]);
  $('#tmConnected').textContent = a.accounts.filter((x) => x.status === 'connected').length;
  $('#tmRunning').textContent = s.sessions.filter((x) => x.status === 'running').length;
  const fresh = m.items.filter((i) => i.snapshot && !i.stale);
  const posCount = fresh.reduce((n, i) => n + i.snapshot.positions.length, 0);
  const floating = fresh.reduce((n, i) => n + (i.floatingProfit || 0), 0);
  $('#tmPositions').textContent = fresh.length ? posCount : '—';
  $('#tmPositionsNote').textContent = fresh.length ? `Across ${fresh.length} account(s)` : 'Awaiting host report';
  $('#tmFloating').innerHTML = fresh.length ? pl(floating) : '—';
  const fb = $('#tmFeedBadge');
  if (!m.items.length) { fb.className = 'badge off'; fb.textContent = 'NO RUNNING SESSION'; }
  else if (!m.items.some((i) => i.snapshot)) { fb.className = 'badge warn'; fb.textContent = 'WAITING FOR HOST REPORT'; }
  else if (!fresh.length) { fb.className = 'badge warn'; fb.textContent = 'REPORTS ARE OLD'; }
  else { fb.className = 'badge ok'; fb.textContent = 'REPORTED BY HOST'; }
  $('#monitorCards').innerHTML = m.items.map((i) => {
    const sn = i.snapshot;
    const body = !sn ? '<div class="empty"><strong>No report from the host yet</strong>Balance and positions appear here after the hosting machine reports them. Nothing is estimated.</div>'
      : `<div class="grid stats" style="margin-bottom:10px"><div class="stat"><div class="stat-head">BALANCE</div><div class="stat-value">${num(sn.balance)}</div><div class="stat-note">${esc(sn.currency)}</div></div><div class="stat"><div class="stat-head">EQUITY</div><div class="stat-value">${num(sn.equity)}</div><div class="stat-note">${esc(sn.currency)}</div></div><div class="stat"><div class="stat-head">MARGIN</div><div class="stat-value">${num(sn.margin)}</div><div class="stat-note">Free ${num(sn.freeMargin)}</div></div><div class="stat"><div class="stat-head">FLOATING P/L</div><div class="stat-value">${pl(i.floatingProfit)}</div><div class="stat-note">${sn.positions.length} open position(s)</div></div></div>` +
        table(['Ticket', 'Symbol', 'Type', 'Volume', 'Open price', 'Profit', 'Opened'], sn.positions.map((p) => `<tr><td class="mono">${esc(p.ticket)}</td><td>${esc(p.symbol)}</td><td>${esc(String(p.type).toUpperCase())}</td><td>${num(p.volume)}</td><td>${num(p.openPrice, 5)}</td><td>${pl(p.profit)}</td><td>${p.openedAt ? fmt(p.openedAt) : '—'}</td></tr>`).join('') || emptyRow(7, 'No open positions reported.'));
    return `<div class="panel" style="margin-top:14px"><div class="panel-head"><div><h3>${esc(i.eaName || 'EA')} · ${esc(i.accountLabel)}</h3><div class="panel-sub">${esc(i.server)} · ${esc(i.kind)} · reported ${sn ? ago(sn.at) : 'never'}</div></div><div>${sessionBadge(i.sessionStatus)} ${sn && i.stale ? badge('warn', 'OLD REPORT') : ''}</div></div>${body}</div>`;
  }).join('');
  $('#snapshotTable').innerHTML = a.accounts.map((x) => `<tr><td>${esc(x.label || x.login)} · ${esc(x.login)}</td><td>${esc(x.server)}</td><td>${x.info ? num(x.info.balance) : '—'}</td><td>${x.info ? num(x.info.equity) : '—'}</td><td>${esc(x.info?.currency || '—')}</td><td>${x.infoAt ? fmt(x.infoAt) : 'No snapshot'}</td></tr>`).join('') || emptyRow(6, 'No MT5 accounts yet.');
};

// ---------- Analytics Centre (counted from stored data) ----------
loaders.analytics = async () => {
  const [u, ad] = await Promise.all([api('GET', '/analytics'), isAdmin() ? api('GET', '/admin/analytics') : null]);
  const a = u.analytics;
  let html = `<div class="grid stats">${stat('HOSTING SESSIONS', a.sessions.total, `${a.sessions.failed} failed · ${a.sessions.stopped} stopped`)}${stat('RUNNING NOW', a.sessions.running, 'Confirmed by the host')}${stat('HOSTED TIME', hours(a.sessions.hostedSeconds), 'Across all your sessions')}${stat('EX5 STORAGE', bytes(a.storageBytes), `${a.files} file(s)`)}${stat('ACTIVE LICENCES', a.licences.active, a.licences.nextExpiry ? `Next expires ${fmtDay(a.licences.nextExpiry)}` : `${a.licences.total} in total`)}</div>`;
  html += `<div class="panel" style="margin-top:14px"><div class="panel-head"><div><h3>Account equity (last 14 days)</h3><div class="panel-sub">From snapshots reported by the hosting machine while a session was running.</div></div></div>` +
    (a.equity.length ? a.equity.map((e) => `<div class="panel-sub" style="margin:10px 0 4px"><b>${esc(e.label)}</b> · ${esc(e.login)}</div>${lineChart(e.points.map((p) => ({ t: p.at, v: p.equity })))}`).join('') : '<div class="empty"><strong>No equity history yet</strong>It appears after a hosting session has been running and the host has reported snapshots.</div>') + '</div>';
  html += `<div class="panel" style="margin-top:14px"><div class="panel-head"><div><h3>Sessions per robot</h3></div></div>${barChart(a.byEa.map((e) => ({ label: e.name, value: e.sessions })))}</div>`;
  html += `<div class="notice blue" style="margin-top:14px">Trade history, win rate and profit statistics are not collected: EA LUBHO does not record individual trades. Everything above is counted from stored hosting data.</div>`;
  if (ad) {
    const p = ad.analytics;
    html += `<h3 style="margin:22px 0 8px">Platform (Super Admin)</h3><div class="grid stats">${stat('SESSIONS EVER', p.sessionsTotal, `${p.sessionsFailed} failed`)}${stat('HOSTED TIME', hours(p.hostedSeconds), 'All users')}${stat('EX5 STORAGE', bytes(p.storageBytes), 'All users')}</div>
    <div class="grid two-col" style="margin-top:14px"><div class="panel"><div class="panel-head"><h3>New members per day (30 days)</h3></div>${barChart(p.registrations.map((d) => ({ label: d.day.slice(5), value: d.count })))}</div>
    <div class="panel"><div class="panel-head"><h3>Hosting sessions created per day (30 days)</h3></div>${barChart(p.sessionsCreated.map((d) => ({ label: d.day.slice(5), value: d.count })))}</div></div>
    <div class="panel" style="margin-top:14px"><div class="panel-head"><h3>Most hosted robots</h3></div>${table(['Robot', 'Sessions'], p.topEas.map((e) => `<tr><td>${esc(e.name)}</td><td>${e.sessions}</td></tr>`).join('') || emptyRow(2, 'No sessions yet.'))}</div>`;
  }
  $('#analyticsBody').innerHTML = html;
};

// ---------- Profile & Settings ----------
loaders.settings = async () => {
  const u = state.user;
  $('#settingsBody').innerHTML = `<div class="grid two-col"><div class="panel"><div class="panel-head"><div><h3>Profile</h3><div class="panel-sub">Your account on EA LUBHO</div></div></div>
    <div class="form-grid"><div class="field"><label>NAME</label><input value="${esc(u.name)}" readonly></div><div class="field"><label>EMAIL</label><input value="${esc(u.email)}" readonly></div><div class="field"><label>ROLE</label><input value="${u.role === 'super_admin' ? 'Super Admin' : 'Member'}" readonly></div><div class="field"><label>STATUS</label><input value="${esc(u.status)}" readonly></div></div>
    <div class="form-actions" style="justify-content:flex-start;flex-wrap:wrap"><button class="btn primary" data-act="account">Edit name</button><button class="btn" data-act="change-password">Change password</button><button class="btn" data-act="logout">Sign out</button></div></div>
  <div class="panel"><div class="panel-head"><div><h3>App</h3><div class="panel-sub">Install EA LUBHO on your phone or computer</div></div></div>
    <div class="list"><div class="row-card"><div class="row-main"><b>Install app</b><small>Android: use the install button or the browser menu. iPhone: Share → Add to Home Screen.</small></div><button class="btn" data-act="install-app">Install</button></div>
    <div class="row-card"><div class="row-main"><b>Offline</b><small>The app shell opens without internet. Hosting data always needs a connection.</small></div></div></div>
    <div class="notice blue">EA LUBHO manages and hosts your Expert Advisors. It does not trade, give financial advice or guarantee results. Test with a demo account first.</div></div></div>
  ${u.role === 'super_admin' ? '' : `<div class="panel" style="margin-top:14px"><div class="panel-head"><div><h3>Delete account</h3><div class="panel-sub">Removes your robots, files and saved MT5 accounts. Stop all hosting sessions first.</div></div><button class="btn danger" data-act="delete-me">Delete my account</button></div></div>`}`;
};
acts['install-app'] = () => $('#installSide').click();

// ---------- Super Admin: platform settings ----------
tabLoaders.settings = async () => {
  const r = (await api('GET', '/admin/settings')).settings;
  adminBody(`<div class="panel"><div class="panel-head"><div><h3>Platform settings</h3><div class="panel-sub">Rules for the whole platform.</div></div></div><div class="list">
    <div class="row-card">${badge(r.requireApproval ? 'ok' : 'warn', r.requireApproval ? 'ON' : 'OFF')}<div class="row-main"><b>Approve new members</b><small>${r.requireApproval ? 'New registrations wait for you to approve them in the Users tab.' : 'Anyone who registers can sign in straight away.'}</small></div>${btnA('setting-approval', 'x', r.requireApproval ? 'Turn off' : 'Turn on', 'ghost', `data-to="${r.requireApproval ? 'off' : 'on'}"`)}</div>
    <div class="row-card">${badge(r.liveAccountsAllowed ? 'warn' : 'ok', r.liveAccountsAllowed ? 'ALLOWED' : 'OFF')}<div class="row-main"><b>Live (real-money) broker accounts</b><small>${r.liveAccountsAllowed ? 'Members can save live accounts. Make sure the security review is finished.' : 'Off while testing. Controlled by the ALLOW_LIVE_ACCOUNTS variable in Cloudflare, not from this page.'}</small></div></div>
  </div></div>`);
};
acts['setting-approval'] = (id, el) => run(el, async () => { await api('PUT', '/admin/settings', { requireApproval: el.dataset.to === 'on' }); loadView('admin'); }, 'Setting saved.');

// ---------- live refresh ----------
setInterval(() => {
  if (!state.user || document.hidden || modalOpen() || state.loading) return;
  if (['overview', 'brokers', 'trades', 'hosting', 'notifications', 'config'].includes(state.view) || (state.view === 'admin' && ['dashboard', 'hosts', 'sessions', 'accounts'].includes(state.adminTab))) loadView(state.view, true);
}, 10000);
setInterval(() => { if (state.user && !document.hidden) { refreshNotifDot(); loadPlatform(); } }, 30000);

boot();
