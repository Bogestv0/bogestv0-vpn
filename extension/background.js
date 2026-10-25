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
  if (!profile) return { ok: false, error: 'Сначала добавьте ссылку vless:// на вкладке «Серверы»' };
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
