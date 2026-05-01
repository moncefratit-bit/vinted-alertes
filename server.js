/**
 * Vinted Alertes — Serveur cloud autonome v3
 * Mots exclus, bot Telegram, polling 5s
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
const POLL_MS = 5000;

const uid = () => crypto.randomBytes(4).toString('hex');

// ── Base de données ───────────────────────────────────────────────────────────
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
  if (raw == null) return null;
  if (typeof raw === 'object' && raw.amount != null) return parseFloat(raw.amount);
  const n = parseFloat(raw);
  return isNaN(n) ? null : n;
}

function formatPrice(n) {
  if (n == null) return '?';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}


// ── Condition Vinted ──────────────────────────────────────────────────────────
const CONDITIONS = { 6:'Neuf avec étiquette', 1:'Neuf sans étiquette', 2:'Très bon état', 3:'Bon état', 4:'Satisfaisant' };

// ── Filtre mots exclus ────────────────────────────────────────────────────────
function parseExcludeKw(str) {
  if (!str) return [];
  return str.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function isExcluded(it, excludeList) {
  if (!excludeList.length) return false;
  const haystack = [it.title, it.description, it.brand?.title].filter(Boolean).join(' ').toLowerCase();
  return excludeList.some(kw => haystack.includes(kw));
}


// ── Telegram ──────────────────────────────────────────────────────────────────
async function tgSend(text, token, chatId) {
  const tok = token || DB.tg.token;
  const cid = chatId || DB.tg.chatId;
  if (!tok || !cid) return { ok: false, reason: 'no config' };
  try {
    const body = JSON.stringify({ chat_id: cid, text, parse_mode: 'Markdown', disable_web_page_preview: false });
    const u    = new URL(`https://api.telegram.org/bot${tok}/sendMessage`);
    const r    = await new Promise((resolve, reject) => {
      const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10000 }, res => {
        const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ body: Buffer.concat(c).toString() }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('TG timeout')); });
      req.write(body); req.end();
    });
    return JSON.parse(r.body);
  } catch(e) { console.log('[tg] erreur:', e.message); return { ok: false, reason: e.message }; }
}

function buildTgMessage(it, alertName, price) {
  const href  = it.url ? (it.url.startsWith('http') ? it.url : 'https://www.vinted.fr'+it.url) : '';
  const rep   = it.user?.feedback_reputation;
  const stars = rep != null ? ` ★ ${(rep<=1?rep*5:rep).toFixed(1)}` : '';
  const cond  = CONDITIONS[it.status] || '';

  let msg = `🛍 *${alertName}*\n`;
  msg += `📦 ${it.title}\n`;
  msg += `💶 *${formatPrice(price)}€*${stars}\n`;
  if (cond) msg += `🏷 ${cond}\n`;
  if (it.user?.login) msg += `👤 @${it.user.login}\n`;
  msg += `\n${href}`;
  return msg;
}

// ── Bot Telegram — commandes ─────────────────────────────────────────────────
// Conversations en cours pour la création d'alertes (état par chatId)
const conversations = {};

const HELP_MSG = `*Vinted Alertes — Commandes disponibles*

/liste — voir toutes les alertes
/pause N — mettre en pause l'alerte N
/reprendre N — réactiver l'alerte N
/supprimer N — supprimer l'alerte N
/nouvelle — créer une nouvelle alerte (guidé)
/bilan — résumé des annonces trouvées aujourd'hui
/aide — afficher ce menu`;

async function tgReply(chatId, text) {
  return tgSend(text, DB.tg.token, String(chatId));
}

function alertLine(a, i) {
  const icon  = a.active ? '🟢' : '⏸';
  const excl  = a.excludeKw ? `  _exclu: ${a.excludeKw}_` : '';
  const price = a.max ? ` ≤${a.max}€` : '';
  const stars = parseFloat(a.stars||0) > 0 ? ` ★${a.stars}+` : '';
  return `${icon} *${i+1}.* ${a.name}${price}${stars}${excl}`;
}

async function handleTgMessage(msg) {
  const chatId = String(msg.chat?.id);
  const text   = (msg.text || '').trim();
  const lower  = text.toLowerCase();

  // Sécurité : n'accepte que le chatId configuré
  if (chatId !== String(DB.tg.chatId)) return;

  // ── Conversation en cours (création d'alerte guidée) ──
  const conv = conversations[chatId];
  if (conv) {
    return handleConversationStep(chatId, text, conv);
  }

  // ── Commandes ──
  if (lower === '/aide' || lower === '/help' || lower === '/start') {
    return tgReply(chatId, HELP_MSG);
  }

  if (lower === '/liste') {
    if (DB.alerts.length === 0) return tgReply(chatId, 'Aucune alerte configurée\. Tape /nouvelle pour en créer une\.');
    const lines = DB.alerts.map((a,i) => alertLine(a,i)).join('\n');
    return tgReply(chatId, `*Tes alertes :*\n\n${lines}\n\n_/pause N, /reprendre N, /supprimer N_`);
  }

  if (lower.startsWith('/pause ')) {
    const n = parseInt(lower.replace('/pause ','')) - 1;
    const a = DB.alerts[n];
    if (!a) return tgReply(chatId, `Alerte ${n+1} introuvable\. Tape /liste pour voir la liste\.`);
    DB.alerts[n] = { ...a, active: false }; dbSave();
    return tgReply(chatId, `⏸ Alerte *${a.name}* mise en pause\.`);
  }

  if (lower.startsWith('/reprendre ')) {
    const n = parseInt(lower.replace('/reprendre ','')) - 1;
    const a = DB.alerts[n];
    if (!a) return tgReply(chatId, `Alerte ${n+1} introuvable\. Tape /liste pour voir la liste\.`);
    DB.alerts[n] = { ...a, active: true }; dbSave();
    syncTimers();
    return tgReply(chatId, `🟢 Alerte *${a.name}* réactivée\.`);
  }

  if (lower.startsWith('/supprimer ')) {
    const n = parseInt(lower.replace('/supprimer ','')) - 1;
    const a = DB.alerts[n];
    if (!a) return tgReply(chatId, `Alerte ${n+1} introuvable\. Tape /liste pour voir la liste\.`);
    stopTimer(a.id);
    DB.alerts.splice(n, 1);
    delete DB.seen[a.id]; dbSave();
    return tgReply(chatId, `🗑 Alerte *${a.name}* supprimée\.`);
  }

  if (lower === '/bilan') {
    const since = Date.now() - 24*3600*1000;
    const today = DB.logs.filter(l => l.ts >= since);
    if (today.length === 0) return tgReply(chatId, 'Aucune annonce trouvée ces dernières 24h\.');
    const byAlert = {};
    today.forEach(l => { byAlert[l.aname] = (byAlert[l.aname]||0) + 1; });
    let msg = `*Bilan des dernières 24h* — ${today.length} annonce(s)\n\n`;
    Object.entries(byAlert).forEach(([name, count]) => { msg += `• ${name} : ${count}\n`; });
    return tgReply(chatId, msg);
  }

  if (lower === '/nouvelle') {
    conversations[chatId] = { step: 'name' };
    return tgReply(chatId, '➕ *Nouvelle alerte* — étape 1/4\n\nDonne un nom à cette alerte :\n_ex: Xbox Series S, Veste cuir_');
  }

  // Commande inconnue
  return tgReply(chatId, 'Commande inconnue\. Tape /aide pour voir la liste des commandes\.');
}

async function handleConversationStep(chatId, text, conv) {
  const lower = text.toLowerCase();

  // Annulation à tout moment
  if (lower === '/annuler' || lower === 'annuler') {
    delete conversations[chatId];
    return tgReply(chatId, '❌ Création annulée\. Tape /nouvelle pour recommencer\.');
  }

  if (conv.step === 'name') {
    conversations[chatId] = { ...conv, step: 'kw', name: text };
    return tgReply(chatId, `➕ *Nouvelle alerte* — étape 2/4\n\nMots-clés de recherche :\n_ex: xbox series s, nike air force 1 42_\n\n_Tape "annuler" pour abandonner_`);
  }

  if (conv.step === 'kw') {
    conversations[chatId] = { ...conv, step: 'price', kw: text };
    return tgReply(chatId, `➕ *Nouvelle alerte* — étape 3/4\n\nPrix maximum en € ? \n_ex: 100_\n_Tape "non" pour aucune limite_`);
  }

  if (conv.step === 'price') {
    const max = lower === 'non' ? '' : text.replace('€','').trim();
    conversations[chatId] = { ...conv, step: 'exclude', max };
    return tgReply(chatId, `➕ *Nouvelle alerte* — étape 4/4\n\nMots à exclure ? \n_ex: carte, boîte, accessoire_\n_Tape "aucun" pour ne rien exclure_`);
  }

  if (conv.step === 'exclude') {
    const excludeKw = (lower === 'aucun' || lower === 'non') ? '' : text;
    const newAlert  = {
      id:        uid(),
      name:      conv.name,
      kw:        conv.kw,
      max:       conv.max,
      min:       '',
      stars:     '4',
      excludeKw,
      active:    true,
      badge:     0,
    };
    DB.alerts.push(newAlert); dbSave();
    delete conversations[chatId];
    syncTimers();

    let summary = `✅ *Alerte créée !*\n\n`;
    summary += `📌 Nom : ${newAlert.name}\n`;
    summary += `🔍 Mots-clés : ${newAlert.kw}\n`;
    if (newAlert.max)       summary += `💶 Prix max : ${newAlert.max}€\n`;
    if (newAlert.excludeKw) summary += `🚫 Exclusions : ${newAlert.excludeKw}\n`;
    summary += `\nLa première vérification démarre dans quelques secondes\.`;
    pollAlert(newAlert);
    return tgReply(chatId, summary);
  }
}

// ── Webhook Telegram ─────────────────────────────────────────────────────────
// Telegram pousse les messages directement vers /webhook/telegram
// Beaucoup plus fiable que le long polling sur Railway

let tgPolling = false; // gardé pour compatibilité

async function registerWebhook(appUrl) {
  if (!DB.tg.token) return;
  const webhookUrl = `${appUrl}/webhook/telegram`;
  try {
    const body = JSON.stringify({ url: webhookUrl, allowed_updates: ['message'] });
    const r    = await new Promise((resolve, reject) => {
      const u   = new URL(`https://api.telegram.org/bot${DB.tg.token}/setWebhook`);
      const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10000 }, res => {
        const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c).toString()));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body); req.end();
    });
    const d = JSON.parse(r);
    if (d.ok) {
      console.log(`[bot] Webhook enregistré → ${webhookUrl}`);
      tgPolling = true;
    } else {
      console.log('[bot] Erreur webhook:', d.description);
    }
  } catch(e) {
    console.log('[bot] Erreur enregistrement webhook:', e.message);
  }
}

// Appelé au démarrage et quand les settings sont sauvegardés
async function startTgBot() {
  const appUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.APP_URL || '';
  if (!appUrl) {
    console.log('[bot] APP_URL non définie — webhook non enregistré');
    return;
  }
  await registerWebhook(appUrl);
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

    const excludeList = parseExcludeKw(a.excludeKw);

    const items = data.items.filter(it => {
      // Filtre note vendeur
      const rep = it.user?.feedback_reputation;
      if (rep != null && (rep<=1?rep*5:rep) < parseFloat(a.stars||0)) return false;
      // Filtre mots exclus
      if (isExcluded(it, excludeList)) return false;
      return true;
    });

    const prev     = new Set(DB.seen[a.id] || []);
    const newItems = items.filter(it => !prev.has(String(it.id)));
    DB.seen[a.id]  = items.map(it => String(it.id));

    if (newItems.length > 0) {
      console.log(`[poll] "${a.name}" : ${newItems.length} nouvelle(s)`);

      DB.logs = [
        ...newItems.map(it => {
          const price = extractPrice(it);
          return {
            id:        uid(),
            aid:       a.id,
            aname:     a.name,
            title:     it.title,
            price:     formatPrice(price),
            url:       it.url ?? it.path,
            img:       it.photos?.[0]?.thumb_url ?? it.photo?.url,
            stars:     it.user?.feedback_reputation,
            condition: it.status,
            seller:    it.user?.login,
            ts:        Date.now(),
          };
        }),
        ...DB.logs,
      ].slice(0, 200);

      a.badge = (a.badge || 0) + newItems.length;

      for (const it of newItems.slice(0, 5)) {
        const price = extractPrice(it);
        const msg   = buildTgMessage(it, a.name, price);
        await tgSend(msg);
        await new Promise(r => setTimeout(r, 400));
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

  if (p === '/' || p === '/index.html') {
    const f = path.join(__dirname, 'index.html');
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(f)); }
    else { res.writeHead(404); res.end('index.html introuvable'); }
    return;
  }

  if (p === '/api/alerts' && me === 'GET')  return jsonRes(res, 200, DB.alerts);

  if (p === '/api/alerts' && me === 'POST') {
    const b = await readBody(req);
    const a = { id: uid(), badge: 0, active: true, ...b };
    DB.alerts.push(a); dbSave();
    pollAlert(a);
    return jsonRes(res, 201, a);
  }

  if (p.startsWith('/api/alerts/') && me === 'PUT') {
    const id = p.split('/')[3];
    const b  = await readBody(req);
    const i  = DB.alerts.findIndex(a => a.id === id);
    if (i === -1) return jsonRes(res, 404, { error: 'not found' });
    DB.alerts[i] = { ...DB.alerts[i], ...b }; dbSave();
    return jsonRes(res, 200, DB.alerts[i]);
  }

  if (p.startsWith('/api/alerts/') && me === 'DELETE') {
    const id = p.split('/')[3];
    DB.alerts = DB.alerts.filter(a => a.id !== id);
    delete DB.seen[id]; dbSave();
    return jsonRes(res, 200, { ok: true });
  }

  if (p === '/api/logs'  && me === 'GET')    return jsonRes(res, 200, DB.logs);
  if (p === '/api/logs'  && me === 'DELETE') { DB.logs = []; dbSave(); return jsonRes(res, 200, { ok: true }); }

  if (p === '/api/settings' && me === 'GET')  return jsonRes(res, 200, { token: DB.tg.token ? '***' : '', chatId: DB.tg.chatId });

  if (p === '/api/settings' && me === 'POST') {
    const b = await readBody(req);
    if (b.token)               DB.tg.token  = b.token;
    if (b.chatId !== undefined) DB.tg.chatId = b.chatId;
    dbSave();
    if (DB.tg.token && DB.tg.chatId) startTgBot();
    return jsonRes(res, 200, { ok: true });
  }

  if (p === '/api/test-telegram' && me === 'POST') {
    const b   = await readBody(req);
    const tok = b.token  || DB.tg.token;
    const cid = b.chatId || DB.tg.chatId;
    if (!tok || !cid) return jsonRes(res, 400, { error: 'Token ou Chat ID manquant' });
    const d = await tgSend('✅ *Vinted Alertes connecté !*\nTu recevras tes notifications ici.\n\nTape /aide dans ce chat pour gérer tes alertes.', tok, cid);
    if (d.ok) { DB.tg = { token: tok, chatId: cid }; dbSave(); startTgBot(); }
    return jsonRes(res, d.ok ? 200 : 400, d);
  }

  if (p === '/health') return jsonRes(res, 200, { ok: true, alerts: DB.alerts.filter(a=>a.active).length, uptime: Math.round(process.uptime()) });

  // ── Réception des messages Telegram (webhook) ──
  if (p === '/webhook/telegram' && me === 'POST') {
    try {
      const b = await readBody(req);
      if (b.message) {
        handleTgMessage(b.message).catch(e => console.log('[bot] handler erreur:', e.message));
      }
    } catch {}
    res.writeHead(200); res.end('ok');
    return;
  }

  res.writeHead(404); res.end('Not found');
});

dbLoad();
server.listen(PORT, async () => {
  console.log(`\n  Vinted Alertes cloud v3 — port ${PORT}`);
  console.log(`  ${DB.alerts.filter(a=>a.active).length} alerte(s) active(s)\n`);
  await initSession();
  console.log(`\n  Polling toutes les ${POLL_MS/1000}s — démarrage dans 3s...\n`);
  setTimeout(() => { pollAll(); setInterval(pollAll, POLL_MS); }, 3000);
  // Démarrer le bot Telegram si configuré
  if (DB.tg.token && DB.tg.chatId) {
    setTimeout(startTgBot, 4000);
  }
});

server.on('error', e => { console.error('Erreur:', e.message); process.exit(1); });
