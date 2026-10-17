// Generates public/og-image.png (1200x630) from public/icon.svg with sharp.
// Run: npm run og   (the PNG is committed; the normal build does not need it).
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONT = "'Segoe UI', 'DejaVu Sans', Arial, sans-serif";

const background = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#087F8C"/>
      <stop offset="1" stop-color="#0BA5B5"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="1080" cy="80" r="260" fill="#FFFFFF" opacity="0.06"/>
  <circle cx="1180" cy="560" r="180" fill="#FFFFFF" opacity="0.06"/>
  <rect x="70" y="95" width="440" height="440" rx="96" fill="#FFFFFF"/>
  <text x="560" y="300" font-family="${FONT}" font-size="104" font-weight="800" fill="#FFFFFF">BG Promos</text>
  <text x="564" y="380" font-family="${FONT}" font-size="40" font-weight="600" fill="#FFFFFF" opacity="0.95">Lidl · Kaufland · BILLA</text>
  <text x="564" y="440" font-family="${FONT}" font-size="34" fill="#FFFFFF" opacity="0.85">Промоции / Акции</text>
  <text x="564" y="500" font-family="${FONT}" font-size="30" fill="#FFFFFF" opacity="0.75">promos.centerai.eu</text>
</svg>`;

const icon = await sharp(await readFile(path.join(root, "public", "icon.svg")), { density: 144 })
  .resize(400, 400)
  .png()
  .toBuffer();

const out = await sharp(Buffer.from(background))
  .composite([{ input: icon, left: 90, top: 115 }])
  .png({ compressionLevel: 9 })
  .toBuffer();

await writeFile(path.join(root, "public", "og-image.png"), out);
console.log(`og-image.png written (${out.length} bytes)`);
