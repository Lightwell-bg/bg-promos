import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { navigationHandler } from "./src/sw/navigationHandler";

const apiProxy = {
  "/api": { target: "http://127.0.0.1:8001", changeOrigin: true },
};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      // Icons come from `npm run assets` (pwa-assets.config.ts) into public/.
      includeAssets: ["favicon.ico", "icon.svg", "apple-touch-icon-180x180.png"],
      manifest: {
        name: "BG Promos",
        short_name: "BG Promos",
        lang: "bg",
        description: "Промоции на Lidl, Kaufland и BILLA в България",
        theme_color: "#087F8C",
        background_color: "#F6F8F9",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png", purpose: "any" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Precache the app shell only: the hashed assets and the root index.html.
        // Prerendered pages (dist/<lang>/**/index.html, root.html) are NOT precached.
        globPatterns: ["assets/**/*.{js,css,woff2}", "*.{svg,png,ico}", "index.html"],
        globIgnores: ["og-image.png"],
        // No navigateFallback: navigations are network-first (below), so a prerendered
        // page is always fetched fresh; index.html is the offline fallback.
        navigateFallback: null,
        cleanupOutdatedCaches: true,
        // A new worker takes over open pages at once, so a fixed version replaces a broken one
        // without the user closing every tab / the Telegram mini app.
        skipWaiting: true,
        clientsClaim: true,
        // Offer images are NOT routed through the service worker: the browser loads them
        // directly (CSP img-src) with its normal HTTP cache. Routing them through the SW made
        // them depend on connect-src and on the SW version installed on the device.
        runtimeCaching: [
          {
            urlPattern: ({ request, url }) => request.mode === "navigate" && !url.pathname.startsWith("/api/"),
            // Network with a 4 s timeout; precached /index.html on timeout, error or HTTP >= 500.
            // Serialised into sw.js via toString(), see src/sw/navigationHandler.ts.
            handler: navigationHandler,
          },
        ],
      },
    }),
  ],
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
