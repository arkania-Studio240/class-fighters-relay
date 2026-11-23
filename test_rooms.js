"use strict";
// Pruebas de salas públicas/privadas, lista de salas, salas de amigos y la página de estado.
//   node test_rooms.js        (necesita `npm install` para tener ws)
const assert = require("assert");
const os = require("os");
const fs = require("fs");
const path = require("path");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cf-rooms-"));
const WebSocket = require("ws");
const { server, rooms } = require("./server.js");
const status = require("./status.js");

function client(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.inbox = []; ws.waiters = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const item = JSON.parse(data.toString());
      const w = ws.waiters.shift();
      if (w) w(item); else ws.inbox.push(item);
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
const next = (ws, ms = 1500) => new Promise((resolve, reject) => {
  if (ws.inbox.length) return resolve(ws.inbox.shift());
  const t = setTimeout(() => reject(new Error("timeout esperando mensaje")), ms);
  ws.waiters.push((m) => { clearTimeout(t); resolve(m); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const get = async (route, token) => {
    const res = await fetch(base + route, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const text = await res.text();
    return { status: res.status, text, json: () => JSON.parse(text) };
  };
  const post = async (route, body, token) => {
    const res = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return res.json();
  };
  let passed = 0;
  const ok = (name) => { passed++; console.log("  ok  " + name); };

  // 1. Sin opciones la sala es PRIVADA: no sale en la lista.
  const priv = await client(port);
  priv.send(JSON.stringify({ t: "host", proto: 1 }));
  const privMsg = await next(priv);
  assert.strictEqual(privMsg.t, "hosted");
  assert.strictEqual(privMsg.public, false);
  let list = (await get("/api/rooms")).json();
  assert.strictEqual(list.rooms.length, 0);
  ok("una sala creada sin opciones es privada y no sale en la lista");

  // 2. Sala pública: sale con título, anfitrión y jugadores; el título se limpia.
  const pub = await client(port);
  pub.send(JSON.stringify({ t: "host", proto: 1, public: true, title: "  Sala\n de   Leo  ", name: "Leo", max: 3 }));
  const pubMsg = await next(pub);
  assert.strictEqual(pubMsg.public, true);
  list = (await get("/api/rooms")).json();
  await sleep(2100); // la lista se cachea 2 s
  list = (await get("/api/rooms")).json();
  assert.strictEqual(list.rooms.length, 1);
  assert.strictEqual(list.rooms[0].code, pubMsg.code);
  assert.strictEqual(list.rooms[0].title, "Sala de Leo");
  assert.strictEqual(list.rooms[0].host, "Leo");
  assert.strictEqual(list.rooms[0].max, 3);
  assert.strictEqual(list.rooms[0].players, 1);
  assert.ok(!JSON.stringify(list).includes(privMsg.code), "la sala privada no debe aparecer");
  ok("la sala pública sale en /api/rooms (título limpio) y la privada no");

  // 3. El anfitrión actualiza jugadores y combate con "info"; el aforo manda.
  pub.send(JSON.stringify({ t: "info", players: 99, in_match: true }));
  await sleep(2100);
  list = (await get("/api/rooms")).json();
  assert.strictEqual(list.rooms[0].players, 3);
  assert.strictEqual(list.rooms[0].in_match, true);
  ok("info actualiza jugadores (máximo = aforo) y estado de combate");

  // 3b. El anfitrión puede hacer pública una sala privada (y volver a cerrarla).
  priv.send(JSON.stringify({ t: "info", players: 1, in_match: false, public: true }));
  await sleep(2100);
  list = (await get("/api/rooms")).json();
  assert.ok(list.rooms.some((r) => r.code === privMsg.code), "la sala debe salir al hacerla pública");
  priv.send(JSON.stringify({ t: "info", players: 1, in_match: false, public: false }));
  await sleep(2100);
  list = (await get("/api/rooms")).json();
  assert.ok(!list.rooms.some((r) => r.code === privMsg.code), "la sala debe desaparecer al hacerla privada");
  ok("el anfitrión puede abrir y cerrar su sala al público");

  // 4. Un cliente no puede mandar "info" (solo el anfitrión).
  const guest = await client(port);
  guest.send(JSON.stringify({ t: "join", proto: 1, code: pubMsg.code }));
  assert.strictEqual((await next(guest)).t, "joined");
  await next(pub); // peer_joined
  guest.send(JSON.stringify({ t: "info", players: 1, in_match: false }));
  await sleep(2100);
  list = (await get("/api/rooms")).json();
  assert.strictEqual(list.rooms[0].players, 3);
  assert.strictEqual(list.rooms[0].in_match, true);
  ok("un cliente no puede cambiar la información de la sala");

  // 5. /health, /status y la página de estado.
  const health = (await get("/health")).text;
  assert.match(health, /^CLASS FIGHTERS relay OK\. Salas activas: 2 \(1 pública, 1 privada\)/);
  const stat = (await get("/status")).json();
  assert.strictEqual(stat.rooms, 2);
  assert.strictEqual(stat.publicRooms, 1);
  assert.strictEqual(stat.privateRooms, 1);
  assert.strictEqual(stat.inMatch, 1);
  const html = (await get("/")).text;
  assert.ok(html.includes("SERVIDOR EN LÍNEA") && html.includes("Sala de Leo"));
  assert.ok(!html.includes(privMsg.code) && !html.includes(pubMsg.code), "la página de estado no enseña códigos");
  ok("/health, /status y / muestran salas, jugadores y combates (sin códigos)");

  // 6. Los textos se escapan en la página de estado (nada de HTML inyectado).
  const evil = await client(port);
  evil.send(JSON.stringify({ t: "host", proto: 1, public: true, title: "<script>alert(1)</script>", name: "<b>x</b>" }));
  await next(evil);
  const page = (await get("/")).text;
  assert.ok(!page.includes("<script>alert(1)"));
  assert.ok(page.includes("&lt;script&gt;"));
  ok("los títulos con HTML se escapan");
  evil.close();

  // 7. Salas de amigos: un amigo ve la sala (aunque sea privada); quien no es amigo, no.
  const a = await post("/api/register", { username: "Anita", password: "secreto1" });
  const b = await post("/api/register", { username: "Beto", password: "secreto2" });
  const c = await post("/api/register", { username: "Carla", password: "secreto3" });
  await post("/api/friends/request", { target: b.user.code }, a.token);
  await post("/api/friends/accept", { code: a.user.code }, b.token);
  const anitaRoom = await client(port);
  anitaRoom.send(JSON.stringify({ t: "host", proto: 1, token: a.token }));
  const anitaMsg = await next(anitaRoom);
  const betoView = await get("/api/me", b.token);
  const anitaFriend = betoView.json().friends.find((f) => f.name === "Anita");
  assert.ok(anitaFriend.room, "Beto debe ver la sala de su amiga");
  assert.strictEqual(anitaFriend.room.code, anitaMsg.code);
  assert.strictEqual(anitaFriend.room.public, false);
  const carlaView = await get("/api/me", c.token);
  assert.deepStrictEqual(carlaView.json().friends, []);
  assert.ok(!carlaView.text.includes(anitaMsg.code), "quien no es amigo no ve el código");
  ok("los amigos ven (y pueden entrar en) tu sala privada; los demás no");

  // 8. Una cuenta solo tiene una sala: al crear otra se cierra la anterior.
  const again = await client(port);
  again.send(JSON.stringify({ t: "host", proto: 1, token: a.token }));
  const againMsg = await next(again);
  assert.notStrictEqual(againMsg.code, anitaMsg.code);
  assert.strictEqual((await next(anitaRoom)).code, "replaced");
  assert.ok(!rooms.has(anitaMsg.code));
  const betoView2 = await get("/api/me", b.token);
  assert.strictEqual(betoView2.json().friends.find((f) => f.name === "Anita").room.code, againMsg.code);
  ok("una cuenta solo mantiene una sala abierta");

  // 9. Al cerrarse la sala desaparece de la lista de amigos.
  again.close();
  await sleep(300);
  const betoView3 = await get("/api/me", b.token);
  assert.strictEqual(betoView3.json().friends.find((f) => f.name === "Anita").room, undefined);
  ok("al cerrar la sala ya no aparece a los amigos");

  // 10. Utilidades.
  assert.strictEqual(status.formatUptime(45), "45 s");
  assert.strictEqual(status.formatUptime(125), "2 min 5 s");
  assert.strictEqual(status.formatUptime(7500), "2 h 5 min");
  assert.strictEqual(status.formatUptime(200000), "2 d 7 h");
  assert.strictEqual(status.clampInt("9", 2, 4, 4), 4);
  assert.strictEqual(status.clampInt("x", 2, 4, 3), 3);
  assert.strictEqual(status.sanitizeText("\u0001\u0002", "Jugador", 14), "Jugador");
  ok("utilidades de formato y limpieza");

  console.log(`\n${passed} comprobaciones de salas OK`);
  priv.close(); pub.close(); guest.close(); anitaRoom.close();
  setTimeout(() => process.exit(0), 100);
})().catch((err) => { console.error(err); process.exit(1); });
