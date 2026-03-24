import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("syncplayDesktop", {
  platform: process.platform,
  electronVersion: process.versions.electron,
  openDesktopWindow: () => ipcRenderer.invoke("syncplay:open-desktop-window"),
  pickLocalFile: () => ipcRenderer.invoke("syncplay:pick-local-file"),
  readLocalFile: async (fileId: string) => new Uint8Array(await ipcRenderer.invoke("syncplay:read-local-file", fileId)),
  readLocalFileChunk: async (fileId: string, offset: number, length: number) =>
    new Uint8Array(await ipcRenderer.invoke("syncplay:read-local-file-chunk", fileId, offset, length)),
  createTempMediaCache: (mediaId: string) => ipcRenderer.invoke("syncplay:create-temp-media-cache", mediaId),
  writeTempMediaChunk: async (cacheId: string, offset: number, bytes: Uint8Array) =>
    ipcRenderer.invoke("syncplay:write-temp-media-chunk", cacheId, offset, bytes),
  removeTempMediaCache: async (cacheId: string) => ipcRenderer.invoke("syncplay:remove-temp-media-cache", cacheId)
});
