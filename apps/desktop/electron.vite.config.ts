import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@syncplay/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        "@syncplay/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts")
      }
    }
  }
});

