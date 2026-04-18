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
      setForceIsolatedTorrentSessions: (nextValue: boolean) => void;
    };
    __syncplayLocalPlayerDebug?: {
      getState: () => unknown;
      uploadSubtitleByPath: (filePath: string) => Promise<boolean>;
      sampleGuestBytes: (startByte: number, length: number) => number[];
      setCaptionsEnabled: (nextValue: boolean) => void;
      toggleCaptions: () => void;
    };
    __syncplayLocalMediaServiceWorkerReady?: Promise<ServiceWorkerRegistration | null>;
  }
}

export {};
