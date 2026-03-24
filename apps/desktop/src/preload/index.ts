import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("syncplayDesktop", {
  platform: process.platform,
  electronVersion: process.versions.electron
});

