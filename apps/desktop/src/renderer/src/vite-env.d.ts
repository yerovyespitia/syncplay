/// <reference types="vite/client" />

import type { DesktopApi } from "@syncplay/shared";

declare global {
  interface Window {
    syncplayDesktop: DesktopApi;
    __syncplayTest?: {
      getState: () => unknown;
      selectSourceOption: (sourceOption: "youtube" | "local_file") => void;
      selectLocalFileByPath: (filePath: string) => Promise<unknown>;
      joinRoomByCode: (roomCode: string) => void;
      createCurrentRoom: () => void;
    };
    __syncplayLocalPlayerDebug?: {
      getState: () => unknown;
    };
  }
}

export {};
