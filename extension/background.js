// Bogestv0 VPN © 2026 Bogestv0 (https://t.me/bogestv0) — фоновый сервис: управляет xray через native host и прокси браузера
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

// ---- Обновления: сверяемся с последним релизом на GitHub ----
const GH_REPO = 'bogestv0/bogestv0-vpn';   // владелец/репозиторий, где публикуются релизы
const cmpVer = (a, b) => {
  const pa = String(a).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1; }
  return 0;
};
async function checkUpdate(force) {
  const cur = chrome.runtime.getManifest().version;
  const st = await chrome.storage.local.get(['updCache', 'updSkip']);
  let c = st.updCache;
  if (force || !c || Date.now() - c.at > 6 * 3600 * 1000) {   // не чаще раза в 6 часов
    try {
      await withDirectHosts(async () => {
        const r = await fetch('https://api.github.com/repos/' + GH_REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          const asset = (j.assets || []).find((a) => /Setup\.exe$/i.test(a.name));
          c = { at: Date.now(), tag: String(j.tag_name || ''), page: String(j.html_url || ''), asset: asset ? asset.browser_download_url : '' };
          await setState({ updCache: c });
        }
      });
    } catch (e) { /* нет сети — просто без баннера */ }
  }
  if (!c || !c.tag) return { available: false, current: cur };
  return { available: cmpVer(c.tag, cur) > 0 && st.updSkip !== c.tag, current: cur, latest: c.tag.replace(/^v/i, ''), tag: c.tag, url: c.asset || c.page };
}

// ---- Автообновление: помощник скачивает и ставит релиз, расширение само перезагружается ----
// Состояние хранится в storage (updRun), чтобы popup мог показать ход обновления и после переоткрытия.
let updLoop = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function updStart(tag) {
  tag = String(tag || '');
  if (!/^v?\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tag)) return { ok: false, error: 'неверный номер версии' };
  if (updLoop) return { ok: true };
  const r = await native({ cmd: 'update-start', tag });
  if (!r.ok) {
    // старый помощник (до 1.3.0) не знает этой команды — один раз нужно поставить новый установщик вручную
    const legacy = !!r.hostMissing || r.error === 'unknown cmd';
    await setState({ updRun: { state: 'error', tag, legacy, error: legacy ? '' : (r.error || 'не удалось начать обновление') } });
    return { ok: false, legacy, error: r.error };
  }
  await setState({ updRun: { state: 'downloading', tag, at: Date.now() } });
  updWatch(tag);
  return { ok: true };
}
async function updWatch(tag) {
  if (updLoop) return;
  updLoop = true;
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < 10 * 60 * 1000) {
      await sleep(1500);
      const s = await native({ cmd: 'update-status' });
      if (!s.ok) continue;   // помощник на миг занят заменой файлов — пробуем ещё
      if (s.state === 'done') {
        await setState({ updRun: { state: 'restarting', tag }, updDone: String(s.version || tag) });
        await sleep(600);
        chrome.runtime.reload();   // подхватит новые файлы расширения из папки установки
        return;
      }
      if (s.state === 'error') { await setState({ updRun: { state: 'error', tag, error: s.error || 'ошибка обновления' } }); return; }
      if (s.state === 'downloading' || s.state === 'verifying' || s.state === 'installing') await setState({ updRun: { state: s.state, tag, at: Date.now() } });
    }
    await setState({ updRun: { state: 'error', tag, error: 'обновление не завершилось вовремя' } });
  } finally { updLoop = false; }
}
// После перезагрузки расширения: показываем «Обновлено» один раз и сбрасываем состояние
async function afterReload() {
  const st = await chrome.storage.local.get(['updDone', 'updRun']);
  if (st.updDone) {
    await chrome.storage.local.remove(['updDone', 'updRun']);
    await setState({ updToast: String(st.updDone).replace(/^v/i, '') });
  } else if (st.updRun && st.updRun.state !== 'error') {
    // служебный процесс мог прерваться вместе с браузером — не оставляем «вечную» загрузку
    await chrome.storage.local.remove('updRun');
  }
}

