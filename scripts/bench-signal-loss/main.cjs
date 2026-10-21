// Usage: electron main.cjs  (spawned by run.ts)
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const [wsUrl, pattern, waitMs] = process.argv.slice(-3);
app.setPath("userData", path.join(require("node:os").tmpdir(), "syncplay-signal-loss"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await window.loadFile(path.join(__dirname, "index.html"), { query: { ws: wsUrl, pattern } });
  await new Promise((resolve) => setTimeout(resolve, Number(waitMs)));
  console.log(`SEEN ${await window.webContents.executeJavaScript("window.__seenCount()")}`);
  app.exit(0);
});
