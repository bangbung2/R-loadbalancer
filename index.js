const express = require('express');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

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
const DEBUG = process.env.DEBUG === '1';

const uaList = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
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
  } catch (e) { console.error('loadHosts:', e.message); }
  backendHosts = defaultHosts();
  saveHosts();
}
function saveHosts() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ hosts: backendHosts }, null, 2));
  } catch (e) { console.error('saveHosts:', e.message); }
}
loadHosts();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: 'text/*', limit: '1mb' }));

// ===== Stealth fetch =====
async function stealthFetch(resource, options = {}) {
  const { timeout = 10000 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  const randomUA = uaList[Math.floor(Math.random() * uaList.length)];
  const headers = new Headers(options.headers || {});
  headers.set('User-Agent', randomUA);
  headers.set('Cache-Control', 'no-cache');
  headers.set('Pragma', 'no-cache');
  headers.set('Upgrade-Insecure-Requests', '1');
  headers.set('Sec-Fetch-Dest', 'document');
  headers.set('Sec-Fetch-Mode', 'navigate');
  headers.set('Sec-Fetch-Site', 'none');

  try {
    return await fetch(resource, { ...options, headers, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ===== /set API =====
function checkAuth(req, res) {
  if (!SET_KEY) return true;
  const key = req.query.key || req.headers['x-set-key'] || (req.body && req.body.key);
  if (key !== SET_KEY) { res.status(401).json({ ok:false, error:'Unauthorized' }); return false; }
  return true;
}
function parseHosts(body) {
  let arr = [];
  if (body && body.host) arr = [].concat(body.host);
  else if (Array.isArray(body)) arr = body;
  else if (typeof body === 'string') arr = body.split(/[\s,]+/);
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

app.get('/set/api/list', (req,res)=>{ if(!checkAuth(req,res))return; res.json({ok:true,hosts:backendHosts}); });
app.post('/set/api/add', (req,res)=>{ if(!checkAuth(req,res))return;
  backendHosts = Array.from(new Set([...backendHosts, ...parseHosts(req.body)]));
  saveHosts(); res.json({ok:true,hosts:backendHosts});
});
app.post('/set/api/set', (req,res)=>{ if(!checkAuth(req,res))return;
  backendHosts = Array.from(new Set(parseHosts(req.body)));
  saveHosts(); res.json({ok:true,hosts:backendHosts});
});
app.post('/set/api/delete', (req,res)=>{ if(!checkAuth(req,res))return;
  const t = parseHosts(req.body);
  backendHosts = backendHosts.filter((h)=>!t.includes(h));
  saveHosts(); res.json({ok:true,hosts:backendHosts});
});
app.post('/set/api/clear', (req,res)=>{ if(!checkAuth(req,res))return;
  backendHosts = []; saveHosts(); res.json({ok:true,hosts:backendHosts});
});

// ===== /debug : tes semua backend =====
app.get('/debug', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const results = [];
  const [pp, sp] = pathUji.split('?');
  for (const host of backendHosts) {
    const t = new URL(`https://${host}${pp}${sp ? '?'+sp : ''}`);
    const row = { host, url: t.href };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(()=>ctrl.abort(), 8000);
      const r = await stealthFetch(t.href, { method:'GET', redirect:'manual', signal:ctrl.signal });
      clearTimeout(timer);
      row.status = r.status;
      row.contentType = r.headers.get('content-type') || '';
      row.location = r.headers.get('location') || '';
      const buf = Buffer.from(await r.arrayBuffer());
      row.preview = buf.slice(0, 300).toString('utf8').replace(/\s+/g,' ').slice(0, 200);
      row.ok = String(r.status) === kodeRespon || [301,302].includes(r.status);
    } catch (e) {
      row.error = e.message;
      row.ok = false;
    }
    results.push(row);
  }
  res.json({
    ok: results.some(r=>r.ok),
    pathUji,
    kodeRespon,
    expectedNote: `Sukses jika status = ${kodeRespon} atau 301/302`,
    hosts: results,
  });
});

// ===== UI =====
app.get('/set', (req,res)=>{ res.setHeader('Content-Type','text/html; charset=utf-8'); res.send(renderUI()); });

// ===== Proxy utama =====
async function bufferBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function tryHost(req, url, host, bodyBuffer) {
  const target = new URL(url.href);
  target.protocol = 'https:';
  target.host = host;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (['host','connection','content-length','transfer-encoding','accept-encoding','user-agent'].includes(lk)) continue;
    try { headers.set(k, Array.isArray(v) ? v.join(', ') : v); } catch {}
  }
  headers.set('User-Agent', uaList[0]);

  const init = { method: req.method, headers, redirect: 'manual' };
  if (!['GET','HEAD'].includes(req.method) && bodyBuffer) init.body = bodyBuffer;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  init.signal = ctrl.signal;

  try {
    const resp = await fetch(target.href, init);
    // Follow redirect manual supaya bisa balik ke client
    return { resp, finalUrl: target.href };
  } finally {
    clearTimeout(timer);
  }
}

function copyHeaders(resp, res) {
  resp.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (['content-encoding','content-length','transfer-encoding','connection','content-security-policy'].includes(lk)) return;
    try { res.setHeader(k, v); } catch {}
  });
}

app.all('*', async (req, res) => {
  if (req.path.startsWith('/set') || req.path === '/debug') {
    return res.status(404).send('Not found');
  }

  const origin = `http://${req.headers.host}`;
  const url = new URL(req.originalUrl || req.url, origin);

  if (backendHosts.length === 0) return res.status(503).send('No backend');

  // Buffer body sekali (untuk retry)
  let bodyBuffer = null;
  if (!['GET','HEAD'].includes(req.method)) {
    try { bodyBuffer = await bufferBody(req); } catch (e) { console.error('buffer:', e.message); }
  }

  const shuffled = [...backendHosts].sort(() => Math.random() - 0.5);
  const errors = [];

  for (const host of shuffled) {
    try {
      const { resp } = await tryHost(req, url, host, bodyBuffer);

      // Anggap sukses kalau bukan error 5xx
      if (resp.status >= 500 && resp.status !== 503) {
        // tetap pakai, tapi catat
        if (DEBUG) console.log(`[${host}] status ${resp.status}`);
      }

      res.status(resp.status);
      copyHeaders(resp, res);

      if (resp.body) {
        Readable.fromWeb(resp.body).pipe(res);
      } else {
        res.end();
      }
      return;
    } catch (e) {
      errors.push(`${host}: ${e.message}`);
      console.log('Skipped:', host, '-', e.message);
    }
  }

  res.status(503).type('text/plain').send(
    'Semua backend tidak merespon.\n\n' + errors.join('\n') +
    '\n\nCoba buka /debug?key=... untuk lihat status tiap backend.'
  );
});

// ===== HTML UI (sama seperti sebelumnya) =====
function renderUI() { return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Backend Manager</title><style>
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
.hint{font-size:12px;color:#64748b;margin-top:6px}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#1e40af;color:#bfdbfe;font-size:11px;margin-left:6px}
</style></head><body><div class="container">
<h1>Backend Manager <span class="badge" id="count">0</span></h1>
<div class="sub">Kelola daftar host backend. <a href="/debug" target="_blank" style="color:#60a5fa">Cek /debug</a></div>
<div class="card" id="authCard" style="display:none"><label>SET_KEY</label><input type="password" id="keyInput"><div class="row"><button class="btn-primary" id="saveKey">Simpan Key</button></div></div>
<div class="card"><label>Tambah backend</label><textarea id="addInput" placeholder="vpn.contoh.workers.dev&#10;vpn.lain.workers.dev"></textarea>
<div class="row"><button class="btn-green" id="btnAdd">+ Tambah</button><button class="btn-ghost" id="btnSet">Ganti Semua</button></div></div>
<div class="card"><label>Daftar Backend</label><ul class="list" id="list"></ul>
<div class="row"><button class="btn-danger" id="btnClear">Kosongkan</button><button class="btn-ghost" id="btnRefresh">Refresh</button></div></div>
</div><div class="toast" id="toast"></div><script>
const NEED_KEY=${SET_KEY?'true':'false'};const $=(id)=>document.getElementById(id);let key=localStorage.getItem('setKey')||'';
function toast(m,e){const t=$('toast');t.textContent=m;t.className='toast show'+(e?' error':'');clearTimeout(t._tid);t._tid=setTimeout(()=>t.className='toast',2200);}
function api(p,m='GET',b){const u=new URL(p,location.origin);if(key)u.searchParams.set('key',key);const o={method:m,headers:{'Content-Type':'application/json'}};if(b)o.body=JSON.stringify(b);return fetch(u,o).then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'HTTP '+r.status);return j;});}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function renderList(hs){$('count').textContent=hs.length;const ul=$('list');if(!hs.length){ul.innerHTML='<div class="empty">Belum ada backend.</div>';return;}
ul.innerHTML=hs.map((h,i)=>'<li><span class="idx">'+(i+1)+'.</span><span class="host">'+esc(h)+'</span><button class="btn-danger" data-host="'+esc(h)+'">Hapus</button></li>').join('');
ul.querySelectorAll('button[data-host]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('Hapus '+b.dataset.host+'?'))return;try{const r=await api('/set/api/delete','POST',{host:b.dataset.host});renderList(r.hosts);toast('Dihapus');}catch(e){toast(e.message,1);}}));}
async function refresh(){try{const r=await api('/set/api/list');renderList(r.hosts);}catch(e){toast(e.message,1);if(NEED_KEY&&String(e.message).includes('Unauthorized'))$('authCard').style.display='';}}
$('saveKey').addEventListener('click',()=>{key=$('keyInput').value.trim();localStorage.setItem('setKey',key);toast('Disimpan');refresh();});
$('btnAdd').addEventListener('click',async()=>{const h=$('addInput').value.trim();if(!h)return toast('Isi dulu',1);try{const r=await api('/set/api/add','POST',{host:h});renderList(r.hosts);$('addInput').value='';toast('Ditambah');}catch(e){toast(e.message,1);}});
$('btnSet').addEventListener('click',async()=>{const h=$('addInput').value.trim();if(!h)return toast('Isi dulu',1);if(!confirm('Ganti SEMUA?'))return;try{const r=await api('/set/api/set','POST',{host:h});renderList(r.hosts);$('addInput').value='';toast('Diganti');}catch(e){toast(e.message,1);}});
$('btnClear').addEventListener('click',async()=>{if(!confirm('Kosongkan?'))return;try{const r=await api('/set/api/clear','POST');renderList(r.hosts);toast('Kosong');}catch(e){toast(e.message,1);}});
$('btnRefresh').addEventListener('click',refresh);
if(NEED_KEY&&!key)$('authCard').style.display='';refresh();
</script></body></html>`; }

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
