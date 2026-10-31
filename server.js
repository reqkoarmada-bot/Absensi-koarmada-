// Web absensi Discord — tanpa dependency, cukup Node 18+ (`node server.js`).
const http = require('http');
const fs = require('fs');
const path = require('path');

const API = 'https://discord.com/api/v10';
const TZ = 'Asia/Jakarta';
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Discord REST helper (auto-retry saat rate limit) ----------
async function dc(token, p, opts = {}, tries = 0) {
  const headers = { Authorization: 'Bot ' + token, 'User-Agent': 'AbsensiWeb (self-hosted, 1.0)' };
  const init = { method: opts.method || 'GET', headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(API + p, init);
  if (res.status === 429 && tries < 6) {
    const j = await res.json().catch(() => ({}));
    await sleep(Math.ceil((j.retry_after || 1) * 1000) + 150);
    return dc(token, p, opts, tries + 1);
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const err = new Error(j.message || 'Discord error ' + res.status);
    err.status = res.status;
    err.code = j.code;
    throw err;
  }
  return res.json();
}

const snow = (ms) => ((BigInt(ms) - 1420070400000n) << 22n).toString();
const dateKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));

function avatarUrl(user) {
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=64`;
  }
  return `https://cdn.discordapp.com/embed/avatars/${(BigInt(user.id) >> 22n) % 6n}.png`;
}

