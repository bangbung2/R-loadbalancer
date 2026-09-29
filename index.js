const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SET_KEY = process.env.SET_KEY || '';
const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'hosts.json');
const DEBUG = process.env.DEBUG !== '0'; // default ON

const uaList = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

// ===== Storage =====
let backendHosts = [];
function defaultHosts() {
  return String(process.env.HOST || 'lo.kopikapal23.workers.dev')
    .split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}
function loadHosts() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (Array.isArray(j.hosts)) { backendHosts = j.hosts.filter(Boolean); return; }
    }
  } catch (e) { console.error('load:', e.message); }
  backendHosts = defaultHosts(); saveHosts();
}
function saveHosts() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ hosts: backendHosts }, null, 2));
  } catch (e) { console.error('save:', e.message); }
}
loadHosts();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: 'text/*', limit: '1mb' }));

// ===== /set API =====
function auth(req, res) {
  if (!SET_KEY) return true;
  const k = req.query.key || req.headers['x-set-key'] || (req.body && req.body.key);
  if (k !== SET_KEY) { res.status(401).json({ ok: false, error: 'Unauthorized' }); return false; }
  return true;
}
function parseHosts(b) {
  let a = [];
  if (b && b.host) a = [].concat(b.host);
  else if (Array.isArray(b)) a = b;
  else if (typeof b === 'string') a = b.split(/[\s,]+/);
  return a.map((s) => String(s).trim()).filter(Boolean);
}

app.get('/set/api/list', (req, res) => { if (!auth(req, res)) return; res.json({ ok: true, hosts: backendHosts }); });
app.post('/set/api/add', (req, res) => { if (!auth(req, res)) return;
  backendHosts = Array.from(new Set([...backendHosts, ...parseHosts(req.body)]));
  saveHosts(); res.json({ ok: true, hosts: backendHosts });
});
app.post('/set/api/set', (req, res) => { if (!auth(req, res)) return;
  backendHosts = Array.from(new Set(parseHosts(req.body)));
  saveHosts(); res.json({ ok: true, hosts: backendHosts });
});
app.post('/set/api/delete', (req, res) => { if (!auth(req, res)) return;
  const t = parseHosts(req.body);
  backendHosts = backendHosts.filter((h) => !t.includes(h));
  saveHosts(); res.json({ ok: true, hosts: backendHosts });
});
app.post('/set/api/clear', (req, res) => { if (!auth(req, res)) return;
  backendHosts = []; saveHosts(); res.json({ ok: true, hosts: backendHosts });
});

// ===== /cek : uji TCP/TLS ke backend =====
app.get('/cek', async (req, res) => {
  if (!auth(req, res)) return;
  const out = [];
  for (const host of backendHosts) {
    const row = { host };
    await new Promise((resolve) => {
      const t0 = Date.now();
      const r = https.request({ hostname: host, port: 443, path: '/', method: 'HEAD', timeout: 8000 }, (up) => {
        row.status = up.statusCode;
        row.ms = Date.now() - t0;
        up.resume();
        resolve();
      });
      r.on('error', (e) => { row.error = e.code || e.message; row.ms = Date.now() - t0; resolve(); });
      r.on('timeout', () => { r.destroy(); row.error = 'TIMEOUT'; resolve(); });
      r.end();
    });
    out.push(row);
  }
  res.json({ hosts: out, note: 'Kalau semua error → backend gak bisa diakses dari Railway (kemungkinan CF block IP Railway)' });
});

// ===== /set UI =====
app.get('/set', (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(UI()); });

// ===== PROXY HTTP =====
app.all('*', async (req, res) => {
  if (req.path.startsWith('/set') || req.path === '/cek') return res.status(404).send('Not found');
  if (backendHosts.length === 0) return res.status(503).send('No backend');

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  const list = [...backendHosts].sort(() => Math.random() - 0.5);
  const errors = [];

  for (const host of list) {
    try {
      await proxyHttp(req, res, host, body);
      return;
    } catch (e) {
      errors.push(`${host}: ${e.code || e.message}`);
      if (DEBUG) console.log(`[http] ${host} → ${e.code || e.message}`);
    }
  }
  res.status(502).type('text').send('All backends failed:\n' + errors.join('\n'));
});

