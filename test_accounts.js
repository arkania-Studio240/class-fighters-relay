"use strict";
// Prueba de cuentas y amigos (no necesita el módulo ws): node test_accounts.js
const http = require("http");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAccountApi } = require("./accounts");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-acc-"));
const api = createAccountApi({ dataDir: dir, publicUrl: "https://ejemplo.onrender.com" });
const server = http.createServer(async (req, res) => {
  if (!(await api.handle(req, res))) { res.writeHead(404); res.end(); }
});

let base = "";
async function call(method, route, body, token) {
  const res = await fetch(base + route, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const isJson = (res.headers.get("content-type") || "").includes("json");
  return { status: res.status, data: isJson ? await res.json() : await res.text() };
}

async function main() {
  await new Promise((r) => server.listen(0, r));
  base = "http://127.0.0.1:" + server.address().port;

  // Registro y login
  let r = await call("POST", "/api/register", { username: "ab", password: "123456" });
  assert.strictEqual(r.data.error, "bad_name");
  r = await call("POST", "/api/register", { username: "Rayo", password: "123" });
  assert.strictEqual(r.data.error, "bad_password");
  const ana = (await call("POST", "/api/register", { username: "Ana_01", password: "secreto1" })).data;
  assert.ok(ana.token && ana.user.code.length === 8);
  r = await call("POST", "/api/register", { username: "ana_01", password: "otra123" });
  assert.strictEqual(r.data.error, "name_taken");
  r = await call("POST", "/api/login", { username: "Ana_01", password: "mala123" });
  assert.strictEqual(r.status, 401);
  r = await call("POST", "/api/login", { username: "ana_01", password: "secreto1" });
  assert.ok(r.data.token);
  const beto = (await call("POST", "/api/register", { username: "Beto", password: "clave123" })).data;
  const carla = (await call("POST", "/api/register", { username: "Carla", password: "clave123" })).data;

  // Token falso o ausente
  assert.strictEqual((await call("GET", "/api/me")).status, 401);
  assert.strictEqual((await call("GET", "/api/me", null, ana.token + "x")).status, 401);

  // Solicitud por código y por nombre
  r = await call("POST", "/api/friends/request", { target: beto.user.code }, ana.token);
  assert.strictEqual(r.data.result, "sent");
  assert.strictEqual(r.data.outgoing.length, 1);
  r = await call("POST", "/api/friends/request", { target: "beto" }, ana.token);
  assert.strictEqual(r.data.error, "already_sent");
  r = await call("POST", "/api/friends/request", { target: ana.user.code }, ana.token);
  assert.strictEqual(r.data.error, "self");
  r = await call("POST", "/api/friends/request", { target: "NOEXISTE" }, ana.token);
  assert.strictEqual(r.data.error, "not_found");

  let me = (await call("GET", "/api/me", null, beto.token)).data;
  assert.strictEqual(me.incoming.length, 1);
  assert.strictEqual(me.incoming[0].name, "Ana_01");

  // Aceptar
  r = await call("POST", "/api/friends/accept", { code: ana.user.code }, beto.token);
  assert.strictEqual(r.data.friends.length, 1);
  assert.strictEqual(r.data.friends[0].online, true);
  me = (await call("GET", "/api/me", null, ana.token)).data;
  assert.strictEqual(me.friends[0].name, "Beto");
  assert.strictEqual(me.outgoing.length, 0);

  // Solicitudes cruzadas se aceptan solas
  await call("POST", "/api/friends/request", { target: ana.user.code }, carla.token);
  r = await call("POST", "/api/friends/request", { target: carla.user.code }, ana.token);
  assert.strictEqual(r.data.result, "accepted");
  assert.strictEqual(r.data.friends.length, 2);

  // Rechazar, cancelar y eliminar
  const dani = (await call("POST", "/api/register", { username: "Dani", password: "clave123" })).data;
  await call("POST", "/api/friends/request", { target: dani.user.code }, beto.token);
  r = await call("POST", "/api/friends/decline", { code: beto.user.code }, dani.token);
  assert.strictEqual(r.data.incoming.length, 0);
  me = (await call("GET", "/api/me", null, beto.token)).data;
  assert.strictEqual(me.outgoing.length, 0);
  await call("POST", "/api/friends/request", { target: dani.user.code }, beto.token);
  r = await call("POST", "/api/friends/decline", { code: dani.user.code }, beto.token); // cancelar la enviada
  assert.strictEqual(r.data.outgoing.length, 0);
  r = await call("POST", "/api/friends/remove", { code: beto.user.code }, ana.token);
  assert.strictEqual(r.data.friends.length, 1);
  me = (await call("GET", "/api/me", null, beto.token)).data;
  assert.strictEqual(me.friends.length, 0);

  // QR y página del enlace
  r = await call("GET", "/api/qr", null, ana.token);
  assert.strictEqual(r.data.link, "https://ejemplo.onrender.com/f/" + ana.user.code);
  assert.ok(r.data.qr.size >= 21 && r.data.qr.rows.length === r.data.qr.size);
  r = await call("GET", "/f/" + ana.user.code);
  assert.ok(r.data.includes(ana.user.code) && r.data.includes("Ana_01"));

  // Persistencia
  api.flush();
  const again = createAccountApi({ dataDir: dir });
  assert.strictEqual(Object.keys(again._db.users).length, 4);

  // Límite de intentos
  let limited = false;
  for (let i = 0; i < 30; i++) {
    const x = await call("POST", "/api/login", { username: "Ana_01", password: "mala" + i });
    if (x.status === 429) limited = true;
  }
  assert.ok(limited, "debe haber límite de intentos");
  console.log("cuentas y amigos: todo OK");
}

main().then(() => { server.close(); process.exit(0); }, (err) => { console.error(err); process.exit(1); });
