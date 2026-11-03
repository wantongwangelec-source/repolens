import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // During development, the frontend runs its own service independently, and the API is reverse proxied to `repolens serve`.
    // The port must match the DEFAULT_PORT of @repolens/server; the web does not depend on the server,
    // Can't import that constant, so it has to be hard-coded here. When changing the port, both places need to be modified together.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7173",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    format: "es",
  },
});