// ---- Подписка: одна ссылка на все устройства. Браузер занимает одно место по своему HWID. ----
const SUB_RE = /^https:\/\/[a-z0-9.-]+(?::\d+)?\/vpn\/s\/[0-9]+-[0-9a-f]{24}(?:-[0-9a-f]{24})?\/?$/i;
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
// Подписка и проверка обновлений должны идти мимо VPN-прокси: PAC шлёт даже их в SOCKS,
// а если outbound — битый CF WS, запрос висит до тайм-аута. Пускаем только эти два хоста напрямую,
// остальной трафик продолжает идти через VPN как раньше.
async function withDirectHosts(fn) {
  let saved = null;
  try {
    const cur = await chrome.proxy.settings.get({ incognito: false }).catch(() => null);
    if (cur && cur.value && cur.value.mode !== 'direct') {
      saved = cur.value;
      const v = JSON.parse(JSON.stringify(cur.value));
      if (v.mode === 'pac_script' && v.pacScript && v.pacScript.data) {
        v.pacScript = Object.assign({}, v.pacScript, {
          data: v.pacScript.data.replace('function FindProxyForURL(url, host) {',
            "function FindProxyForURL(url, host) {\n  if (host === 'notify.bogestv0.ru' || host === 'api.github.com') return 'DIRECT';")
        });
        await chrome.proxy.settings.set({ value: v, scope: 'regular' });
      } else {
        await chrome.proxy.settings.clear({ scope: 'regular' });
      }
    }
  } catch (_) {}
  try { return await fn(); }
  finally {
    if (saved) { try { await chrome.proxy.settings.set({ value: saved, scope: 'regular' }); } catch (_) {} }
  }
}

// Загрузить подписку и вернуть ВСЕ разобранные vless-профили. Бросает Error с понятным текстом.
// Раньше брался только первый ключ (у нас это был CF WS) — поэтому выбрать rezerv/Reality было нельзя.
async function fetchSub(url) {
  const di = deviceInfo();
  const headers = { 'x-hwid': await getHwid(), 'x-device-os': di.os, 'x-device-model': di.model };
  // У КАЖДОЙ попытки свой AbortController: после тайм-аута первой signal уже мёртв,
  // и повтор на нём обрывается мгновенно (из-за этого в 1.3.5 всегда показывался тайм-аут).
  const attempt = async () => {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, 15000);
    try {
      return await fetch(url, { cache: 'no-store', signal: ctl.signal, headers });
    } catch (e) {
      e.vpnTimedOut = timedOut;
      throw e;
    } finally { clearTimeout(timer); }
  };
  let r = null, lastErr = null;
  await withDirectHosts(async () => {
    try { r = await attempt(); }
    catch (e) {
      lastErr = e;
      // Если пропатченный PAC не помог — снимаем прокси полностью и повторяем один раз.
      const cur = await chrome.proxy.settings.get({ incognito: false }).catch(() => null);
      if (cur && cur.value && cur.value.mode !== 'direct') {
        try {
          await chrome.proxy.settings.clear({ scope: 'regular' });
          await new Promise((ok) => setTimeout(ok, 300));
          r = await attempt();
          lastErr = null;
        } catch (e2) { lastErr = e2; }
      }
    }
  });
  if (!r) {
    const timeout = !!(lastErr && lastErr.vpnTimedOut);
    const detail = lastErr && lastErr.message ? ' (' + String(lastErr.message).slice(0, 120) + ')' : '';
    throw new Error('Не удалось загрузить подписку: ' + (timeout ? 'тайм-аут 15 с.' : 'нет связи с сервером.') + detail + ' Если сайт не открывается без VPN — возьмите запасную ссылку в боте (/myvpn) или нажмите «Исправить DNS» в настройках.');
  }
  const text = (await r.text()).trim();
  if (!r.ok) throw new Error(text.slice(0, 200) || ('Ошибка подписки (' + r.status + ')'));
  let body = '';
  try { body = atob(text); } catch (e) { body = text; }
  const lines = body.split(/\r?\n/).map((x) => x.trim()).filter((x) => /^vless:\/\//i.test(x));
  if (!lines.length) throw new Error('В подписке нет ключа vless://');
  const parsed = lines.map(Vless.parseVless);
  const rank = (p) => p.security === 'reality' ? 0 : (p.network === 'ws' ? 1 : 2);   // прямой Reality первым, CF — запасной
  parsed.sort((a, b) => rank(a) - rank(b));
  return parsed;
}
const sameServer = (a, b) => a.sub === b.sub && a.parsed.host === b.parsed.host && a.parsed.port === b.parsed.port &&
  a.parsed.security === b.parsed.security && a.parsed.network === b.parsed.network;

