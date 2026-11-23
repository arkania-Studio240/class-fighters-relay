"use strict";
/**
 * CLASS FIGHTERS - utilidades del relay que no dependen de la red (se pueden probar solas):
 * limpieza de textos de sala, resumen de estadísticas, lista de salas públicas, el texto de
 * /health y la página de estado (/). Una "sala" es un objeto con: code, isPublic, title, hostName,
 * players, max, inMatch, createdAt y clients (Map).
 */

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Quita caracteres de control y espacios de más; recorta a `max`. Si queda vacío, usa `fallback`. */
function sanitizeText(raw, fallback, max) {
  const clean = String(raw == null ? "" : raw).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return clean || fallback;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function formatUptime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min ${s % 60} s`;
  return `${s} s`;
}

/** Jugadores que hay en la sala: lo que cuenta el anfitrión (nunca más que el aforo ni menos que 1). */
function playersOf(room) {
  const reported = Number.isFinite(room.players) ? room.players : 1 + room.clients.size;
  return Math.min(room.max, Math.max(1, reported));
}

function summarize(rooms, connections, startedAt, now, accountCount) {
  let publicRooms = 0;
  let inMatch = 0;
  let players = 0;
  let total = 0;
  for (const room of rooms) {
    total++;
    if (room.isPublic) publicRooms++;
    if (room.inMatch) inMatch++;
    players += playersOf(room);
  }
  return {
    rooms: total,
    publicRooms,
    privateRooms: total - publicRooms,
    inMatch,
    players,
    connections,
    accounts: accountCount,
    uptimeSeconds: Math.floor((now - startedAt) / 1000),
  };
}

/** Salas públicas para la lista del juego (las que más sitio libre tienen primero, luego las nuevas). */
function publicList(rooms, now, limit = 50) {
  const list = [];
  for (const room of rooms) {
    if (!room.isPublic) continue;
    list.push({
      code: room.code,
      title: room.title || `Sala de ${room.hostName}`,
      host: room.hostName,
      players: playersOf(room),
      max: room.max,
      in_match: Boolean(room.inMatch),
      age: Math.max(0, Math.floor((now - room.createdAt) / 1000)),
    });
  }
  list.sort((a, b) => Number(a.in_match) - Number(b.in_match) || Number(a.players >= a.max) - Number(b.players >= b.max) || a.age - b.age);
  return list.slice(0, limit);
}

function healthText(stats) {
  const publicText = stats.publicRooms === 1 ? "1 pública" : `${stats.publicRooms} públicas`;
  const privateText = stats.privateRooms === 1 ? "1 privada" : `${stats.privateRooms} privadas`;
  return `CLASS FIGHTERS relay OK. Salas activas: ${stats.rooms} (${publicText}, ${privateText}) · ` +
    `Jugadores: ${stats.players} · En combate: ${stats.inMatch} · Activo: ${formatUptime(stats.uptimeSeconds)}\n`;
}

function dashboardHtml(stats, list) {
  const card = (value, label) => `<div class="card"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`;
  const rows = list.map((r) => `<tr><td>${escapeHtml(r.title)}</td><td>${escapeHtml(r.host)}</td><td>${r.players}/${r.max}</td>` +
    `<td class="${r.in_match ? "fight" : r.players >= r.max ? "full" : "wait"}">${r.in_match ? "En combate" : r.players >= r.max ? "Llena" : "Esperando"}</td>` +
    `<td>${escapeHtml(formatUptime(r.age))}</td></tr>`).join("");
  const table = list.length
    ? `<table><thead><tr><th>Sala</th><th>Anfitrión</th><th>Jugadores</th><th>Estado</th><th>Abierta hace</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="empty">No hay salas públicas abiertas ahora mismo. Crea una desde ONLINE en el juego.</p>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15"><title>CLASS FIGHTERS · Servidor</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#140c2c;color:#fff;font-family:system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 18px}h1{color:#ffd21f;margin:0;font-size:30px;letter-spacing:1px}
.pill{display:inline-block;margin:10px 0 18px;padding:6px 14px;border-radius:99px;background:#1c7a3a;font-weight:700;font-size:14px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.card{background:#241a48;border:2px solid #3a2d6e;border-radius:12px;padding:14px;text-align:center}
.card b{display:block;font-size:34px;color:#ffd21f}.card span{font-size:13px;color:#aab}
h2{margin:26px 0 10px;font-size:18px;color:#ffd21f}table{width:100%;border-collapse:collapse;background:#241a48;border-radius:12px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;font-size:14px}th{background:#2e2260;color:#cdd}tr+tr td{border-top:1px solid #3a2d6e}
.wait{color:#5be08a}.fight{color:#ff9a3d}.full{color:#f06}.empty{color:#aab}.foot{margin-top:22px;color:#889;font-size:12px}</style></head>
<body><main><h1>CLASS FIGHTERS</h1><div class="pill">● SERVIDOR EN LÍNEA</div>
<div class="cards">${card(stats.rooms, "Salas activas")}${card(stats.publicRooms, "Públicas")}${card(stats.privateRooms, "Privadas")}${card(stats.players, "Jugadores en sala")}${card(stats.inMatch, "En combate")}${card(formatUptime(stats.uptimeSeconds), "Activo desde hace")}</div>
<h2>Salas públicas</h2>${table}
<p class="foot">Las salas privadas no se muestran: solo se entra con su código (o desde la lista de amigos). Se actualiza cada 15 s.</p></main></body></html>`;
}

module.exports = { escapeHtml, sanitizeText, clampInt, formatUptime, playersOf, summarize, publicList, healthText, dashboardHtml };
