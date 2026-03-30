import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("syncplayDesktop", {
  platform: process.platform,
  electronVersion: process.versions.electron,
  openDesktopWindow: () => ipcRenderer.invoke("syncplay:open-desktop-window"),
  pickLocalFile: () => ipcRenderer.invoke("syncplay:pick-local-file"),
  pickLocalFileByPath: (filePath: string) => ipcRenderer.invoke("syncplay:pick-local-file-by-path", filePath),
  readLocalFile: async (fileId: string) => new Uint8Array(await ipcRenderer.invoke("syncplay:read-local-file", fileId)),
  readLocalFileChunk: async (fileId: string, offset: number, length: number) =>
    new Uint8Array(await ipcRenderer.invoke("syncplay:read-local-file-chunk", fileId, offset, length)),
  createTempMediaCache: (mediaId: string, metadata: { fileSize: number; mimeType: string; fileName: string }) =>
    ipcRenderer.invoke("syncplay:create-temp-media-cache", mediaId, metadata),
  writeTempMediaChunk: async (cacheId: string, offset: number, bytes: Uint8Array) =>
    ipcRenderer.invoke("syncplay:write-temp-media-chunk", cacheId, offset, bytes),
  markTempMediaRangeAvailable: async (cacheId: string, startByte: number, endByte: number) =>
    ipcRenderer.invoke("syncplay:mark-temp-media-range-available", cacheId, startByte, endByte),
  waitForTempMediaRange: async (cacheId: string, startByte: number, endByte: number, timeoutMs?: number) =>
    ipcRenderer.invoke("syncplay:wait-for-temp-media-range", cacheId, startByte, endByte, timeoutMs),
  getTempMediaStatus: async (cacheId: string) => ipcRenderer.invoke("syncplay:get-temp-media-status", cacheId),
  removeTempMediaCache: async (cacheId: string) => ipcRenderer.invoke("syncplay:remove-temp-media-cache", cacheId)
});
