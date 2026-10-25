const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));
let S = { profiles: [], activeId: null, connected: false, mode: 'all', sites: [], port: 10808 };
let busy = false;

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
const save = (patch) => { Object.assign(S, patch); return chrome.storage.local.set(patch); };
const active = () => S.profiles.find((p) => p.id === S.activeId);

function showErr(el, text) { el.textContent = text || ''; el.hidden = !text; }

/* ---------- рендер ---------- */
function render() {
  const app = $('#app');
  const st = busy ? 'busy' : S.connected ? 'on' : 'off';
  app.dataset.state = st;
  $('#power').checked = S.connected;
  $('#swText').textContent = S.connected ? 'ВКЛ' : 'ВЫКЛ';

  const a = active();
  $('#chipText').textContent = a ? a.parsed.host + ' · ' + a.parsed.port : 'нет сервера';

  if (busy) {
    $('#title').textContent = S.connected ? 'Отключаюсь…' : 'Подключаюсь…';
    $('#sub').innerHTML = 'Запускаю защищённый канал.<br>Это займёт пару секунд.';
    $('#cta').textContent = 'Подождите…';
  } else if (S.connected) {
    $('#title').textContent = 'Защита включена';
    $('#sub').innerHTML = (S.mode === 'list' ? 'Через VPN идут выбранные сайты.' : 'Весь трафик браузера зашифрован.') +
      '<br>Сервер: ' + esc(a ? a.parsed.host : '') + '';
    $('#cta').textContent = 'Выключить VPN';
  } else {
    $('#title').textContent = 'Защита отключена';
    $('#sub').innerHTML = 'Соединение не шифруется.<br>Ваш IP и местоположение доступны третьим лицам.';
    $('#cta').textContent = 'Включить VPN';
  }

  // режимы
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
  $('#sitesField').hidden = S.mode !== 'list';
  $('#portInput').value = S.port;

  // теги сайтов
  $('#sites').innerHTML = S.sites.map((s) => `<li>${esc(s)}<button data-site="${esc(s)}">✕</button></li>`).join('');
  // серверы
  $('#serversEmpty').hidden = S.profiles.length > 0;
  $('#servers').innerHTML = S.profiles.map((p) => `
    <li data-id="${p.id}" class="${p.id === S.activeId ? 'sel' : ''}">
      <span class="dot" style="${p.id === S.activeId ? 'background:var(--green2)' : ''}"></span>
      <div class="nm"><b>${esc(p.parsed.name)}</b><small>${esc(p.parsed.host)}:${p.parsed.port} · ${esc(p.parsed.security)}/${esc(p.parsed.network)}</small></div>
      <button class="del" data-del="${p.id}" title="Удалить">✕</button>
    </li>`).join('');
  updateRuleLink();
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let curHost = '';
async function updateRuleLink() {
  const l = $('#addRule');
  const inList = curHost && S.sites.some((s) => s === curHost);
  l.hidden = !(S.mode === 'list' && curHost && !inList);
  $('#ruleHost').textContent = curHost;
}
async function detectTab() {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = new URL(t.url);
    if (/^https?:$/.test(u.protocol)) curHost = u.hostname.replace(/^www\./, '');
  } catch (e) {}
}

/* ---------- действия ---------- */
async function toggle() {
  if (busy) return;
  showErr($('#err'), '');
  busy = true; render();
  const r = S.connected ? await send({ type: 'disconnect' }) : await send({ type: 'connect' });
  busy = false;
  const fresh = await send({ type: 'state' });
  Object.assign(S, fresh);
  if (r && !r.ok) {
    showErr($('#err'), r.hostMissing
      ? 'Не найден локальный помощник. Запустите install-windows.bat из папки host (один раз) и перезапустите браузер.'
      : (r.error || 'Не удалось подключиться'));
  }
  render();
}

