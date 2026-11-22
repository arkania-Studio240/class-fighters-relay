"use strict";
// Prueba local del relay: node test.js   (necesita `npm install` para tener ws)
const assert = require("assert");
const WebSocket = require("ws");
const { server, rooms, ALPHABET } = require("./server.js");

function client(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.inbox = []; ws.waiters = []; ws.closed = false;
    ws.on("message", (data, isBinary) => {
      const item = isBinary ? { bin: Buffer.from(data) } : { json: JSON.parse(data.toString()) };
      const w = ws.waiters.shift();
      if (w) w(item); else ws.inbox.push(item);
    });
    ws.on("close", (code) => { ws.closed = true; ws.closeCode = code; });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
const next = (ws, ms = 1500) => new Promise((resolve, reject) => {
  if (ws.inbox.length) return resolve(ws.inbox.shift());
  const t = setTimeout(() => reject(new Error("timeout esperando mensaje")), ms);
  ws.waiters.push((m) => { clearTimeout(t); resolve(m); });
});
const none = (ws, ms = 250) => new Promise((resolve) => setTimeout(() => resolve(ws.inbox.length === 0), ms));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = (target, channel, mode, text) =>
  Buffer.concat([(() => { const h = Buffer.alloc(6); h.writeInt32LE(target, 0); h[4] = channel; h[5] = mode; return h; })(), Buffer.from(text)]);
const parse = (b) => ({ peer: b.readInt32LE(0), channel: b[4], mode: b[5], text: b.subarray(6).toString() });

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  let passed = 0;
  const ok = (name) => { passed++; console.log("  ok  " + name); };

  // 1. Códigos únicos y bien formados
  const codes = new Set();
  const hosts = [];
  for (let i = 0; i < 250; i++) {
    const h = await client(port);
    h.send(JSON.stringify({ t: "host", proto: 1 }));
    const m = (await next(h)).json;
    assert.strictEqual(m.t, "hosted");
    assert.match(m.code, new RegExp(`^[${ALPHABET}]{6}$`));
    codes.add(m.code); hosts.push(h);
  }
  assert.strictEqual(codes.size, 250);
  ok("250 salas -> 250 códigos distintos, 6 caracteres sin ambiguos");
  for (const h of hosts) h.close();
  await sleep(300);
  assert.strictEqual(rooms.size, 0);
  ok("al cerrar el anfitrión las salas desaparecen");

  // 2. Sala con anfitrión + 2 clientes
  const host = await client(port);
  host.send(JSON.stringify({ t: "host", proto: 1 }));
  const code = (await next(host)).json.code;
  const pretty = code.slice(0, 3).toLowerCase() + "-" + code.slice(3);
  const a = await client(port); a.send(JSON.stringify({ t: "join", proto: 1, code: pretty }));
  assert.deepStrictEqual((await next(a)).json, { t: "joined", id: 2 });
  assert.deepStrictEqual((await next(host)).json, { t: "peer_joined", id: 2 });
  const b = await client(port); b.send(JSON.stringify({ t: "join", proto: 1, code }));
  assert.deepStrictEqual((await next(b)).json, { t: "joined", id: 3 });
  assert.deepStrictEqual((await next(host)).json, { t: "peer_joined", id: 3 });
  ok("unirse con minúsculas y guion; ids 2 y 3; el anfitrión es avisado");

  // 3. Datos
  a.send(frame(99, 2, 1, "hola"));
  let p = parse((await next(host)).bin);
  assert.deepStrictEqual(p, { peer: 2, channel: 2, mode: 1, text: "hola" });
  assert(await none(b));
  ok("cliente -> anfitrión (destino ignorado, origen = 2, canal y modo intactos)");
  host.send(frame(3, 0, 2, "solo-b"));
  p = parse((await next(b)).bin); assert.deepStrictEqual(p, { peer: 1, channel: 0, mode: 2, text: "solo-b" });
  assert(await none(a));
  ok("anfitrión -> un cliente concreto");
  host.send(frame(0, 1, 1, "todos"));
  assert.strictEqual(parse((await next(a)).bin).text, "todos");
  assert.strictEqual(parse((await next(b)).bin).text, "todos");
  ok("anfitrión -> todos");
  host.send(frame(-2, 0, 2, "menos-a"));
  assert.strictEqual(parse((await next(b)).bin).text, "menos-a");
  assert(await none(a));
  ok("anfitrión -> todos menos uno");

  // 4. Errores
  const x = await client(port); x.send(JSON.stringify({ t: "join", proto: 1, code: "ZZZZZZ" }));
  assert.strictEqual((await next(x)).json.code, "no_room");
  const y = await client(port); y.send(JSON.stringify({ t: "host", proto: 99 }));
  assert.strictEqual((await next(y)).json.code, "bad_proto");
  ok("sala inexistente y versión incompatible");

  // 5. Sala llena (máx. 6 clientes)
  const extra = [];
  for (let i = 0; i < 4; i++) { const c = await client(port); c.send(JSON.stringify({ t: "join", proto: 1, code })); await next(c); extra.push(c); }
  const over = await client(port); over.send(JSON.stringify({ t: "join", proto: 1, code }));
  assert.strictEqual((await next(over)).json.code, "full");
  ok("sala llena rechaza al 7.º");
  extra.forEach((c) => c.close());
  await sleep(200);

  // 6. Expulsar y salida
  while (host.inbox.length) host.inbox.shift();
  host.send(JSON.stringify({ t: "kick", id: 2 }));
  await sleep(300);
  assert(a.closed);
  const left = (await next(host)).json; assert.deepStrictEqual(left, { t: "peer_left", id: 2 });
  ok("kick cierra al cliente y avisa con peer_left");

  // 7. Cierre del anfitrión
  host.close();
  assert.deepStrictEqual((await next(b)).json, { t: "host_left" });
  await sleep(400);
  assert(b.closed);
  assert.strictEqual(rooms.size, 0);
  const late = await client(port); late.send(JSON.stringify({ t: "join", proto: 1, code }));
  assert.strictEqual((await next(late)).json.code, "no_room");
  ok("al irse el anfitrión los clientes reciben host_left y el código deja de valer");

  console.log(`\n${passed} comprobaciones OK`);
  process.exit(0);
})().catch((e) => { console.error("FALLO:", e); process.exit(1); });
