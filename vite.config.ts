import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/oio/",
  build: { outDir: "dist/client" },
  optimizeDeps: { include: ["react", "react-dom/client", "dexie"] },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: { clientFiles: ["./src/main.tsx"] },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["oio-icon-192.png", "oio-icon-512.png"],
      manifest: {
        name: "OIO · Output Input Output",
        short_name: "OIO",
        description: "把真实生活练成自己会说的英文。",
        theme_color: "#fbfbfa",
        background_color: "#fbfbfa",
        display: "standalone",
        start_url: "/oio/",
        scope: "/oio/",
        icons: [
          { src: "oio-icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "oio-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/oio/index.html",
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
        runtimeCaching: [{
          urlPattern: /^https:\/\/.*\.supabase\.co\/.*$/i,
          handler: "NetworkOnly",
        }],
      },
    }),
  ],
});