function proxyHttp(req, res, host, body) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers };
    delete headers['host'];
    delete headers['connection'];
    delete headers['content-length'];
    headers['host'] = host;
    headers['user-agent'] = uaList[0];
    if (body.length) headers['content-length'] = String(body.length);

    let settled = false;
    const up = https.request({
      hostname: host, port: 443, path: req.originalUrl || req.url,
      method: req.method, headers, timeout: 15000,
    }, (r) => {
      settled = true;
      res.status(r.statusCode);
      for (const [k, v] of Object.entries(r.headers)) {
        if (['transfer-encoding', 'connection', 'keep-alive'].includes(k.toLowerCase())) continue;
        try { res.setHeader(k, v); } catch {}
      }
      r.pipe(res);
      r.on('end', resolve);
      r.on('error', reject);
    });
    up.on('error', (e) => { if (!settled) reject(e); });
    up.on('timeout', () => up.destroy(new Error('TIMEOUT')));
    if (body.length) up.write(body);
    up.end();
  });
}

// ===== HTTP + WebSocket server =====
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  if (backendHosts.length === 0) { socket.destroy(); return; }
  const list = [...backendHosts].sort(() => Math.random() - 0.5);
  let i = 0;
  const next = () => {
    if (i >= list.length) { if (DEBUG) console.log('[ws] semua host gagal'); socket.destroy(); return; }
    proxyUpgrade(req, socket, head, list[i++], next);
  };
  next();
});

