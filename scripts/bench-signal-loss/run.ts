// Sends bursts of signaling messages over a real WebSocket, the way the server
// relays an offer followed by trickled ICE candidates, and checks how many the
// React consumer handles.
//
// Usage: bun scripts/bench-signal-loss/run.ts [bursts] [messagesPerBurst]
import path from "node:path";

const dir = import.meta.dir;
const bursts = Number(process.argv[2] ?? 30);
const perBurst = Number(process.argv[3] ?? 12);
const electronBin = path.resolve(dir, "../../apps/desktop/node_modules/.bin/electron");

const build = await Bun.build({
  entrypoints: [path.join(dir, "app.tsx")],
  outdir: path.join(dir, "dist"),
  target: "browser",
  // React is installed in the desktop workspace, not at the repo root.
  plugins: [
    {
      name: "desktop-react",
      setup(builder) {
        builder.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => ({
          path: Bun.resolveSync(args.path, path.resolve(dir, "../../apps/desktop"))
        }));
      }
    }
  ],
  define: { "process.env.NODE_ENV": '"production"' }
});
if (!build.success) throw new Error(build.logs.join("\n"));

const server = Bun.serve({
  port: 0,
  fetch(request, srv) {
    return srv.upgrade(request) ? undefined : new Response("ws only", { status: 400 });
  },
  websocket: {
    async open(ws) {
      await Bun.sleep(500);
      for (let burst = 0; burst < bursts; burst += 1) {
        // Server-side relays arrive back to back, like candidates gathered together.
        for (let index = 0; index < perBurst; index += 1) ws.send(JSON.stringify({ burst, index }));
        await Bun.sleep(100);
      }
    },
    message() {}
  }
});

const sent = bursts * perBurst;
const results: Record<string, number> = {};
for (const pattern of ["state", "queue"]) {
  const child = Bun.spawn([electronBin, path.join(dir, "main.cjs"), `ws://127.0.0.1:${server.port}`, pattern, String(bursts * 100 + 2500)], {
    stdout: "pipe",
    stderr: "ignore"
  });
  const output = await new Response(child.stdout).text();
  results[pattern] = Number(/SEEN (\d+)/.exec(output)?.[1] ?? NaN);
}
server.stop(true);

for (const [pattern, seen] of Object.entries(results)) {
  console.log(`${pattern.padEnd(6)} handled ${seen}/${sent} signals (${((100 * (sent - seen)) / sent).toFixed(1)}% lost)`);
}
