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
 *     cliente -> servidor  {"t":"host","proto":1}            crea sala
 *                          {"t":"join","proto":1,"code":"ABC-DEF"}  entra en sala
 *                          {"t":"kick","id":N}               (solo anfitrión)
 *     servidor -> cliente  {"t":"hosted","code":"ABCDEF"}
 *                          {"t":"joined","id":N}             (N >= 2; el anfitrión es 1)
 *                          {"t":"peer_joined","id":N} / {"t":"peer_left","id":N}   (al anfitrión)
 *                          {"t":"host_left"}                 (a los clientes; la sala se cierra)
 *                          {"t":"error","code":"...","msg":"..."}
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

const accounts = createAccountApi();

const PORT = parseInt(process.env.PORT || "8080", 10);
const PROTO = 1;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sin I, L, O, 0, 1
const CODE_LENGTH = 6;
const MAX_CLIENTS = 6;               // el juego admite 4 jugadores; margen para reconexiones y rechazos
const MAX_ROOMS = 300;
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
  constructor(code, host) {
    this.code = code;
    this.host = host;
    this.clients = new Map();   // id -> ws
    this.nextId = 2;
    this.lastActivity = Date.now();
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
      const code = newCode();
      if (!code) return fail(ws, "busy", "No se pudo generar un código. Inténtalo de nuevo.");
      const room = new Room(code, ws);
      rooms.set(code, room);
      ws.room = room; ws.id = 1; ws.isHost = true;
      clearTimeout(ws.helloTimer);
      sendJson(ws, { t: "hosted", code });
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

const server = http.createServer(async (req, res) => {
  if (await accounts.handle(req, res)) return;   // cuentas, amigos y QR (/api/*, /f/CODIGO)
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`CLASS FIGHTERS relay OK. Salas activas: ${rooms.size}\n`);
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
module.exports = { server, wss, rooms, accounts, normalizeCode, ALPHABET, CODE_LENGTH };
