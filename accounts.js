"use strict";
/**
 * CLASS FIGHTERS - cuentas, amigos y solicitudes (API HTTP + JSON), sin dependencias.
 * Se monta en el mismo servidor del relay (server.js). Los datos se guardan en un archivo JSON
 * (DATA_DIR/accounts.json). En hosting con disco temporal (Render gratis) ese archivo se borra al
 * reiniciar: pon DATA_DIR en un disco persistente (ver GUIA_CUENTAS_AMIGOS.md).
 *
 * Todas las respuestas son JSON: {ok:true, ...} o {error:"codigo", msg:"texto"}.
 *   POST /api/register  {username, password}        -> {token, user}
 *   POST /api/login     {username, password}        -> {token, user}
 *   GET  /api/me                          (token)   -> {user, friends, incoming, outgoing}
 *   GET  /api/qr                          (token)   -> {link, qr:{size, rows}}
 *   POST /api/friends/request {target}    (token)   target = código de amigo o nombre de usuario
 *   POST /api/friends/accept  {code}      (token)
 *   POST /api/friends/decline {code}      (token)   rechaza una solicitud recibida o cancela una enviada
 *   POST /api/friends/remove  {code}      (token)
 *   GET  /f/CODIGO                                  -> página que se abre al escanear el QR
 * El token va en la cabecera "Authorization: Bearer ...".
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { encode } = require("./qr");

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const FRIEND_CODE_LENGTH = 8;
const NAME_RE = /^[A-Za-z0-9_]{3,14}$/;
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 64;
const TOKEN_DAYS = 90;
const ONLINE_WINDOW_MS = 75_000;
const MAX_FRIENDS = 100;
const MAX_PENDING = 50;
const MAX_BODY = 4096;
const AUTH_ATTEMPTS = 20;          // intentos de registro/login por IP...
const AUTH_WINDOW_MS = 10 * 60_000; // ...cada 10 minutos
const MAX_USERS = 50_000;

function normalizeCode(text) {
  return String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function createAccountApi(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, "data");
  const publicUrl = options.publicUrl || process.env.PUBLIC_URL || "";
  // roomOf(userId) -> {code, players, max, in_match, public} | null: la sala que tiene abierta ese
  // usuario. Sus amigos la ven en su lista y pueden entrar con un toque (ver server.js).
  const roomOf = typeof options.roomOf === "function" ? options.roomOf : () => null;
  const file = path.join(dataDir, "accounts.json");

  let db = { secret: "", users: {} };
  try {
    db = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* primera vez */
  }
  if (!db.users) db.users = {};
  if (!db.secret) db.secret = process.env.ACCOUNT_SECRET || crypto.randomBytes(32).toString("hex");
  const byName = new Map();
  const byCode = new Map();
  for (const user of Object.values(db.users)) {
    byName.set(user.nameLower, user);
    byCode.set(user.code, user);
  }

  let saveTimer = null;
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(flush, 400);
    if (saveTimer.unref) saveTimer.unref();
  }
  function flush() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error("[cuentas] no se pudo guardar:", err.message);
    }
  }

  // --- Contraseñas y tokens ---
  function hashPassword(password, salt) {
    return new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(key.toString("hex"))));
    });
  }

  function makeToken(user) {
    const payload = b64url(JSON.stringify({ id: user.id, exp: Date.now() + TOKEN_DAYS * 86_400_000 }));
    const sig = crypto.createHmac("sha256", db.secret).update(payload).digest("base64url");
    return `${payload}.${sig}`;
  }

  function userFromToken(req) {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const expected = crypto.createHmac("sha256", db.secret).update(payload).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (!data.exp || data.exp < Date.now()) return null;
      return db.users[data.id] || null;
    } catch {
      return null;
    }
  }

  // --- Límite de intentos por IP ---
  const attempts = new Map();
  function tooManyAttempts(req) {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const now = Date.now();
    let entry = attempts.get(ip);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + AUTH_WINDOW_MS };
      attempts.set(ip, entry);
    }
    entry.count++;
    if (attempts.size > 5000) for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
    return entry.count > AUTH_ATTEMPTS;
  }

  // --- Utilidades HTTP ---
  function sendJson(res, status, body) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(body));
  }
  function fail(res, status, code, msg) {
    sendJson(res, status, { error: code, msg });
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error("too_big"));
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch {
          reject(new Error("bad_json"));
        }
      });
      req.on("error", reject);
    });
  }
  function baseUrl(req) {
    if (publicUrl) return publicUrl.replace(/\/+$/, "");
    const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0];
    return `${proto}://${req.headers.host}`;
  }

  // --- Modelo ---
  function newFriendCode() {
    for (let i = 0; i < 200; i++) {
      let code = "";
      for (let j = 0; j < FRIEND_CODE_LENGTH; j++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
      if (!byCode.has(code)) return code;
    }
    throw new Error("sin códigos libres");
  }
  function publicUser(user) {
    return { name: user.name, code: user.code };
  }
  function friendView(user) {
    const view = { name: user.name, code: user.code, online: Date.now() - (user.lastSeen || 0) < ONLINE_WINDOW_MS };
    const room = roomOf(user.id);
    if (room) view.room = room;
    return view;
  }
  function listOf(ids, mapper) {
    return ids.map((id) => db.users[id]).filter(Boolean).map(mapper);
  }
  function snapshot(user) {
    const friends = listOf(user.friends, friendView).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    return {
      ok: true,
      user: publicUser(user),
      friends,
      incoming: listOf(user.incoming, publicUser),
      outgoing: listOf(user.outgoing, publicUser),
    };
  }
  const without = (list, id) => list.filter((x) => x !== id);

  function makeFriends(a, b) {
    for (const [x, y] of [[a, b], [b, a]]) {
      x.incoming = without(x.incoming, y.id);
      x.outgoing = without(x.outgoing, y.id);
      if (!x.friends.includes(y.id)) x.friends.push(y.id);
    }
  }

  // --- Rutas ---
  async function authRoute(req, res, register) {
    if (tooManyAttempts(req)) return fail(res, 429, "rate_limit", "Demasiados intentos. Espera unos minutos.");
    const body = await readBody(req);
    const name = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!NAME_RE.test(name)) return fail(res, 400, "bad_name", "El usuario debe tener de 3 a 14 letras, números o _.");
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      return fail(res, 400, "bad_password", `La contraseña debe tener entre ${MIN_PASSWORD} y ${MAX_PASSWORD} caracteres.`);
    }
    const lower = name.toLowerCase();
    if (register) {
      if (byName.has(lower)) return fail(res, 409, "name_taken", "Ese usuario ya existe.");
      if (Object.keys(db.users).length >= MAX_USERS) return fail(res, 503, "busy", "El servidor no admite más cuentas.");
      const salt = crypto.randomBytes(16).toString("hex");
      const user = {
        id: crypto.randomBytes(12).toString("hex"),
        name,
        nameLower: lower,
        salt,
        hash: await hashPassword(password, salt),
        code: newFriendCode(),
        created: Date.now(),
        lastSeen: Date.now(),
        friends: [],
        incoming: [],
        outgoing: [],
      };
      if (byName.has(lower)) return fail(res, 409, "name_taken", "Ese usuario ya existe.");
      db.users[user.id] = user;
      byName.set(lower, user);
      byCode.set(user.code, user);
      save();
      return sendJson(res, 200, { ok: true, token: makeToken(user), user: publicUser(user) });
    }
    const user = byName.get(lower);
    const hash = user ? await hashPassword(password, user.salt) : null;
    if (!user || !crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"))) {
      return fail(res, 401, "bad_credentials", "Usuario o contraseña incorrectos.");
    }
    user.lastSeen = Date.now();
    save();
    return sendJson(res, 200, { ok: true, token: makeToken(user), user: publicUser(user) });
  }

  function findTarget(text) {
    const raw = String(text || "").trim();
    return byCode.get(normalizeCode(raw)) || byName.get(raw.toLowerCase()) || null;
  }

  async function friendRoute(req, res, user, action) {
    const body = await readBody(req);
    if (action === "request") {
      const target = findTarget(body.target);
      if (!target) return fail(res, 404, "not_found", "No existe nadie con ese código o usuario.");
      if (target.id === user.id) return fail(res, 400, "self", "No puedes agregarte a ti mismo.");
      if (user.friends.includes(target.id)) return fail(res, 409, "already_friends", `Ya eres amigo de ${target.name}.`);
      if (user.incoming.includes(target.id)) {
        makeFriends(user, target); // ya te había mandado solicitud: quedan amigos
        save();
        return sendJson(res, 200, { ...snapshot(user), result: "accepted", name: target.name });
      }
      if (user.outgoing.includes(target.id)) return fail(res, 409, "already_sent", `Ya le enviaste una solicitud a ${target.name}.`);
      if (user.friends.length >= MAX_FRIENDS) return fail(res, 400, "friends_full", "Llegaste al máximo de amigos.");
      if (user.outgoing.length >= MAX_PENDING || target.incoming.length >= MAX_PENDING) {
        return fail(res, 400, "too_many", "Hay demasiadas solicitudes pendientes.");
      }
      user.outgoing.push(target.id);
      target.incoming.push(user.id);
      save();
      return sendJson(res, 200, { ...snapshot(user), result: "sent", name: target.name });
    }
    const other = byCode.get(normalizeCode(body.code));
    if (!other) return fail(res, 404, "not_found", "Ese jugador ya no existe.");
    if (action === "accept") {
      if (!user.incoming.includes(other.id)) return fail(res, 404, "no_request", "Esa solicitud ya no existe.");
      if (user.friends.length >= MAX_FRIENDS) return fail(res, 400, "friends_full", "Llegaste al máximo de amigos.");
      makeFriends(user, other);
    } else if (action === "decline") {
      user.incoming = without(user.incoming, other.id);
      other.outgoing = without(other.outgoing, user.id);
      user.outgoing = without(user.outgoing, other.id);
      other.incoming = without(other.incoming, user.id);
    } else if (action === "remove") {
      user.friends = without(user.friends, other.id);
      other.friends = without(other.friends, user.id);
    } else {
      return fail(res, 404, "not_found", "Acción desconocida.");
    }
    save();
    return sendJson(res, 200, snapshot(user));
  }

  function landingPage(req, code) {
    const user = byCode.get(code);
    const name = user ? user.name : "";
    const deep = `classfighters://add/${code}`;
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CLASS FIGHTERS - Agregar amigo</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#140c2c;color:#fff;font-family:system-ui,sans-serif;text-align:center}
main{max-width:360px;padding:24px}h1{color:#ffd21f;margin:0 0 8px}.code{font-size:34px;letter-spacing:4px;background:#241a48;border:3px solid #ffd21f;border-radius:12px;padding:14px;margin:16px 0}
a,button{display:block;width:100%;box-sizing:border-box;margin:8px 0;padding:14px;border:0;border-radius:10px;background:#ffd21f;color:#140c2c;font-weight:700;font-size:16px;text-decoration:none}</style></head>
<body><main><h1>CLASS FIGHTERS</h1>${name ? `<p><b>${name.replace(/[^A-Za-z0-9_]/g, "")}</b> quiere ser tu amigo.</p>` : "<p>Código de amigo no válido.</p>"}
<div class="code" id="c">${code}</div>
<button onclick="navigator.clipboard.writeText('${code}').then(()=>this.textContent='¡Copiado!')">COPIAR CÓDIGO</button>
<a href="${deep}">ABRIR EL JUEGO</a>
<p style="color:#aab">En el juego: AMIGOS &gt; AGREGAR y pega este código.</p></main></body></html>`;
    return html;
  }

  /** Devuelve true si la petición era de cuentas/amigos (y ya se respondió). */
  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const route = url.pathname;
    const landing = /^\/f\/([A-Za-z0-9-]+)$/.exec(route);
    if (landing) {
      const code = normalizeCode(landing[1]).slice(0, 16);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(landingPage(req, code));
      return true;
    }
    if (!route.startsWith("/api/")) return false;
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      res.end();
      return true;
    }
    try {
      if (route === "/api/ping") sendJson(res, 200, { ok: true });
      else if (route === "/api/register" && req.method === "POST") await authRoute(req, res, true);
      else if (route === "/api/login" && req.method === "POST") await authRoute(req, res, false);
      else {
        const user = userFromToken(req);
        if (!user) return fail(res, 401, "unauthorized", "Inicia sesión de nuevo."), true;
        user.lastSeen = Date.now();
        if (route === "/api/me" && req.method === "GET") sendJson(res, 200, snapshot(user));
        else if (route === "/api/qr" && req.method === "GET") {
          const link = `${baseUrl(req)}/f/${user.code}`;
          sendJson(res, 200, { ok: true, link, code: user.code, qr: encode(link) });
        } else if (route.startsWith("/api/friends/") && req.method === "POST") {
          await friendRoute(req, res, user, route.slice("/api/friends/".length));
        } else fail(res, 404, "not_found", "No existe.");
      }
    } catch (err) {
      if (err.message === "bad_json" || err.message === "too_big") fail(res, 400, err.message, "Petición no válida.");
      else {
        console.error("[cuentas]", err);
        fail(res, 500, "server_error", "Error del servidor.");
      }
    }
    return true;
  }

  /** Usuario de un token de sesión (para el relay), o null. Cuenta como "en línea". */
  function identify(token) {
    const user = userFromToken({ headers: { authorization: `Bearer ${String(token || "")}` } });
    if (!user) return null;
    user.lastSeen = Date.now();
    return { id: user.id, name: user.name };
  }

  return { handle, flush, identify, _db: db };
}

module.exports = { createAccountApi, normalizeCode };
