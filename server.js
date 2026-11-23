"use strict";
/**
 * CLASS FIGHTERS - servidor de salas + relay (WebSocket).
 *
 * El anfitrión (jugador) sigue siendo la autoridad del combate; este servidor solo:
 *   1. crea salas con un código ÚNICO generado aquí (6 caracteres, sin ambiguos),
 *   2. reenvía paquetes entre el anfitrión y los clientes (topología en estrella),
 * así nadie necesita abrir puertos ni conocer la IP de nadie.
 *
 * Protocolo
 *   Texto (JSON), control:
 *     cliente -> servidor  {"t":"host","proto":1,"public":false,"title":"","name":"","max":4,"token":""}
 *                                                           crea sala (opciones opcionales: public = sale en la
 *                                                           lista de salas; token = sesión de cuenta, sus amigos
 *                                                           ven la sala en su lista)
 *                          {"t":"info","players":N,"in_match":false,"title":"","public":false}   (solo anfitrión) actualiza la lista
 *                          {"t":"join","proto":1,"code":"ABC-DEF"}  entra en sala
 *                          {"t":"kick","id":N}               (solo anfitrión)
 *     servidor -> cliente  {"t":"hosted","code":"ABCDEF","public":false}
 *                          {"t":"joined","id":N}             (N >= 2; el anfitrión es 1)
 *                          {"t":"peer_joined","id":N} / {"t":"peer_left","id":N}   (al anfitrión)
 *                          {"t":"host_left"}                 (a los clientes; la sala se cierra)
 *                          {"t":"error","code":"...","msg":"..."}
 *   HTTP: GET /api/rooms (salas públicas, JSON) · GET /status (JSON) · GET /health (texto) · GET / (página de estado)
 *   Binario, datos: [int32 LE destino/origen][u8 canal][u8 modo][carga...]
 *     anfitrión -> servidor: destino = id (>0), 0 = todos, <0 = todos menos |id|
 *     cliente   -> servidor: el destino se ignora: siempre va al anfitrión
 *     servidor  -> receptor: el campo pasa a ser el ORIGEN (1 si viene del anfitrión)
 *     modo = TransferMode de Godot (0 no fiable, 1 no fiable ordenado, 2 fiable).
 */
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { createAccountApi } = require("./accounts");
const status = require("./status");

// Las salas de cada usuario con cuenta: sus amigos las ven en su lista (accounts.js -> friendView).
const roomByOwner = new Map();   // id de usuario -> Room
const accounts = createAccountApi({
  roomOf: (userId) => {
    const room = roomByOwner.get(userId);
    if (!room) return null;
    return { code: room.code, players: status.playersOf(room), max: room.max, in_match: room.inMatch, public: room.isPublic };
  },
});
const startedAt = Date.now();

const PORT = parseInt(process.env.PORT || "8080", 10);
const PROTO = 1;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sin I, L, O, 0, 1
const CODE_LENGTH = 6;
const MAX_CLIENTS = 6;               // el juego admite 4 jugadores; margen para reconexiones y rechazos
const MAX_ROOMS = 300;
const MAX_PUBLIC_ROOMS = 100;
const MAX_PACKET = 64 * 1024;
const HEADER = 6;
const HELLO_TIMEOUT_MS = 10_000;
const EMPTY_ROOM_TTL_MS = 20 * 60_000;
const CODE_QUARANTINE_MS = 60 * 60_000; // un código cerrado no se vuelve a emitir en 1 h
const MAX_MSGS_PER_SEC = 600;
const MAX_BYTES_PER_SEC = 400 * 1024;
const DROP_UNRELIABLE_ABOVE = 128 * 1024; // si el receptor va atrasado, se descartan paquetes no fiables

const rooms = new Map();        // code -> Room
const recentCodes = new Map();  // code -> expiración (ms)

class Room {
  constructor(code, host, options = {}) {
    this.code = code;
    this.host = host;
    this.clients = new Map();   // id -> ws
    this.nextId = 2;
    this.lastActivity = Date.now();
    this.createdAt = Date.now();
    this.isPublic = options.isPublic === true;   // pública: sale en la lista; privada: solo con el código
    this.title = options.title || "";
    this.hostName = options.hostName || "Jugador";
    this.max = options.max || 4;
    this.players = 1;                            // los cuenta el anfitrión (mensaje "info")
    this.inMatch = false;
    this.ownerId = options.ownerId || null;      // usuario con cuenta (para sus amigos)
  }
}