// Перечитать подписку и обновить все её профили, сохраняя выбранный сервер и ID.
async function syncSub(url, profiles) {
  const fresh = await fetchSub(url);
  const mine = profiles.filter((p) => p.sub === url);
  const out = profiles.filter((p) => p.sub !== url);
  for (const f of fresh) {
    const old = mine.find((p) => sameServer(p, { sub: url, parsed: f }));
    out.push(old ? Object.assign({}, old, { parsed: f }) : { id: crypto.randomUUID(), parsed: f, sub: url });
  }
  return out;
}
async function addSub(url) {
  url = String(url || '').trim();
  if (!SUB_RE.test(url)) return { ok: false, error: 'Это не ссылка-подписка Bogestv0 VPN.' };
  let profiles;
  try { profiles = await syncSub(url, (await getState()).profiles); } catch (e) { return { ok: false, error: e.message }; }
  const mine = profiles.filter((p) => p.sub === url);
  const id = (mine.find((p) => p.parsed.security === 'reality') || mine[0]).id;
  await setState({ profiles, activeId: id });
  return { ok: true, count: mine.length };
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
  chrome.action.setBadgeBackgroundColor({ color: '#1f77bd' });
  const sfx = on ? 'on' : 'off';
  chrome.action.setIcon({ path: { 16: `icons/${sfx}16.png`, 32: `icons/${sfx}32.png` } });
}

async function connect(id) {
  const st = await getState();
  let profile = st.profiles.find((p) => p.id === (id || st.activeId));
  if (!profile) return { ok: false, error: 'Сначала добавьте ссылку на вкладке «Серверы»' };
  if (profile.sub) {   // обновляем ключ из подписки: так работают перевыпуск ключа, «Отвязать» и лимит устройств
    try {
      const profiles = await syncSub(profile.sub, st.profiles);
      await setState({ profiles });
      const fresh = profiles.find((p) => p.id === profile.id);
      if (fresh) profile.parsed = fresh.parsed;
      else profile = profiles.find((p) => p.sub === profile.sub);   // сервер пропал из подписки — берём первый доступный
    } catch (e) {
      if (!/нет связи|тайм-аут/.test(e.message)) return { ok: false, error: e.message };   // отказ сервера — показываем причину; нет сети — пробуем сохранённый ключ
    }
  }
  if (!profile) return { ok: false, error: 'В подписке нет доступных серверов' };
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
  if (!st.connected) { await clearProxy(); badge(false); return st; }   // на всякий случай снимаем остаточный старый PAC
  const r = await native({ cmd: 'status' });
  if (!r.ok || !r.running) {
    await clearProxy();
    await setState({ connected: false });
    badge(false);
    return Object.assign(st, { connected: false });
  }
  await applyProxy(st);   // после перезагрузки расширения (в том числе при обновлении) настройки прокси заново ставятся
  badge(true);
  return st;
}

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  (async () => {
    switch (msg.type) {
      case 'state': {
        const st = await sync();
        if (st.updRun && ['downloading', 'verifying', 'installing'].includes(st.updRun.state) && !updLoop) updWatch(st.updRun.tag);   // служебный процесс браузера мог перезапуститься
        return send(st);
      }
      case 'update': return send(await checkUpdate(!!msg.force));
      case 'updgo': return send(await updStart(msg.tag));
      case 'updclear': await chrome.storage.local.remove(['updRun', 'updToast']); return send({ ok: true });
      case 'updskip': await setState({ updSkip: String(msg.tag || '') }); return send({ ok: true });
      case 'tcping': return send(await native({ cmd: 'tcping', host: msg.host, port: msg.port }));
      case 'dns': return send(['status', 'fix', 'restore'].includes(msg.action) ? await native({ cmd: 'dns-' + msg.action }) : { ok: false, error: 'unknown' });
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

chrome.runtime.onStartup.addListener(() => { afterReload().then(sync); });
chrome.runtime.onInstalled.addListener(() => { afterReload().then(sync); });
