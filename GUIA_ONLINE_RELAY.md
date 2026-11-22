# CLASS FIGHTERS · Online por Internet con servidor relay (gratis)

## Qué cambia
- Las salas se crean en un **servidor de salas** (carpeta `relay-server/`, Node.js). El servidor genera un
  **código único por sala** (6 caracteres, sin 0/O/1/I/L, p. ej. `K7M-2QX`): aleatorio, nunca igual a otra sala
  abierta y no se reutiliza durante 1 hora. El código **ya no contiene ninguna IP**.
- Los jugadores no se conectan entre sí: todos hablan con el servidor, que reenvía los paquetes. **No hay que
  abrir el puerto UDP 7777**, ni UPnP, ni VPN. Funciona entre redes distintas y con datos móviles.
- El combate sigue igual: el anfitrión simula (autoritativo), hasta 4 jugadores, mismas reglas, luchadores y UI.
- Sigue existiendo **SALA DIRECTA (WI-FI)** (ENet/UDP por IP) y el servidor dedicado `--server`.

Archivos nuevos/modificados: `scripts/net/relay_peer.gd` (nuevo), `scripts/net/net_config.gd`,
`scripts/net/net_manager.gd`, `scripts/ui/online_menu.gd`, `relay-server/*` (nuevo).

## Paso 1 · Subir el servidor a Render (todo desde el móvil)
1. **GitHub** (github.com, cuenta gratis) → `+` → *New repository* → nombre `class-fighters-relay` → *Create*.
2. En el repo: *Add file → Upload files* y sube **`server.js`** y **`package.json`** (de `relay-server/`).
   *Commit changes*.
3. **Render** (render.com, registro gratis con tu cuenta de GitHub, sin tarjeta) → *New → Web Service* →
   elige el repo.
   - Runtime: **Node** · Build Command: `npm install` · Start Command: `node server.js`
   - Instance Type: **Free** → *Create Web Service*.
4. Cuando diga *Live*, copia la URL (`https://class-fighters-relay-xxxx.onrender.com`). Ábrela en el navegador:
   debe decir **«CLASS FIGHTERS relay OK. Salas activas: 0»**.

## Paso 2 · Poner la dirección en el juego
Todos los jugadores necesitan **la misma dirección de servidor** (el código de sala solo identifica la sala).
- **Lo más cómodo:** abre `scripts/net/net_config.gd` (editor de scripts de Godot en Android) y pon
  `const RELAY_URL: String = "https://class-fighters-relay-xxxx.onrender.com"`. Así va incluida en el juego
  que compartas. Vale pegar la `https://...`; el juego la convierte a `wss://`.
- **Sin tocar código:** ONLINE → campo **SERVIDOR** → pega la URL. Se guarda en el dispositivo.

## Paso 3 · Jugar
1. Anfitrión: ONLINE → **CREAR**. Aparece `CÓDIGO: K7M-2QX` (botón COPIAR). Compártelo por WhatsApp, etc.
2. Resto: ONLINE → escribe el código en UNIRSE → **UNIRME**. Eligen luchador y **PREPARADO**; el anfitrión
   pulsa **INICIAR PARTIDA**. Hasta 4 jugadores; el quinto recibe «La sala está llena».

## Android: permiso de Internet
Proyecto → Exportar → Android → *Permisos* → activa **Internet** (sin él no hay conexión).

## Límites del plan gratuito de Render (comprobado en su documentación)
- El servidor **se duerme tras 15 min sin tráfico** y tarda **~1 minuto** en despertar: la primera conexión
  tras un rato parado puede tardar. El juego espera hasta 70 s y reintenta; verás el aviso en pantalla.
  Una sala activa genera tráfico constante, así que no se duerme a mitad de partida.
- 750 horas gratis al mes por cuenta (de sobra para un servidor) y Render puede reiniciarlo en cualquier momento:
  si pasa, la sala se cierra (como cuando el anfitrión se va; no hay migración de anfitrión).
- Truco opcional: un cron gratuito (p. ej. cron-job.org) que abra `/health` cada 10 min lo mantiene despierto.
- El mismo `server.js` funciona en cualquier hosting con Node 18+ (Fly.io, Koyeb, un VPS...).

## Cómo funciona por dentro (resumen)
- `RelayPeer` (extiende `MultiplayerPeerExtension`) lleva los paquetes del multijugador de Godot por un
  WebSocket al relay: anfitrión = par 1, clientes = ids 2, 3... Todos los `@rpc`, el lobby, el PREPARADO, la
  reconexión (20 s con clave secreta) y el combate funcionan sin cambios.
- WebSocket va sobre TCP: los paquetes «no fiables» (fotos del estado, entradas) se descartan si la conexión
  va atrasada, y el juego ya ignora fotos viejas por su `tick`. Con mala red puede haber algo más de retardo
  que con UDP directo; en la misma Wi-Fi usa **SALA DIRECTA**.
- Seguridad del relay: solo reenvía bytes (no ejecuta nada del juego); límite de 6 conexiones por sala, 300 salas,
  64 KB por paquete, 600 mensajes/s y 400 KB/s por conexión; los clientes solo pueden hablar con el anfitrión.
  El anfitrión sigue validando todo (versión, personajes, entradas) como antes.

## Probar en un PC
```
cd relay-server && npm install && npm test     # 11 comprobaciones del relay
node server.js                                 # escucha en ws://127.0.0.1:8080
```
En el juego: SERVIDOR = `ws://127.0.0.1:8080` (Depurar → varias instancias).

## Estado de las pruebas
- Relay: probado aquí (códigos únicos, unirse, reenvío, aforo, kick, cierre de sala).
- Godot: `relay_peer.gd` y los cambios de menú/red están escritos contra la API documentada de
  `MultiplayerPeerExtension` y `WebSocketPeer`, pero **no se pudieron ejecutar en este entorno** (no hay
  Godot). Prueba primero con 2 instancias y luego con dos móviles en redes distintas (ver ONLINE_PRUEBAS.md).
