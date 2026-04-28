/**
 * Vinted Alertes — Serveur cloud autonome
 * Poll Vinted + notifications Telegram, sans navigateur
 * Déploiement : Railway.app
 * Aucune dépendance npm
 */
const http   = require('http');
const https  = require('https');
const zlib   = require('zlib');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT    = process.env.PORT || 3457;
const DATA    = path.join('/tmp', 'vinted_data.json');
const API     = 'https://www.vinted.fr/api/v2/catalog/items';
const POLL_MS = 15000;

const uid = () => crypto.randomBytes(4).toString('hex');

// ── Base de données (fichier JSON) ────────────────────────────────────────────
let DB = { alerts: [], seen: {}, logs: [], tg: { token: '', chatId: '' } };

function dbLoad() {
  try { if (fs.existsSync(DATA)) DB = { ...DB, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) }; } catch {}
}
function dbSave() {
  try { fs.writeFileSync(DATA, JSON.stringify(DB)); } catch {}
}

// ── Cookies Vinted ────────────────────────────────────────────────────────────
const jar = {};
let jarExpiry = 0;

function parseCookies(raw) {
  (Array.isArray(raw) ? raw : [raw]).filter(Boolean).forEach(c => {
    const [kv] = c.split(';');
    const eq   = kv.indexOf('=');
    if (eq > 0) jar[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  });
}
function cookieStr() { return Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; '); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function httpsGet(url, extra = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9', 'Accept-Encoding': 'gzip,deflate,br', ...extra },
      timeout:  15000,
    }, res => {
      parseCookies(res.headers['set-cookie']);
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://${u.hostname}${res.headers.location}`;
        res.resume(); resolve(httpsGet(next, extra)); return;
      }
      const chunks = [];
      const enc = (res.headers['content-encoding']||'').toLowerCase();
      let stream = res;
      if (enc==='gzip')    { const g=zlib.createGunzip();           res.pipe(g); stream=g; }
      if (enc==='br')      { const g=zlib.createBrotliDecompress(); res.pipe(g); stream=g; }
      if (enc==='deflate') { const g=zlib.createInflate();          res.pipe(g); stream=g; }
      stream.on('data', c => chunks.push(c));
      stream.on('end',  () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', reject);
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function initSession() {
  console.log('[vinted] Initialisation session...');
  await httpsGet('https://www.vinted.fr/', { Accept: 'text/html,*/*' });
  await httpsGet('https://www.vinted.fr/catalog', { Accept: 'text/html,*/*', Referer: 'https://www.vinted.fr/', Cookie: cookieStr() });
  jarExpiry = Date.now() + 25*60*1000;
  console.log(`[vinted] Session OK — ${Object.keys(jar).length} cookies`);
}

async function fetchApi(url) {
  if (!cookieStr() || Date.now() > jarExpiry) await initSession();
  const hdrs = { Accept: 'application/json,*/*', Referer: 'https://www.vinted.fr/catalog', Origin: 'https://www.vinted.fr', Cookie: cookieStr(), 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', 'x-requested-with': 'XMLHttpRequest' };
  let r = await httpsGet(url, hdrs);
  if (r.status === 401) { await initSession(); hdrs.Cookie = cookieStr(); r = await httpsGet(url, hdrs); }
  return r;
}

// ── Prix ──────────────────────────────────────────────────────────────────────
function extractPrice(it) {
  const raw = it.price_numeric ?? it.price?.amount ?? it.total_item_price_rounded ?? it.price;
  if (raw == null) return '?';
  if (typeof raw === 'object' && raw.amount != null) return parseFloat(raw.amount).toFixed(2);
  const n = parseFloat(raw);
  return isNaN(n) ? String(raw) : (Number.isInteger(n) ? n : n.toFixed(2));
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function tgSend(text, token, chatId) {
  const tok = token || DB.tg.token;
  const cid = chatId || DB.tg.chatId;
  if (!tok || !cid) return { ok: false, reason: 'no config' };
  try {
    const r = await httpsGet(
      `https://api.telegram.org/bot${tok}/sendMessage?chat_id=${encodeURIComponent(cid)}&text=${encodeURIComponent(text)}&parse_mode=Markdown&disable_web_page_preview=false`
    );
    return JSON.parse(r.body);
  } catch(e) { console.log('[tg] erreur:', e.message); return { ok: false, reason: e.message }; }
}

// ── Polling ───────────────────────────────────────────────────────────────────
function buildApiUrl(a) {
  if (a.sourceUrl) {
    try {
      const src = new URL(a.sourceUrl.startsWith('http') ? a.sourceUrl : 'https://www.vinted.fr'+a.sourceUrl);
      const p = new URLSearchParams();
      src.searchParams.forEach((v,k) => p.append(k,v));
      p.set('per_page','24'); p.set('order','newest_first');
      return `${API}?${p}`;
    } catch {}
  }
  const p = new URLSearchParams({ per_page:'24', order:'newest_first', currency:'EUR' });
  if (a.kw)        p.set('search_text', a.kw);
  if (a.max)       p.set('price_to',    a.max);
  if (a.min)       p.set('price_from',  a.min);
  if (a.condition) p.set('status[]',    a.condition);
  return `${API}?${p}`;
}

async function pollAlert(a) {
  try {
    const r    = await fetchApi(buildApiUrl(a));
    const data = JSON.parse(r.body);
    if (!data?.items) return;

    const items = data.items.filter(it => {
      const rep = it.user?.feedback_reputation;
      if (rep == null) return true;
      return (rep <= 1 ? rep * 5 : rep) >= parseFloat(a.stars || 0);
    });

    const prev     = new Set(DB.seen[a.id] || []);
    const newItems = items.filter(it => !prev.has(String(it.id)));
    DB.seen[a.id]  = items.map(it => String(it.id));

    if (newItems.length > 0) {
      console.log(`[poll] "${a.name}" : ${newItems.length} nouvelle(s)`);

      DB.logs = [
        ...newItems.map(it => ({
          id: uid(), aid: a.id, aname: a.name,
          title: it.title,
          price: extractPrice(it),
          url:   it.url ?? it.path,
          img:   it.photos?.[0]?.thumb_url ?? it.photo?.url,
          stars: it.user?.feedback_reputation,
          ts:    Date.now(),
        })),
        ...DB.logs,
      ].slice(0, 200);

      a.badge = (a.badge || 0) + newItems.length;

      for (const it of newItems.slice(0, 5)) {
        const href  = it.url ? (it.url.startsWith('http') ? it.url : 'https://www.vinted.fr'+it.url) : '';
        const price = extractPrice(it);
        const rep   = it.user?.feedback_reputation;
        const stars = rep != null ? ` ★ ${(rep<=1?rep*5:rep).toFixed(1)}` : '';
        await tgSend(`🛍 *${a.name}*\n${it.title}\n💶 *${price}€*${stars}\n${href}`);
        await new Promise(r => setTimeout(r, 300));
      }
      dbSave();
    }
  } catch(e) {
    console.log(`[poll] "${a.name}" erreur :`, e.message);
  }
}

let polling = false;
async function pollAll() {
  if (polling) return;
  polling = true;
  try {
    for (const a of DB.alerts.filter(a => a.active)) {
      await pollAlert(a);
      await new Promise(r => setTimeout(r, 1500));
    }
  } finally { polling = false; }
}

// ── Serveur HTTP ──────────────────────────────────────────────────────────────
function jsonRes(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const c = [];
    req.on('data', d => c.push(d));
    req.on('end',  () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u  = new URL(req.url, `http://localhost:${PORT}`);
  const p  = u.pathname;
  const me = req.method;

  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (me === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve HTML
  if (p === '/' || p === '/index.html') {
    const f = path.join(__dirname, 'index.html');
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(f)); }
    else { res.writeHead(404); res.end('index.html introuvable'); }
    return;
  }

  // GET /api/alerts
  if (p === '/api/alerts' && me === 'GET') return jsonRes(res, 200, DB.alerts);

  // POST /api/alerts
  if (p === '/api/alerts' && me === 'POST') {
    const b = await readBody(req);
    const a = { id: uid(), badge: 0, active: true, ...b };
    DB.alerts.push(a); dbSave();
    pollAlert(a);
    return jsonRes(res, 201, a);
  }

  // PUT /api/alerts/:id
  if (p.startsWith('/api/alerts/') && me === 'PUT') {
    const id = p.split('/')[3];
    const b  = await readBody(req);
    const i  = DB.alerts.findIndex(a => a.id === id);
    if (i === -1) return jsonRes(res, 404, { error: 'not found' });
    DB.alerts[i] = { ...DB.alerts[i], ...b }; dbSave();
    return jsonRes(res, 200, DB.alerts[i]);
  }

  // DELETE /api/alerts/:id
  if (p.startsWith('/api/alerts/') && me === 'DELETE') {
    const id = p.split('/')[3];
    DB.alerts = DB.alerts.filter(a => a.id !== id);
    delete DB.seen[id]; dbSave();
    return jsonRes(res, 200, { ok: true });
  }

  // GET /api/logs
  if (p === '/api/logs'  && me === 'GET')    return jsonRes(res, 200, DB.logs);

  // DELETE /api/logs
  if (p === '/api/logs'  && me === 'DELETE') { DB.logs = []; dbSave(); return jsonRes(res, 200, { ok: true }); }

  // GET /api/settings
  if (p === '/api/settings' && me === 'GET')  return jsonRes(res, 200, { token: DB.tg.token ? '***' : '', chatId: DB.tg.chatId });

  // POST /api/settings
  if (p === '/api/settings' && me === 'POST') {
    const b = await readBody(req);
    if (b.token)              DB.tg.token  = b.token;
    if (b.chatId !== undefined) DB.tg.chatId = b.chatId;
    dbSave(); return jsonRes(res, 200, { ok: true });
  }

  // POST /api/test-telegram
  if (p === '/api/test-telegram' && me === 'POST') {
    const b   = await readBody(req);
    const tok = b.token  || DB.tg.token;
    const cid = b.chatId || DB.tg.chatId;
    if (!tok || !cid) return jsonRes(res, 400, { error: 'Token ou Chat ID manquant' });
    const d = await tgSend('✅ Vinted Alertes connecté ! Tu recevras tes notifications ici.', tok, cid);
    if (d.ok) { DB.tg = { token: tok, chatId: cid }; dbSave(); }
    return jsonRes(res, d.ok ? 200 : 400, d);
  }

  // Health
  if (p === '/health') return jsonRes(res, 200, { ok: true, alerts: DB.alerts.filter(a=>a.active).length, uptime: Math.round(process.uptime()) });

  res.writeHead(404); res.end('Not found');
});

// ── Démarrage ─────────────────────────────────────────────────────────────────
dbLoad();
server.listen(PORT, async () => {
  console.log(`\n  Vinted Alertes cloud — port ${PORT}`);
  console.log(`  ${DB.alerts.filter(a=>a.active).length} alerte(s) active(s)\n`);
  await initSession();
  console.log(`\n  Polling toutes les ${POLL_MS/1000}s — démarrage dans 5s...\n`);
  setTimeout(() => {
    pollAll();
    setInterval(pollAll, POLL_MS);
  }, 5000);
});

server.on('error', e => { console.error('Erreur:', e.message); process.exit(1); });
