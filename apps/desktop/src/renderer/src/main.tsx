import React from "react";
import ReactDOM from "react-dom/client";

import "./styles/app.css";
import App from "./App";

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.__syncplayLocalMediaServiceWorkerReady = navigator.serviceWorker
    .register("/local-media-sw.js")
    .then(async (registration) => {
      await navigator.serviceWorker.ready;
      return registration;
    })
    .catch(() => null);
} else {
  window.__syncplayLocalMediaServiceWorkerReady = Promise.resolve(null);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