function normalizeCode(text) {
  return String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function newCode() {
  const now = Date.now();
  for (const [code, until] of recentCodes) if (until <= now) recentCodes.delete(code);
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!rooms.has(code) && !recentCodes.has(code)) return code;
  }
  return null;
}

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function fail(ws, code, msg) {
  sendJson(ws, { t: "error", code, msg });
  setTimeout(() => ws.close(1008, code), 150);
}

function closeRoom(room, notifyClients) {
  if (rooms.get(room.code) !== room) return;
  rooms.delete(room.code);
  if (room.ownerId && roomByOwner.get(room.ownerId) === room) roomByOwner.delete(room.ownerId);
  recentCodes.set(room.code, Date.now() + CODE_QUARANTINE_MS);
  for (const client of room.clients.values()) {
    if (notifyClients) sendJson(client, { t: "host_left" });
    client.room = null;
    setTimeout(() => client.close(1000, "host_left"), 150);
  }
  room.clients.clear();
}

function handleControl(ws, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return fail(ws, "bad_message", "Mensaje no válido."); }
  if (!msg || typeof msg.t !== "string") return fail(ws, "bad_message", "Mensaje no válido.");

  if (!ws.room) {
    if (msg.proto !== PROTO) return fail(ws, "bad_proto", "Versión del servidor de salas incompatible. Actualiza el juego.");
    if (msg.t === "host") {
      if (rooms.size >= MAX_ROOMS) return fail(ws, "busy", "El servidor está lleno. Inténtalo más tarde.");
      const isPublic = msg.public === true;
      if (isPublic && publicCount() >= MAX_PUBLIC_ROOMS) return fail(ws, "busy", "Hay demasiadas salas públicas abiertas. Crea una privada o inténtalo más tarde.");
      const code = newCode();
      if (!code) return fail(ws, "busy", "No se pudo generar un código. Inténtalo de nuevo.");
      const owner = msg.token ? accounts.identify(msg.token) : null;
      if (owner && roomByOwner.has(owner.id)) {   // una sala por cuenta: se cierra la anterior
        const old = roomByOwner.get(owner.id);
        closeRoom(old, true);
        sendJson(old.host, { t: "error", code: "replaced", msg: "Creaste otra sala con tu cuenta." });
        setTimeout(() => old.host.close(1000, "replaced"), 150);
      }
      const hostName = status.sanitizeText(msg.name, owner ? owner.name : "Jugador", 14);
      const room = new Room(code, ws, {
        isPublic,
        title: status.sanitizeText(msg.title, "", 24),
        hostName,
        max: status.clampInt(msg.max, 2, 4, 4),
        ownerId: owner ? owner.id : null,
      });
      rooms.set(code, room);
      if (owner) roomByOwner.set(owner.id, room);
      ws.room = room; ws.id = 1; ws.isHost = true;
      clearTimeout(ws.helloTimer);
      sendJson(ws, { t: "hosted", code, public: isPublic });
    } else if (msg.t === "join") {
      const code = normalizeCode(msg.code);
      const room = rooms.get(code);
      if (!room) return fail(ws, "no_room", "No existe ninguna sala con ese código (o ya se cerró).");
      if (room.clients.size >= MAX_CLIENTS) return fail(ws, "full", "La sala está llena.");
      const id = room.nextId++;
      room.clients.set(id, ws);
      room.lastActivity = Date.now();
      ws.room = room; ws.id = id; ws.isHost = false;
      clearTimeout(ws.helloTimer);
      sendJson(ws, { t: "joined", id });
      sendJson(room.host, { t: "peer_joined", id });
    } else {
      fail(ws, "bad_message", "Primero hay que crear o unirse a una sala.");
    }
    return;
  }

  if (msg.t === "info" && ws.isHost) {
    // El anfitrión cuenta cuántos jugadores hay y si están en combate (lo ve la lista de salas).
    const room = ws.room;
    room.players = status.clampInt(msg.players, 1, room.max, room.players);
    room.inMatch = msg.in_match === true;
    if (msg.title !== undefined) room.title = status.sanitizeText(msg.title, "", 24);
    if (msg.public !== undefined) {   // el anfitrión puede abrir la sala al público (o cerrarla) mientras espera
      const wantPublic = msg.public === true;
      if (!wantPublic || room.isPublic || publicCount() < MAX_PUBLIC_ROOMS) room.isPublic = wantPublic;
    }
    room.lastActivity = Date.now();
    return;
  }
  if (msg.t === "kick" && ws.isHost) {
    const target = ws.room.clients.get(msg.id | 0);
    if (target) setTimeout(() => target.close(1000, "kicked"), 50);
  }
}

