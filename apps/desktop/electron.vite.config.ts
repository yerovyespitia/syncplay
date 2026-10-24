import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    // @syncplay/shared ships TypeScript source, so it must be bundled rather
    // than left as a runtime require.
    plugins: [externalizeDepsPlugin({ exclude: ["@syncplay/shared"] })],
    resolve: {
      alias: {
        "@syncplay/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@syncplay/shared"] })]
  },
  renderer: {
    envDir: __dirname,
    plugins: [react()],
    resolve: {
      alias: {
        "@syncplay/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts")
      }
    }
  }
});
