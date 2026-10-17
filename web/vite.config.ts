import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

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
        runtimeCaching: [
          {
            urlPattern: ({ request, url }) => request.mode === "navigate" && !url.pathname.startsWith("/api/"),
            handler: "NetworkFirst",
            options: {
              // New name: the old "pages" cache (stale HTML from earlier builds) is never read again.
              cacheName: "pages-v2",
              networkTimeoutSeconds: 4,
              plugins: [
                {
                  // No long-lived pages cache: stale prerendered HTML would reference hashed
                  // assets that a newer deploy has already deleted.
                  cacheWillUpdate: async () => null,
                },
                {
                  // Offline and the page was never visited: fall back to the precached app shell.
                  handlerDidError: async () =>
                    (await caches.match("/index.html", { ignoreSearch: true })) ?? Response.error(),
                },
              ],
            },
          },
          {
            urlPattern: ({ url }) =>
              url.hostname.endsWith("kaufland.media.schwarz") ||
              url.hostname.endsWith("imgproxy-retcat.assets.schwarz"),
            handler: "CacheFirst",
            options: {
              cacheName: "offer-images",
              expiration: { maxEntries: 60, maxAgeSeconds: 7 * 24 * 60 * 60, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [0, 200] },
            },
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