function proxyUpgrade(req, socket, head, host, onFail) {
  const headers = { ...req.headers };
  delete headers['host'];
  headers['host'] = host;
  headers['user-agent'] = uaList[0];

  let ok = false;
  const up = https.request({
    hostname: host, port: 443, path: req.url, method: req.method, headers, timeout: 15000,
  });

  up.on('upgrade', (upRes, upSocket, upHead) => {
    ok = true;
    if (DEBUG) console.log(`[ws] ${host} ✓ 101`);
    let raw = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n`;
    for (const [k, v] of Object.entries(upRes.headers)) raw += `${k}: ${v}\r\n`;
    raw += '\r\n';
    socket.write(raw);
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
  });

  up.on('response', (r) => {
    if (DEBUG) console.log(`[ws] ${host} → ${r.statusCode} (bukan 101)`);
    r.resume();
    if (!ok) onFail();
  });

  up.on('error', (e) => {
    if (DEBUG) console.log(`[ws] ${host} ✗ ${e.code || e.message}`);
    if (!ok) onFail();
  });

  up.on('timeout', () => up.destroy(new Error('TIMEOUT')));
  up.end();
}

server.listen(PORT, () => console.log(`Listening on ${PORT}`));

// ===== UI =====
function UI() {
  const NEED = SET_KEY ? 'true' : 'false';
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Backend Manager</title><style>
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:20px}
.container{max-width:720px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}.sub{color:#94a3b8;font-size:13px;margin-bottom:20px}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:18px;margin-bottom:16px}
label{display:block;font-size:13px;color:#94a3b8;margin-bottom:6px}
input,textarea,button{font-family:inherit;font-size:14px}
input[type=text],input[type=password],textarea{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;outline:none}
textarea{resize:vertical;min-height:90px;font-family:ui-monospace,monospace}
.row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
button{padding:9px 16px;border-radius:8px;border:none;cursor:pointer;font-weight:500}
.btn-primary{background:#3b82f6;color:#fff}.btn-green{background:#10b981;color:#fff}
.btn-ghost{background:transparent;color:#94a3b8;border:1px solid #334155}.btn-danger{background:#ef4444;color:#fff}
.list{list-style:none;padding:0;margin:0}
.list li{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;margin-bottom:8px;font-family:ui-monospace,monospace;font-size:13px;word-break:break-all}
.list li .idx{color:#64748b;min-width:24px}.list li .host{flex:1}.list li button{padding:5px 10px;font-size:12px}
.empty{color:#64748b;text-align:center;padding:20px;font-style:italic}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(100px);background:#10b981;color:#fff;padding:10px 20px;border-radius:8px;transition:transform .3s;z-index:999}
.toast.show{transform:translateX(-50%) translateY(0)}.toast.error{background:#ef4444}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#1e40af;color:#bfdbfe;font-size:11px;margin-left:6px}
</style></head><body><div class="container">
<h1>Backend Manager <span class="badge" id="count">0</span></h1>
<div class="sub">Cek backend: <a href="/cek" target="_blank" style="color:#60a5fa">/cek</a></div>
<div class="card" id="authCard" style="display:none"><label>SET_KEY</label><input type="password" id="keyInput"><div class="row"><button class="btn-primary" id="saveKey">Simpan</button></div></div>
<div class="card"><label>Tambah backend</label><textarea id="addInput" placeholder="vpn.contoh.workers.dev&#10;vpn.lain.workers.dev"></textarea>
<div class="row"><button class="btn-green" id="btnAdd">+ Tambah</button><button class="btn-ghost" id="btnSet">Ganti Semua</button></div></div>
<div class="card"><label>Daftar</label><ul class="list" id="list"></ul>
<div class="row"><button class="btn-danger" id="btnClear">Kosongkan</button><button class="btn-ghost" id="btnRefresh">Refresh</button></div></div>
</div><div class="toast" id="toast"></div><script>
const NEED=${NEED};const $=(i)=>document.getElementById(i);let key=localStorage.getItem('setKey')||'';
function toast(m,e){const t=$('toast');t.textContent=m;t.className='toast show'+(e?' error':'');clearTimeout(t._tid);t._tid=setTimeout(()=>t.className='toast',2200);}
function api(p,m='GET',b){const u=new URL(p,location.origin);if(key)u.searchParams.set('key',key);const o={method:m,headers:{'Content-Type':'application/json'}};if(b)o.body=JSON.stringify(b);return fetch(u,o).then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'HTTP '+r.status);return j;});}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function render(hs){$('count').textContent=hs.length;const ul=$('list');if(!hs.length){ul.innerHTML='<div class="empty">Belum ada backend.</div>';return;}
ul.innerHTML=hs.map((h,i)=>'<li><span class="idx">'+(i+1)+'.</span><span class="host">'+esc(h)+'</span><button class="btn-danger" data-h="'+esc(h)+'">Hapus</button></li>').join('');
ul.querySelectorAll('button[data-h]').forEach(b=>b.onclick=async()=>{if(!confirm('Hapus '+b.dataset.h+'?'))return;try{const r=await api('/set/api/delete','POST',{host:b.dataset.h});render(r.hosts);toast('Dihapus');}catch(e){toast(e.message,1);}});}
async function refresh(){try{const r=await api('/set/api/list');render(r.hosts);}catch(e){toast(e.message,1);if(NEED&&/Unauthorized/.test(e.message))$('authCard').style.display='';}}
$('saveKey').onclick=()=>{key=$('keyInput').value.trim();localStorage.setItem('setKey',key);toast('Disimpan');refresh();};
$('btnAdd').onclick=async()=>{const h=$('addInput').value.trim();if(!h)return toast('Isi',1);try{const r=await api('/set/api/add','POST',{host:h});render(r.hosts);$('addInput').value='';toast('OK');}catch(e){toast(e.message,1);}};
$('btnSet').onclick=async()=>{const h=$('addInput').value.trim();if(!h)return toast('Isi',1);if(!confirm('Ganti SEMUA?'))return;try{const r=await api('/set/api/set','POST',{host:h});render(r.hosts);$('addInput').value='';toast('OK');}catch(e){toast(e.message,1);}};
$('btnClear').onclick=async()=>{if(!confirm('Kosongkan?'))return;try{const r=await api('/set/api/clear','POST');render(r.hosts);toast('OK');}catch(e){toast(e.message,1);}};
$('btnRefresh').onclick=refresh;
if(NEED&&!key)$('authCard').style.display='';refresh();
</script></body></html>`;
}
