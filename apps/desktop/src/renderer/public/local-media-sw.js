const LOCAL_MEDIA_DB_NAME = "syncplay-local-media";
const LOCAL_MEDIA_DB_VERSION = 2;
const LOCAL_MEDIA_CHUNK_STORE = "media-chunks";
const LOCAL_MEDIA_META_STORE = "media-meta";
const LOCAL_MEDIA_FILE_STORE = "media-files";
const LOCAL_MEDIA_PATH_PREFIX = "/__syncplay-local-media/";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (!url.pathname.startsWith(LOCAL_MEDIA_PATH_PREFIX)) {
    return;
  }

  event.respondWith(handleLocalMediaRequest(event.request, url));
});

async function queryClients(payload, transferable = []) {
  const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

  for (const client of clientList) {
    try {
      const response = await new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timeoutId = setTimeout(() => reject(new Error("Timed out waiting for page response")), 5000);

        channel.port1.onmessage = (event) => {
          clearTimeout(timeoutId);
          resolve(event.data ?? null);
        };

        client.postMessage(payload, [channel.port2, ...transferable]);
      });

      if (response?.ok) {
        return response;
      }
    } catch {
      // Try the next client window.
    }
  }

  return null;
}

function openLocalMediaDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_MEDIA_DB_NAME, LOCAL_MEDIA_DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(LOCAL_MEDIA_CHUNK_STORE)) {
        const chunkStore = database.createObjectStore(LOCAL_MEDIA_CHUNK_STORE, {
          keyPath: ["mediaId", "startByte"]
        });
        chunkStore.createIndex("byMediaId", "mediaId", { unique: false });
      }

      if (!database.objectStoreNames.contains(LOCAL_MEDIA_META_STORE)) {
        database.createObjectStore(LOCAL_MEDIA_META_STORE, {
          keyPath: "mediaId"
        });
      }

      if (!database.objectStoreNames.contains(LOCAL_MEDIA_FILE_STORE)) {
        database.createObjectStore(LOCAL_MEDIA_FILE_STORE, {
          keyPath: "mediaId"
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open local media database"));
  });
}

function getMediaMeta(database, mediaId) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([LOCAL_MEDIA_META_STORE], "readonly");
    const request = transaction.objectStore(LOCAL_MEDIA_META_STORE).get(mediaId);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error ?? new Error("Failed to read local media metadata"));
  });
}

function getMediaFile(database, mediaId) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([LOCAL_MEDIA_FILE_STORE], "readonly");
    const request = transaction.objectStore(LOCAL_MEDIA_FILE_STORE).get(mediaId);
    request.onsuccess = () => resolve(request.result?.file ?? null);
    request.onerror = () => reject(request.error ?? new Error("Failed to read local media file"));
  });
}

function parseRangeHeader(rangeHeader, fileSize) {
  if (!rangeHeader) {
    return {
      isPartial: false,
      startByte: 0,
      endByte: fileSize - 1
    };
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());

  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  let startByte = rawStart === "" ? Number.NaN : Number(rawStart);
  let endByte = rawEnd === "" ? Number.NaN : Number(rawEnd);

  if (Number.isNaN(startByte)) {
    const suffixLength = Number(rawEnd);

    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }

    startByte = Math.max(0, fileSize - suffixLength);
    endByte = fileSize - 1;
  } else {
    if (!Number.isFinite(startByte) || startByte < 0 || startByte >= fileSize) {
      return null;
    }

    if (Number.isNaN(endByte) || endByte >= fileSize) {
      endByte = fileSize - 1;
    }
  }

  if (!Number.isFinite(endByte) || endByte < startByte) {
    return null;
  }

  return {
    isPartial: true,
    startByte,
    endByte
  };
}

