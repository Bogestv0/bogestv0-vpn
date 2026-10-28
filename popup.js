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
  loadNet();
}

async function addLink(raw) {
  showErr($('#addErr'), '');
  if (/^\s*https?:\/\//i.test(raw)) {   // ссылка-подписка: одна на все устройства
    const r = await send({ type: 'addsub', url: raw });
    if (!r || !r.ok) return showErr($('#addErr'), (r && r.error) || 'Не удалось добавить подписку');
    Object.assign(S, await send({ type: 'state' }));
    $('#linkInput').value = '';
    return render();
  }
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

/* ---------- IP, пинг ---------- */
async function ipOf(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 5000);
  try { const r = await fetch(url, { cache: 'no-store', signal: c.signal }); const j = await r.json(); return /^[0-9a-f:.]{3,45}$/i.test(j.ip || '') ? j.ip : null; }
  catch (e) { return null; } finally { clearTimeout(t); }
}
let netBusy = false;
function setNet(id, text, cls) { const e = $(id); e.textContent = text; e.title = text; e.className = cls || ''; }
async function loadNet() {
  if (netBusy) return; netBusy = true;
  ['#ip4', '#ip6', '#pingV'].forEach((i) => setNet(i, '…'));
  const a = active();
  const [v4, v6, pg] = await Promise.all([
    ipOf('https://api.ipify.org?format=json'), ipOf('https://api6.ipify.org?format=json'),
    a ? send({ type: 'tcping', host: a.parsed.host, port: a.parsed.port }) : Promise.resolve(null)
  ]);
  setNet('#ip4', v4 || 'нет'); setNet('#ip6', v6 || 'нет');
  if (!a) setNet('#pingV', '—');
  else if (pg && pg.ok) setNet('#pingV', pg.ms + ' мс', pg.ms < 100 ? 'good' : pg.ms < 250 ? 'mid' : 'bad');
  else if (pg && pg.hostMissing) setNet('#pingV', 'нет помощника');
  else setNet('#pingV', 'нет ответа', 'bad');
  netBusy = false;
}

/* ---------- обновления ---------- */
let updInfo = null;
async function loadUpdate(force) {
  const u = await send({ type: 'update', force: !!force });
  updInfo = u; $('#verText').textContent = 'v' + (u && u.current || '');
  const box = $('#upd');
  if (u && u.available) {
    $('#updTitle').textContent = 'Доступна версия ' + u.latest;
    $('#updText').textContent = 'У вас ' + u.current + '. Хотите обновить?';
    box.hidden = false;
  } else box.hidden = true;
  return u;
}
$('#updGo').addEventListener('click', () => {
  if (!updInfo || !/^https:\/\/(github\.com|objects\.githubusercontent\.com)\//.test(updInfo.url || '')) return;
  chrome.tabs.create({ url: updInfo.url });
  $('#updText').textContent = 'Запустите скачанный установщик, затем перезапустите браузер.';
});
$('#updSkip').addEventListener('click', async () => { if (updInfo) await send({ type: 'updskip', tag: updInfo.tag }); $('#upd').hidden = true; });
$('#updCheck').addEventListener('click', async () => {
  const b = $('#updCheck'); b.disabled = true; b.textContent = 'Проверяю…';
  const u = await loadUpdate(true);
  if (u && !u.available) { const l = (u.latest && cmpv(u.latest, u.current) > 0) ? 'Вы отложили версию ' + u.latest : 'У вас последняя версия'; $('#verText').textContent = 'v' + u.current + ' · ' + l; }
  b.disabled = false; b.textContent = 'Проверить обновления';
});
const cmpv = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1; return 0; };

/* ---------- DNS ---------- */
async function dnsRefresh() {
  const r = await send({ type: 'dns', action: 'status' });
  const st = $('#dnsState');
  if (!r || r.hostMissing) { st.textContent = 'Нужен локальный помощник — запустите установщик.'; st.className = 'dnsState'; return; }
  if (!r.ok) { st.textContent = r.error === 'unknown cmd' ? 'Нужна новая версия помощника — скачайте и запустите свежий установщик.' : (r.error || ''); st.className = 'dnsState'; $('#dnsFix').disabled = r.error === 'unknown cmd'; return; }
  st.textContent = r.fixed ? 'DNS сейчас: Cloudflare + Google (1.1.1.1 / 8.8.8.8)' : 'DNS сейчас: настройки провайдера / по умолчанию';
  st.className = 'dnsState' + (r.fixed ? ' ok' : '');
  $('#dnsRestore').hidden = !(r.fixed || r.hasBackup);
  $('#dnsFix').textContent = r.fixed ? 'Применить заново' : 'Исправить DNS';
}
async function dnsDo(action) {
  const b = action === 'fix' ? $('#dnsFix') : $('#dnsRestore'), old = b.textContent;
  showErr($('#dnsErr'), ''); $('#dnsFix').disabled = $('#dnsRestore').disabled = true; b.textContent = 'Подтвердите в окне Windows…';
  const r = await send({ type: 'dns', action });
  $('#dnsFix').disabled = $('#dnsRestore').disabled = false; b.textContent = old;
  if (!r || !r.ok) showErr($('#dnsErr'), (r && r.hostMissing) ? 'Не найден локальный помощник.' : (r && r.error === 'unknown cmd') ? 'Нужна новая версия помощника — скачайте и запустите свежий установщик.' : ((r && r.error) || 'Не удалось'));
  else if (r.note) showErr($('#dnsErr'), r.note);
  await dnsRefresh();
}
$('#dnsFix').addEventListener('click', () => dnsDo('fix'));
$('#dnsRestore').addEventListener('click', () => dnsDo('restore'));
$('#netRefresh').addEventListener('click', loadNet);

/* ---------- события ---------- */
document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.nav').forEach((n) => n.classList.toggle('active', n === b));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== 'view-' + b.dataset.view));
  if (b.dataset.view === 'settings') { checkHelper(); dnsRefresh(); }
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
  if (/(vless|https?):\/\//i.test(t)) { e.preventDefault(); $('#linkInput').value = t; addLink(t); }
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
  loadNet();
  loadUpdate(false);
})();
