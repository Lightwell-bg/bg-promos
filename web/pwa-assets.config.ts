import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

// Light background: the teal basket must stay visible on maskable/apple icons.
const BRAND = "#E6F3F4";

/**
 * Generates favicon.ico, pwa-64x64/192x192/512x512.png, maskable-icon-512x512.png
 * and apple-touch-icon-180x180.png from public/icon.svg (run: npm run assets).
 * The art in icon.svg already keeps a safe margin; maskable/apple add a brand
 * background and a little extra padding.
 */
export default defineConfig({
  headLinkOptions: { preset: "2023" },
  preset: {
    ...minimal2023Preset,
    maskable: {
      sizes: [512],
      padding: 0.1,
      resizeOptions: { fit: "contain", background: BRAND },
    },
    apple: {
      sizes: [180],
      padding: 0.1,
      resizeOptions: { fit: "contain", background: BRAND },
    },
  },
  images: ["public/icon.svg"],
});
