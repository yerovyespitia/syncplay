/// <reference types="vite/client" />

import type { DesktopApi } from "@syncplay/shared";

declare global {
  interface Window {
    syncplayDesktop: DesktopApi;
  }
}

export {};

