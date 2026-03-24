const defaultServerUrl = "http://127.0.0.1:8787";

export function getServerBaseUrl() {
  return import.meta.env.VITE_SYNCPLAY_SERVER_URL ?? defaultServerUrl;
}

export function getWebSocketUrl() {
  const serverUrl = new URL(getServerBaseUrl());
  serverUrl.protocol = serverUrl.protocol === "https:" ? "wss:" : "ws:";
  serverUrl.pathname = "/ws";
  serverUrl.search = "";

  return serverUrl.toString();
}