function readChunkRange(database, mediaId, startByte, endByte) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([LOCAL_MEDIA_CHUNK_STORE], "readonly");
    const store = transaction.objectStore(LOCAL_MEDIA_CHUNK_STORE);
    const range = IDBKeyRange.bound([mediaId, 0], [mediaId, endByte]);
    const request = store.openCursor(range);
    const parts = [];
    let expectedByte = startByte;

    request.onsuccess = () => {
      const cursor = request.result;

      if (!cursor) {
        resolve({
          parts,
          bytesRead: expectedByte - startByte,
          expectedBytes: endByte - startByte + 1
        });
        return;
      }

      const chunk = cursor.value;
      const chunkStart = chunk.startByte;
      const bytes = new Uint8Array(chunk.bytes);
      const chunkEnd = chunkStart + bytes.byteLength - 1;

      if (chunkEnd < expectedByte) {
        cursor.continue();
        return;
      }

      if (chunkStart > expectedByte) {
        resolve({
          parts,
          bytesRead: expectedByte - startByte,
          expectedBytes: endByte - startByte + 1
        });
        return;
      }

      const localStart = Math.max(0, expectedByte - chunkStart);
      const localEnd = Math.min(bytes.byteLength, endByte - chunkStart + 1);
      parts.push(bytes.slice(localStart, localEnd));
      expectedByte = chunkStart + localEnd;

      if (expectedByte > endByte) {
        resolve({
          parts,
          bytesRead: endByte - startByte + 1,
          expectedBytes: endByte - startByte + 1
        });
        return;
      }

      cursor.continue();
    };

    request.onerror = () => reject(request.error ?? new Error("Failed to read local media chunk range"));
  });
}

async function handleLocalMediaRequest(request, url) {
  try {
    const mediaId = decodeURIComponent(url.pathname.slice(LOCAL_MEDIA_PATH_PREFIX.length));
    const liveMeta = await queryClients({
      type: "syncplay-local-media-meta",
      mediaId
    });

    let meta = liveMeta;
    let file = null;
    let database = null;

    if (!meta) {
      database = await openLocalMediaDb();
      meta = await getMediaMeta(database, mediaId);
      file = await getMediaFile(database, mediaId);
    }

    if (!meta) {
      return new Response("Media not found", { status: 404 });
    }

    const parsedRange = parseRangeHeader(request.headers.get("range"), meta.fileSize);

    if (!parsedRange) {
      return new Response("Invalid range", {
        status: 416,
        headers: {
          "Content-Range": `bytes */${meta.fileSize}`
        }
      });
    }

    const { startByte, endByte, isPartial } = parsedRange;

    if (request.method === "HEAD") {
      return new Response(null, {
        status: isPartial ? 206 : 200,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(endByte - startByte + 1),
          "Content-Range": `bytes ${startByte}-${endByte}/${meta.fileSize}`,
          "Content-Type": meta.mimeType || "application/octet-stream",
          "Cache-Control": "no-store"
        }
      });
    }

    if (file) {
      const slicedFile = file.slice(startByte, endByte + 1, meta.mimeType || "application/octet-stream");

      return new Response(slicedFile, {
        status: isPartial ? 206 : 200,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(endByte - startByte + 1),
          "Content-Range": `bytes ${startByte}-${endByte}/${meta.fileSize}`,
          "Content-Type": meta.mimeType || "application/octet-stream",
          "Cache-Control": "no-store"
        }
      });
    }

    const liveRange = await queryClients({
      type: "syncplay-local-media-range",
      mediaId,
      startByte,
      endByte
    });

    if (liveRange?.bytes) {
      return new Response(new Blob([liveRange.bytes], { type: meta.mimeType || "application/octet-stream" }), {
        status: isPartial ? 206 : 200,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(endByte - startByte + 1),
          "Content-Range": `bytes ${startByte}-${endByte}/${meta.fileSize}`,
          "Content-Type": meta.mimeType || "application/octet-stream",
          "Cache-Control": "no-store"
        }
      });
    }

    if (!database) {
      database = await openLocalMediaDb();
    }

    const { parts, bytesRead, expectedBytes } = await readChunkRange(database, mediaId, startByte, endByte);

    if (bytesRead !== expectedBytes) {
      return new Response("Media range unavailable", {
        status: 503,
        headers: {
          "Cache-Control": "no-store"
        }
      });
    }

    return new Response(new Blob(parts, { type: meta.mimeType || "application/octet-stream" }), {
      status: isPartial ? 206 : 200,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Length": String(expectedBytes),
        "Content-Range": `bytes ${startByte}-${endByte}/${meta.fileSize}`,
        "Content-Type": meta.mimeType || "application/octet-stream",
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return new Response(`Local media request failed: ${String(error)}`, {
      status: 500,
      headers: {
        "Cache-Control": "no-store"
      }
    });
  }
}
