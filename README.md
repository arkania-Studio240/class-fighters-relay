# CLASS FIGHTERS · servidor de salas (relay)
Servidor WebSocket mínimo (Node 18+, dependencia: `ws`). Guía completa de despliegue gratuito en Render y de
configuración desde Android: `GUIA_ONLINE_RELAY.md` (en el proyecto: `docs/ONLINE_RELAY.md`).

    npm install
    npm test      # pruebas
    npm start     # PORT=8080 por defecto; GET /health -> "OK"

En Render: Build `npm install`, Start `node server.js`, plan Free.
