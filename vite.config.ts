import { defineConfig } from "vite";

// In dev, the browser talks to Vite (5173). Vite forwards API calls to our server (3000)
export default defineConfig({
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/pay": "http://localhost:3000",
    },
  },
});

// In production, the browser talks to our server (3000). The server serves the built web assets and handles API calls.