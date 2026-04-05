/// <reference types="vite/client" />

import type { DesktopApi } from "@syncplay/shared";

declare global {
  interface Window {
    syncplayDesktop: DesktopApi;
    __syncplayTest?: {
      getState: () => unknown;
      selectSourceOption: (sourceOption: "youtube" | "local_file" | "torrent_magnet") => void;
      selectLocalFileByPath: (filePath: string) => Promise<unknown>;
      joinRoomByCode: (roomCode: string) => void;
      leaveCurrentRoom: () => Promise<void>;
      createCurrentRoom: () => void;
    };
    __syncplayLocalPlayerDebug?: {
      getState: () => unknown;
      uploadSubtitleByPath: (filePath: string) => Promise<boolean>;
      sampleGuestBytes: (startByte: number, length: number) => number[];
    };
    __syncplayLocalMediaServiceWorkerReady?: Promise<ServiceWorkerRegistration | null>;
  }
}

export {};