async function addLink(raw) {
  showErr($('#addErr'), '');
  try {
    const parsed = Vless.parseVless(raw);
    const exists = S.profiles.find((p) => p.parsed.id === parsed.id && p.parsed.host === parsed.host && p.parsed.port === parsed.port);
    if (exists) { await save({ activeId: exists.id }); }
    else {
      const p = { id: uid(), parsed };
      await save({ profiles: S.profiles.concat(p), activeId: p.id });
    }
    $('#linkInput').value = '';
    render();
  } catch (e) { showErr($('#addErr'), e.message); }
}

async function addSite(raw) {
  let h = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) && !/^\d+\.\d+\.\d+\.\d+$/.test(h)) return;
  if (!S.sites.includes(h)) await save({ sites: S.sites.concat(h) });
  $('#siteInput').value = '';
  if (S.connected) send({ type: 'reapply' });
  render();
}

/* ---------- события ---------- */
document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.nav').forEach((n) => n.classList.toggle('active', n === b));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== 'view-' + b.dataset.view));
  if (b.dataset.view === 'settings') checkHelper();
}));
$('#cta').addEventListener('click', toggle);
$('#power').addEventListener('click', (e) => { e.preventDefault(); toggle(); });
$('#chipServer').addEventListener('click', () => document.querySelector('.nav[data-view=servers]').click());
$('#btnAdd').addEventListener('click', () => addLink($('#linkInput').value));
$('#btnPaste').addEventListener('click', async () => {
  try { const t = await navigator.clipboard.readText(); $('#linkInput').value = t; addLink(t); }
  catch (e) { showErr($('#addErr'), 'Браузер не дал доступ к буферу — вставьте ссылку вручную (Ctrl+V).'); }
});
$('#linkInput').addEventListener('paste', (e) => {
  const t = (e.clipboardData || window.clipboardData).getData('text');
  if (/vless:\/\//i.test(t)) { e.preventDefault(); $('#linkInput').value = t; addLink(t); }
});
$('#servers').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    const id = del.dataset.del;
    const was = S.activeId === id;
    if (was && S.connected) await send({ type: 'disconnect' });
    const profiles = S.profiles.filter((p) => p.id !== id);
    await save({ profiles, activeId: was ? (profiles[0] && profiles[0].id) || null : S.activeId, connected: was ? false : S.connected });
    return render();
  }
  const li = e.target.closest('li[data-id]');
  if (li && li.dataset.id !== S.activeId) {
    await save({ activeId: li.dataset.id });
    if (S.connected) { busy = true; render(); await send({ type: 'connect', id: li.dataset.id }); busy = false; Object.assign(S, await send({ type: 'state' })); }
    render();
  }
});
$('#modeSeg').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  await save({ mode: b.dataset.mode });
  if (S.connected) send({ type: 'reapply' });
  render();
});
$('#siteAdd').addEventListener('click', () => addSite($('#siteInput').value));
$('#siteInput').addEventListener('keydown', (e) => e.key === 'Enter' && addSite(e.target.value));
$('#sites').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-site]'); if (!b) return;
  await save({ sites: S.sites.filter((s) => s !== b.dataset.site) });
  if (S.connected) send({ type: 'reapply' });
  render();
});
$('#addRule').addEventListener('click', () => addSite(curHost));
$('#portInput').addEventListener('change', async (e) => {
  const p = parseInt(e.target.value, 10);
  if (p >= 1024 && p <= 65535) await save({ port: p });
});

async function checkHelper() {
  const h = $('#helper'), t = $('#helperText');
  const r = await send({ type: 'ping' });
  h.classList.toggle('ok', !!(r && r.ok && r.xray));
  h.classList.toggle('bad', !(r && r.ok && r.xray));
  if (!r || !r.ok) t.textContent = 'не установлен — запустите install из папки host';
  else if (!r.xray) t.textContent = 'помощник есть, но xray не найден (' + (r.hint || 'положите xray в host/bin') + ')';
  else t.textContent = 'готов · ' + r.xray;
}

(async () => {
  Object.assign(S, await send({ type: 'state' }));
  await detectTab();
  render();
})();
