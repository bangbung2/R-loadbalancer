const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;
const SET_KEY = process.env.SET_KEY || '';
const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'hosts.json');

const pathUji = (() => {
  let p = process.env.PATH || '/';
  if (p.charAt(0) !== '/') p = '/' + p;
  return p;
})();
const kodeRespon = String(process.env.CODE || '200');

// ===== Storage =====
let backendHosts = [];

function defaultHosts() {
  return String(process.env.HOST || 'vpn.barijaya.workers.dev,vpn.barijaya1.workers.dev')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadHosts() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const j = JSON.parse(raw);
      if (Array.isArray(j.hosts)) {
        backendHosts = j.hosts.filter(Boolean);
        return;
      }
    }
  } catch (e) {
    console.error('loadHosts error:', e.message);
  }
  backendHosts = defaultHosts();
  saveHosts();
}

function saveHosts() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ hosts: backendHosts }, null, 2));
  } catch (e) {
    console.error('saveHosts error:', e.message);
  }
}

loadHosts();

// ===== Middleware =====
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: 'text/*', limit: '1mb' }));

// ===== API /set =====
function checkAuth(req, res) {
  if (!SET_KEY) return true;
  const key = req.query.key || req.headers['x-set-key'] || (req.body && req.body.key);
  if (key !== SET_KEY) {
    res.status(401).json({ ok: false, error: 'Unauthorized (butuh ?key=...)' });
    return false;
  }
  return true;
}

// List
app.get('/set/api/list', (req, res) => {
  if (!checkAuth(req, res)) return;
  res.json({ ok: true, hosts: backendHosts });
});

// Add
app.post('/set/api/add', (req, res) => {
  if (!checkAuth(req, res)) return;
  let incoming = [];
  if (req.body && req.body.host) incoming = [].concat(req.body.host);
  else if (Array.isArray(req.body)) incoming = req.body;
  else if (typeof req.body === 'string') incoming = req.body.split(/[\s,]+/);

  incoming = incoming.map((s) => String(s).trim()).filter(Boolean);
  backendHosts = Array.from(new Set([...backendHosts, ...incoming]));
  saveHosts();
  res.json({ ok: true, hosts: backendHosts });
});

// Replace all
app.post('/set/api/set', (req, res) => {
  if (!checkAuth(req, res)) return;
  let incoming = [];
  if (req.body && req.body.host) incoming = [].concat(req.body.host);
  else if (Array.isArray(req.body)) incoming = req.body;
  else if (typeof req.body === 'string') incoming = req.body.split(/[\s,]+/);

  incoming = incoming.map((s) => String(s).trim()).filter(Boolean);
  backendHosts = Array.from(new Set(incoming));
  saveHosts();
  res.json({ ok: true, hosts: backendHosts });
});

// Delete
app.post('/set/api/delete', (req, res) => {
  if (!checkAuth(req, res)) return;
  let target = req.body && req.body.host ? [].concat(req.body.host) : [];
  target = target.map((s) => String(s).trim()).filter(Boolean);
  backendHosts = backendHosts.filter((h) => !target.includes(h));
  saveHosts();
  res.json({ ok: true, hosts: backendHosts });
});

// Clear
app.post('/set/api/clear', (req, res) => {
  if (!checkAuth(req, res)) return;
  backendHosts = [];
  saveHosts();
  res.json({ ok: true, hosts: backendHosts });
});

// ===== UI /set =====
app.get('/set', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderUI());
});