function handleData(ws, buf) {
  const room = ws.room;
  if (!room || buf.length < HEADER || buf.length > MAX_PACKET + HEADER) return;
  room.lastActivity = Date.now();
  const mode = buf[5];
  const droppable = mode !== 2;
  const send = (dest) => {
    if (!dest || dest.readyState !== dest.OPEN) return;
    if (droppable && dest.bufferedAmount > DROP_UNRELIABLE_ABOVE) return;
    dest.send(buf, { binary: true });
  };
  if (!ws.isHost) {
    buf.writeInt32LE(ws.id, 0);
    send(room.host);
    return;
  }
  const target = buf.readInt32LE(0);
  buf.writeInt32LE(1, 0);
  if (target === 0) {
    for (const client of room.clients.values()) send(client);
  } else if (target > 0) {
    send(room.clients.get(target));
  } else {
    for (const [id, client] of room.clients) if (id !== -target) send(client);
  }
}

function publicCount() {
  let count = 0;
  for (const room of rooms.values()) if (room.isPublic) count++;
  return count;
}

function currentStats() {
  return status.summarize(rooms.values(), wss.clients.size, startedAt, Date.now(), Object.keys(accounts._db.users).length);
}

let listCache = { at: 0, json: "" };
function sendRoomList(res) {
  const now = Date.now();
  if (now - listCache.at > 2000) {   // la lista se recalcula como mucho cada 2 s
    listCache = { at: now, json: JSON.stringify({ ok: true, rooms: status.publicList(rooms.values(), now) }) };
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end(listCache.json);
}

const server = http.createServer(async (req, res) => {
  const route = new URL(req.url, "http://x").pathname;
  if (route === "/api/rooms" && req.method === "GET") return sendRoomList(res);   // salas públicas
  if (await accounts.handle(req, res)) return;   // cuentas, amigos y QR (/api/*, /f/CODIGO)
  if (route === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(status.healthText(currentStats()));
  } else if (route === "/status") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, proto: PROTO, ...currentStats() }));
  } else if (route === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(status.dashboardHtml(currentStats(), status.publicList(rooms.values(), Date.now())));
  } else {
    res.writeHead(404); res.end();
  }
});

const wss = new WebSocketServer({ server, maxPayload: MAX_PACKET + HEADER });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.msgs = 0;
  ws.bytes = 0;
  ws.helloTimer = setTimeout(() => { if (!ws.room) ws.close(1008, "timeout"); }, HELLO_TIMEOUT_MS);
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (data, isBinary) => {
    ws.isAlive = true;
    ws.msgs++;
    ws.bytes += data.length;
    if (ws.msgs > MAX_MSGS_PER_SEC || ws.bytes > MAX_BYTES_PER_SEC) return ws.close(1008, "rate_limit");
    if (isBinary) handleData(ws, Buffer.isBuffer(data) ? data : Buffer.concat(data));
    else handleControl(ws, data.toString("utf8"));
  });
  ws.on("close", () => {
    clearTimeout(ws.helloTimer);
    const room = ws.room;
    if (!room) return;
    ws.room = null;
    if (ws.isHost) {
      closeRoom(room, true);
    } else if (room.clients.get(ws.id) === ws) {
      room.clients.delete(ws.id);
      room.lastActivity = Date.now();
      sendJson(room.host, { t: "peer_left", id: ws.id });
    }
  });
  ws.on("error", () => {});
});

setInterval(() => {            // contadores por segundo
  for (const ws of wss.clients) { ws.msgs = 0; ws.bytes = 0; }
}, 1000).unref();

setInterval(() => {            // latido y limpieza
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.clients.size === 0 && now - room.lastActivity > EMPTY_ROOM_TTL_MS) {
      room.host.close(1000, "idle");
    }
  }
}, 20_000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`[relay] escuchando en el puerto ${PORT}`));
}
module.exports = { server, wss, rooms, accounts, normalizeCode, ALPHABET, CODE_LENGTH, roomByOwner };
