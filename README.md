# SyncPlay

Monorepo con `Bun` para una app desktop `Electron + React + Vite` y un backend realtime para ver videos de YouTube sincronizados.

## Apps

- `apps/desktop`: cliente desktop.
- `apps/server`: backend Bun con salas y WebSocket.
- `packages/shared`: tipos y utilidades compartidas.

## Desarrollo

```bash
bun install
bun run dev
```

Servicios por separado:

```bash
bun run dev:server
bun run dev:desktop
```

## Variables útiles

- `SYNCPLAY_SERVER_URL`: URL base del servidor para el desktop. Por defecto usa `http://127.0.0.1:8787`.

## Comandos

```bash
bun run check
bun run test
bun run build
```