// ===== Proxy utama =====
app.all('*', async (req, res) => {
  if (req.path.startsWith('/set')) return res.status(404).send('Not found');

  const origin = `http://${req.headers.host}`;
  const url = new URL(req.originalUrl || req.url, origin);

  if (backendHosts.length === 0) return res.status(503).send('No backend');

  const shuffled = [...backendHosts].sort(() => Math.random() - 0.5);

  for (const host of shuffled) {
    const testUrl = new URL(url.href);
    testUrl.protocol = 'https:';
    testUrl.host = host;
    const [pp, sp] = pathUji.split('?');
    testUrl.pathname = pp;
    testUrl.search = sp || '';

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const testResp = await fetch(testUrl.href, {
        method: 'HEAD',
        redirect: 'manual',
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (String(testResp.status) === kodeRespon || testResp.status === 302) {
        const finalUrl = new URL(url.href);
        finalUrl.protocol = 'https:';
        finalUrl.host = host;

        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const lk = k.toLowerCase();
          if (
            ['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding'].includes(
              lk
            )
          )
            continue;
          headers[k] = v;
        }

        const init = { method: req.method, headers, redirect: 'follow' };
        if (!['GET', 'HEAD'].includes(req.method)) {
          init.body = req;
          init.duplex = 'half';
        }

        const proxyResp = await fetch(finalUrl.href, init);

        res.status(proxyResp.status);
        proxyResp.headers.forEach((v, k) => {
          const lk = k.toLowerCase();
          if (
            ['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(lk)
          )
            return;
          try {
            res.setHeader(k, v);
          } catch {}
        });

        const buf = Buffer.from(await proxyResp.arrayBuffer());
        return res.end(buf);
      }
    } catch {}
  }

  res.status(503).send('Down');
});

// ===== HTML UI =====
function renderUI() {
  const needsKey = SET_KEY ? 'true' : 'false';
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Backend Manager</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f172a; color: #e2e8f0; margin: 0; padding: 20px;
    min-height: 100vh;
  }
  .container { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #94a3b8; font-size: 13px; margin-bottom: 20px; }
  .card {
    background: #1e293b; border: 1px solid #334155; border-radius: 12px;
    padding: 18px; margin-bottom: 16px;
  }
  label { display: block; font-size: 13px; color: #94a3b8; margin-bottom: 6px; }
  input, textarea, button {
    font-family: inherit; font-size: 14px;
  }
  input[type=text], input[type=password], textarea {
    width: 100%; padding: 10px 12px; border-radius: 8px;
    border: 1px solid #334155; background: #0f172a; color: #e2e8f0;
    outline: none; transition: border .15s;
  }
  input:focus, textarea:focus { border-color: #3b82f6; }
  textarea { resize: vertical; min-height: 90px; font-family: ui-monospace, monospace; }
  .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  button {
    padding: 9px 16px; border-radius: 8px; border: none; cursor: pointer;
    font-weight: 500; transition: opacity .15s, transform .05s;
  }
  button:active { transform: scale(0.97); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .btn-primary { background: #3b82f6; color: white; }
  .btn-primary:hover:not(:disabled) { background: #2563eb; }
  .btn-green { background: #10b981; color: white; }
  .btn-green:hover:not(:disabled) { background: #059669; }
  .btn-ghost { background: transparent; color: #94a3b8; border: 1px solid #334155; }
  .btn-ghost:hover:not(:disabled) { color: #e2e8f0; border-color: #475569; }
  .btn-danger { background: #ef4444; color: white; }
  .btn-danger:hover:not(:disabled) { background: #dc2626; }
  .list { list-style: none; padding: 0; margin: 0; }
  .list li {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; background: #0f172a; border: 1px solid #334155;
    border-radius: 8px; margin-bottom: 8px; font-family: ui-monospace, monospace;
    font-size: 13px; word-break: break-all;
  }
  .list li .idx { color: #64748b; min-width: 24px; }
  .list li .host { flex: 1; }
  .list li button { padding: 5px 10px; font-size: 12px; }
  .empty { color: #64748b; text-align: center; padding: 20px; font-style: italic; }
  .toast {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%) translateY(100px);
    background: #10b981; color: white; padding: 10px 20px; border-radius: 8px;
    font-size: 14px; transition: transform .3s; z-index: 999;
  }
  .toast.show { transform: translateX(-50%) translateY(0); }
  .toast.error { background: #ef4444; }
  .hint { font-size: 12px; color: #64748b; margin-top: 6px; }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    background: #1e40af; color: #bfdbfe; font-size: 11px; margin-left: 6px;
  }
</style>
</head>
<body>
<div class="container">
  <h1>Backend Manager <span class="badge" id="count">0</span></h1>
  <div class="sub">Kelola daftar host backend untuk proxy VPN.</div>

  <div class="card" id="authCard" style="display:none">
    <label>SET_KEY</label>
    <input type="password" id="keyInput" placeholder="Masukkan key...">
    <div class="row"><button class="btn-primary" id="saveKey">Simpan Key</button></div>
    <div class="hint">Key disimpan di localStorage browser.</div>
  </div>

  <div class="card">
    <label>Tambah backend (1 per baris atau pisahkan dengan koma)</label>
    <textarea id="addInput" placeholder="vpn.contoh.workers.dev&#10;vpn.lain.workers.dev"></textarea>
    <div class="row">
      <button class="btn-green" id="btnAdd">+ Tambah</button>
      <button class="btn-ghost" id="btnSet">Ganti Semua</button>
    </div>
  </div>

  <div class="card">
    <label>Daftar Backend</label>
    <ul class="list" id="list"></ul>
    <div class="row">
      <button class="btn-danger" id="btnClear">Kosongkan Semua</button>
      <button class="btn-ghost" id="btnRefresh">Refresh</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
  const NEED_KEY = ${needsKey};
  const $ = (id) => document.getElementById(id);
  let key = localStorage.getItem('setKey') || '';

  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(t._tid);
    t._tid = setTimeout(() => (t.className = 'toast'), 2200);
  }

  function api(path, method = 'GET', body) {
    const url = new URL(path, location.origin);
    if (key) url.searchParams.set('key', key);
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    return fetch(url, opts).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      return j;
    });
  }

  function renderList(hosts) {
    $('count').textContent = hosts.length;
    const ul = $('list');
    if (!hosts.length) {
      ul.innerHTML = '<div class="empty">Belum ada backend.</div>';
      return;
    }
    ul.innerHTML = hosts
      .map(
        (h, i) =>
          '<li><span class="idx">' +
          (i + 1) +
          '.</span><span class="host">' +
          escapeHtml(h) +
          '</span><button class="btn-danger" data-host="' +
          escapeAttr(h) +
          '">Hapus</button></li>'
      )
      .join('');
    ul.querySelectorAll('button[data-host]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('Hapus "' + b.dataset.host + '"?')) return;
        try {
          const r = await api('/set/api/delete', 'POST', { host: b.dataset.host });
          renderList(r.hosts);
          toast('Dihapus');
        } catch (e) {
          toast(e.message, true);
        }
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  async function refresh() {
    try {
      const r = await api('/set/api/list');
      renderList(r.hosts);
    } catch (e) {
      toast(e.message, true);
      if (NEED_KEY && String(e.message).includes('Unauthorized')) showAuth();
    }
  }

  function showAuth() {
    $('authCard').style.display = '';
    $('keyInput').value = key;
  }

  $('saveKey').addEventListener('click', () => {
    key = $('keyInput').value.trim();
    localStorage.setItem('setKey', key);
    toast('Key disimpan');
    refresh();
  });

  $('btnAdd').addEventListener('click', async () => {
    const host = $('addInput').value.trim();
    if (!host) return toast('Isi dulu', true);
    try {
      const r = await api('/set/api/add', 'POST', { host });
      renderList(r.hosts);
      $('addInput').value = '';
      toast('Ditambahkan');
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('btnSet').addEventListener('click', async () => {
    const host = $('addInput').value.trim();
    if (!host) return toast('Isi dulu', true);
    if (!confirm('Ganti SEMUA backend dengan yang diinput?')) return;
    try {
      const r = await api('/set/api/set', 'POST', { host });
      renderList(r.hosts);
      $('addInput').value = '';
      toast('Diganti');
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('btnClear').addEventListener('click', async () => {
    if (!confirm('Kosongkan semua backend?')) return;
    try {
      const r = await api('/set/api/clear', 'POST');
      renderList(r.hosts);
      toast('Dikosongkan');
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('btnRefresh').addEventListener('click', refresh);

  if (NEED_KEY && !key) showAuth();
  refresh();
</script>
</body>
</html>`;
}

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
