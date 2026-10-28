// Bogestv0 VPN — фоновый сервис: управляет xray через native host и прокси браузера
importScripts('lib/vless.js');

const HOST = 'com.bogestv0.vpn';
const DEFAULTS = { profiles: [], activeId: null, connected: false, mode: 'all', sites: [], port: 10808 };

const native = (msg) => new Promise((resolve) => {
  try {
    chrome.runtime.sendNativeMessage(HOST, msg, (r) => {
      if (chrome.runtime.lastError) resolve({ ok: false, hostMissing: true, error: chrome.runtime.lastError.message });
      else resolve(r || { ok: false, error: 'Пустой ответ помощника' });
    });
  } catch (e) { resolve({ ok: false, hostMissing: true, error: String(e) }); }
});

// ---- Подписка: одна ссылка на все устройства. Браузер занимает одно место по своему HWID. ----
const SUB_RE = /^https:\/\/notify\.bogestv0\.ru\/vpn\/s\/[0-9]+-[0-9a-f]{24}(?:-[0-9a-f]{24})?\/?$/i;
async function getHwid() {
  const { hwid } = await chrome.storage.local.get('hwid');
  if (hwid) return hwid;
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  const h = Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  await chrome.storage.local.set({ hwid: h });
  return h;
}
function deviceInfo() {
  const ua = navigator.userAgent;
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Brave/.test(ua) ? 'Brave' : 'Chrome';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'PC';
  return { model: 'Browser ' + br, os: os };   // только ASCII: это значения HTTP-заголовков
}
// Загрузить подписку и вернуть разобранный vless-профиль. Бросает Error с понятным текстом.
async function fetchSub(url) {
  const di = deviceInfo();
  let r;
  try {
    r = await fetch(url, { cache: 'no-store', headers: { 'x-hwid': await getHwid(), 'x-device-os': di.os, 'x-device-model': di.model } });
  } catch (e) { throw new Error('Не удалось загрузить подписку: нет связи с сервером.'); }
  const text = (await r.text()).trim();
  if (!r.ok) throw new Error(text.slice(0, 200) || ('Ошибка подписки (' + r.status + ')'));
  let body = '';
  try { body = atob(text); } catch (e) { body = text; }
  const line = body.split(/\r?\n/).map((x) => x.trim()).find((x) => /^vless:\/\//i.test(x));
  if (!line) throw new Error('В подписке нет ключа vless://');
  return Vless.parseVless(line);
}
async function addSub(url) {
  url = String(url || '').trim();
  if (!SUB_RE.test(url)) return { ok: false, error: 'Это не ссылка-подписка Bogestv0 VPN.' };
  let parsed;
  try { parsed = await fetchSub(url); } catch (e) { return { ok: false, error: e.message }; }
  const st = await getState();
  const have = st.profiles.find((p) => p.sub === url);
  const profiles = have ? st.profiles.map((p) => (p === have ? Object.assign({}, p, { parsed }) : p)) : st.profiles.concat({ id: crypto.randomUUID(), parsed, sub: url });
  const id = have ? have.id : profiles[profiles.length - 1].id;
  await setState({ profiles, activeId: id });
  return { ok: true };
}

const getState = async () => Object.assign({}, DEFAULTS, await chrome.storage.local.get(null));
const setState = (patch) => chrome.storage.local.set(patch);

function buildPac(state) {
  const port = state.port;
  const proxy = 'SOCKS5 127.0.0.1:' + port + '; SOCKS 127.0.0.1:' + port;
  const sites = JSON.stringify(state.sites.map((s) => s.toLowerCase()));
  return `
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (isPlainHostName(host) || host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ||
      shExpMatch(host, '*.local') ||
      isInNet(host, '10.0.0.0', '255.0.0.0') || isInNet(host, '192.168.0.0', '255.255.0.0') ||
      isInNet(host, '172.16.0.0', '255.240.0.0')) return 'DIRECT';
  ${state.mode === 'list' ? `
  var sites = ${sites};
  for (var i = 0; i < sites.length; i++) {
    if (host === sites[i] || dnsDomainIs(host, '.' + sites[i])) return '${proxy}';
  }
  return 'DIRECT';` : `return '${proxy}';`}
}`;
}

async function applyProxy(state) {
  await chrome.proxy.settings.set({
    value: { mode: 'pac_script', pacScript: { data: buildPac(state), mandatory: true } },
    scope: 'regular'
  });
}
const clearProxy = () => chrome.proxy.settings.clear({ scope: 'regular' });

function badge(on) {
  chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#3b9a47' });
  const sfx = on ? 'on' : 'off';
  chrome.action.setIcon({ path: { 16: `icons/${sfx}16.png`, 32: `icons/${sfx}32.png` } });
}

async function connect(id) {
  const st = await getState();
  const profile = st.profiles.find((p) => p.id === (id || st.activeId));
  if (!profile) return { ok: false, error: 'Сначала добавьте ссылку на вкладке «Серверы»' };
  if (profile.sub) {   // обновляем ключ из подписки: так работают перевыпуск ключа, «Отвязать» и лимит устройств
    try {
      profile.parsed = await fetchSub(profile.sub);
      await setState({ profiles: st.profiles.map((p) => (p.id === profile.id ? profile : p)) });
    } catch (e) {
      if (!/нет связи/.test(e.message)) return { ok: false, error: e.message };   // отказ сервера — показываем причину; нет сети — пробуем сохранённый ключ
    }
  }
  const r = await native({ cmd: 'start', profile: profile.parsed, port: st.port });
  if (!r.ok) return r;
  await applyProxy(st);
  await setState({ connected: true, activeId: profile.id });
  badge(true);
  return { ok: true };
}

async function disconnect() {
  await clearProxy();
  const r = await native({ cmd: 'stop' });
  await setState({ connected: false });
  badge(false);
  return r.hostMissing ? { ok: true } : r;
}

// Сверяем сохранённое состояние с реальностью (xray мог быть остановлен)
async function sync() {
  const st = await getState();
  if (!st.connected) { badge(false); return st; }
  const r = await native({ cmd: 'status' });
  if (!r.ok || !r.running) {
    await clearProxy();
    await setState({ connected: false });
    badge(false);
    return Object.assign(st, { connected: false });
  }
  badge(true);
  return st;
}

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  (async () => {
    switch (msg.type) {
      case 'state': return send(await sync());
      case 'addsub': return send(await addSub(msg.url));
      case 'connect': return send(await connect(msg.id));
      case 'disconnect': return send(await disconnect());
      case 'ping': return send(await native({ cmd: 'ping' }));
      case 'reapply': {
        const st = await getState();
        if (st.connected) await applyProxy(st);
        return send({ ok: true });
      }
      default: return send({ ok: false, error: 'unknown' });
    }
  })();
  return true;
});

chrome.runtime.onStartup.addListener(sync);
chrome.runtime.onInstalled.addListener(sync);