async function pool(items, n, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- Ambil data ----------
async function fetchMonthMessages(token, channelId, startMs, endMs) {
  const out = [];
  let before = snow(endMs);
  for (let page = 0; page < 60; page++) {
    const batch = await dc(token, `/channels/${channelId}/messages?limit=100&before=${before}`);
    if (!batch.length) break;
    let reachedStart = false;
    for (const m of batch) {
      const ts = Date.parse(m.timestamp);
      if (ts < startMs) reachedStart = true;
      else if (ts < endMs) out.push(m);
    }
    if (reachedStart || batch.length < 100) break;
    before = batch[batch.length - 1].id;
  }
  return out;
}

async function fetchReactors(token, channelId, msgId, emoji) {
  const key = encodeURIComponent(emoji.id ? `${emoji.name || '_'}:${emoji.id}` : emoji.name);
  const users = [];
  let after;
  for (let page = 0; page < 20; page++) {
    const b = await dc(
      token,
      `/channels/${channelId}/messages/${msgId}/reactions/${key}?limit=100${after ? '&after=' + after : ''}`
    );
    users.push(...b);
    if (b.length < 100) break;
    after = b[b.length - 1].id;
  }
  return users;
}

async function fetchGuildMembers(token, guildId) {
  const all = [];
  let after = '0';
  for (let page = 0; page < 30; page++) {
    const b = await dc(token, `/guilds/${guildId}/members?limit=1000&after=${after}`);
    all.push(...b);
    if (b.length < 1000) break;
    after = b[b.length - 1].user.id;
  }
  return all;
}

// ---------- Handlers ----------
const tokenOf = (body) => String(body.token || '').trim();
const idOk = (s) => /^\d{5,25}$/.test(String(s || ''));

function userError(msg) {
  const e = new Error(msg);
  e.userError = true;
  return e;
}

function errorResponse(e) {
  let msg = e.message;
  let status = e.status || 500;
  if (e.status === 401) msg = 'Token bot salah atau sudah di-reset.';
  else if (e.status === 403)
    msg = 'Bot tidak punya akses. Pastikan bot sudah masuk server dan punya izin View Channel + Read Message History di channel absensi.';
  else if (e.status === 404) msg = 'Server atau channel tidak ditemukan. Cek lagi ID-nya.';
  if (e.userError) status = 400;
  return { status: status >= 400 && status < 600 ? status : 500, body: { error: msg } };
}

async function verify(body) {
  const token = tokenOf(body);
  const { guildId, channelId } = body;
  if (!token) throw userError('Token bot wajib diisi.');
  if (!idOk(guildId) || !idOk(channelId)) throw userError('ID server dan ID channel harus berupa angka.');
  const channel = await dc(token, `/channels/${channelId}`);
  if (String(channel.guild_id) !== String(guildId)) throw userError('Channel ini bukan bagian dari server tersebut.');
  const guild = await dc(token, `/guilds/${guildId}`);
  return { ok: true, channelName: channel.name, guildName: guild.name };
}

async function attendance(body) {
  const token = tokenOf(body);
  const { guildId, channelId } = body;
  const roleId = String(body.roleId || '').trim();
  const keyword = String(body.keyword || '').trim().toLowerCase();
  if (!token) throw userError('Token bot wajib diisi.');
  if (!idOk(guildId) || !idOk(channelId)) throw userError('ID server dan ID channel harus berupa angka.');
  if (roleId && !idOk(roleId)) throw userError('ID role harus berupa angka.');

  const nowKey = dateKey(new Date().toISOString());
  const month = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : nowKey.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const startMs = Date.parse(`${month}-01T00:00:00+07:00`);
  const endMs = Date.parse(`${ny}-${String(nm).padStart(2, '0')}-01T00:00:00+07:00`);

  // 1. Pesan absensi di bulan itu
  const messages = await fetchMonthMessages(token, channelId, startMs, endMs);
  const posts = messages.filter((msg) => {
    if (keyword) return (msg.content || '').toLowerCase().includes(keyword);
    return msg.reactions && msg.reactions.length > 0;
  });

  // 2. Siapa saja yang react
  const reactorsByPost = await pool(posts, 3, async (msg) => {
    const seen = new Map();
    for (const r of msg.reactions || []) {
      const users = await fetchReactors(token, channelId, msg.id, r.emoji);
      for (const u of users) if (!u.bot) seen.set(u.id, u);
    }
    return seen;
  });

  // 3. Daftar anggota (butuh Server Members Intent; kalau gagal, pakai yang pernah react)
  let guildMembers = null;
  try {
    guildMembers = await fetchGuildMembers(token, guildId);
  } catch (e) {
    guildMembers = null;
  }

  const members = new Map();
  if (guildMembers) {
    for (const gm of guildMembers) {
      if (gm.user.bot) continue;
      if (roleId && !(gm.roles || []).includes(roleId)) continue;
      members.set(gm.user.id, {
        id: gm.user.id,
        name: gm.nick || gm.user.global_name || gm.user.username,
        avatar: avatarUrl(gm.user),
      });
    }
  }

  const att = {};
  const dayPosts = {};
  const attSets = {};
  posts.forEach((msg, i) => {
    const day = dateKey(msg.timestamp);
    dayPosts[day] = (dayPosts[day] || 0) + 1;
    for (const [uid, u] of reactorsByPost[i]) {
      if (guildMembers && roleId && !members.has(uid)) continue;
      if (!members.has(uid)) {
        members.set(uid, { id: uid, name: u.global_name || u.username, avatar: avatarUrl(u) });
      }
      (attSets[uid] = attSets[uid] || new Set()).add(day);
    }
  });
  for (const [uid, set] of Object.entries(attSets)) att[uid] = [...set].sort();

  return {
    month,
    today: nowKey,
    days: Object.keys(dayPosts).sort(),
    posts: posts.map((p) => ({ id: p.id, date: dateKey(p.timestamp), text: (p.content || '').slice(0, 120) })),
    members: [...members.values()].sort((a, b) => a.name.localeCompare(b.name, 'id')),
    attendance: att,
    membersSource: guildMembers ? (roleId ? 'role' : 'server') : 'reactions',
  };
}

// ---------- Kirim peringatan lewat DM ----------
const DM_ERRORS = {
  50007: 'DM anggota ini tertutup (tidak menerima pesan dari bot).',
  10013: 'Pengguna tidak ditemukan.',
  40003: 'Terlalu cepat membuka DM, coba lagi beberapa menit lagi.',
};

async function sendDm(token, userId, content) {
  const ch = await dc(token, '/users/@me/channels', { method: 'POST', body: { recipient_id: userId } });
  await dc(token, `/channels/${ch.id}/messages`, {
    method: 'POST',
    body: { content, allowed_mentions: { parse: [] } },
  });
}

async function dm(body) {
  const token = tokenOf(body);
  if (!token) throw userError('Token bot wajib diisi.');
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw userError('Pilih minimal satu anggota.');
  if (items.length > 25) throw userError('Maksimal 25 DM per permintaan.');
  for (const it of items) {
    if (!it || !idOk(it.userId)) throw userError('ID anggota tidak valid.');
    const text = String(it.message || '').trim();
    if (!text) throw userError('Isi pesan tidak boleh kosong.');
    if (text.length > 1900) throw userError('Pesan terlalu panjang (maksimal 1900 karakter).');
  }
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const userId = String(items[i].userId);
    try {
      await sendDm(token, userId, String(items[i].message).trim());
      results.push({ userId, ok: true });
    } catch (e) {
      if (e.status === 401) throw e;
      results.push({ userId, ok: false, error: DM_ERRORS[e.code] || e.message || 'Gagal mengirim.' });
    }
    if (i < items.length - 1) await sleep(1200); // jeda supaya tidak kena batas Discord
  }
  return { results };
}

const routes = {
  'POST /api/verify': verify,
  'POST /api/attendance': attendance,
  'POST /api/dm': dm,
  'GET /api/config': async () => ({ hasEnvToken: false }),
};

// ---------- HTTP server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(userError('Permintaan terlalu besar.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(userError('Format permintaan tidak valid.')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file;
  try { file = path.join(PUBLIC_DIR, decodeURIComponent(rel)); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Tidak ditemukan'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const handler = routes[req.method + ' ' + pathname];
  if (handler) {
    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      sendJson(res, 200, await handler(body));
    } catch (e) {
      const r = errorResponse(e);
      sendJson(res, r.status, r.body);
    }
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
  res.writeHead(405); res.end();
});

server.listen(PORT, () => console.log(`Web absensi jalan di http://localhost:${PORT}`));
    
