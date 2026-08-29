import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Electron은 file:// 로 로드하므로 절대 경로를 쓰면 안 된다.
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
  server: { port: 5199, strictPort: true },
});
