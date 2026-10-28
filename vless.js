// Разбор ссылок vless://  (общий для popup и тестов)
(function (root) {
  function clean(s) {
    s = String(s || '').trim();
    // если ссылка скопирована из Markdown вида [текст](url) — вернуть исходный текст
    s = s.replace(/\]\(.*$/s, '').replace(/^\[/, '').replace(/\[/g, '');
    return s.trim();
  }
  function parseVless(input) {
    var s = clean(input);
    var m = /^vless:\/\/([^@\/?#]+)@(\[[^\]]+\]|[^:\/?#]+):(\d+)\/?\??([^#]*)#?(.*)$/i.exec(s);
    if (!m) throw new Error('Это не похоже на ссылку vless://uuid@хост:порт?…');
    var q = {};
    m[4].split('&').forEach(function (p) {
      if (!p) return;
      var i = p.indexOf('=');
      var k = decodeURIComponent(i < 0 ? p : p.slice(0, i));
      var v = i < 0 ? '' : decodeURIComponent(p.slice(i + 1).replace(/\+/g, ' '));
      q[k] = v;
    });
    var name = m[5] ? safeDecode(m[5]) : m[2] + ':' + m[3];
    var p = {
      id: decodeURIComponent(m[1]),
      host: m[2].replace(/^\[|\]$/g, ''),
      port: parseInt(m[3], 10),
      name: name,
      network: q.type || 'tcp',
      security: q.security || 'none',
      flow: q.flow || '',
      sni: q.sni || '',
      fp: q.fp || 'chrome',
      pbk: q.pbk || '',
      sid: q.sid || '',
      spx: q.spx || '',
      path: q.path || '',
      hostHeader: q.host || '',
      serviceName: q.serviceName || '',
      alpn: q.alpn || '',
      headerType: q.headerType || ''
    };
    if (!/^[0-9a-f-]{32,36}$/i.test(p.id)) throw new Error('Неверный UUID в ссылке');
    if (!(p.port > 0 && p.port < 65536)) throw new Error('Неверный порт');
    if (p.security === 'reality' && !p.pbk) throw new Error('Для Reality в ссылке нет параметра pbk');
    return p;
  }
  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
  var api = { parseVless: parseVless, clean: clean };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Vless = api;
})(typeof self !== 'undefined' ? self : this);
