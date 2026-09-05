#!/usr/bin/env node
/**
 * Gera public/photos/manifest.json pra hospedar fotos no GitHub + jsDelivr
 * (sem cartão, sem R2).
 *
 * Uso:
 *   cd web && npm run manifest:photos
 *
 * Depois publique a pasta photos num repo público e use:
 *   NEXT_PUBLIC_PHOTOS_BASE_URL=https://cdn.jsdelivr.net/gh/USER/REPO@main/photos
 */
import { existsSync, readdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const photosDir = path.resolve(__dirname, "../public/photos");
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

if (!existsSync(photosDir)) {
  console.error(`Pasta não encontrada: ${photosDir}`);
  process.exit(1);
}

const files = readdirSync(photosDir)
  .filter((name) => IMAGE_EXT.has(path.extname(name).toLowerCase()))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const base = (process.env.NEXT_PUBLIC_PHOTOS_BASE_URL || "").replace(/\/$/, "");

const photos = files.map((name) => ({
  id: name,
  name,
  src: base
    ? `${base}/${encodeURIComponent(name)}`
    : `/photos/${encodeURIComponent(name)}`,
}));

const manifest = {
  generatedAt: new Date().toISOString(),
  count: photos.length,
  photos,
};

const out = path.join(photosDir, "manifest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log(`OK · ${photos.length} fotos → ${out}`);
if (!base) {
  console.log(`
Próximos passos (sem cartão):
1. Crie um repo público no GitHub (ex: arretados-photos)
2. Envie o conteúdo de web/public/photos/ (incluindo manifest.json)
3. No app (Vercel / .env.local):
   NEXT_PUBLIC_PHOTOS_BASE_URL=https://cdn.jsdelivr.net/gh/SEU_USER/arretados-photos@main
   (se as fotos estiverem na raiz do repo)
   ou ...@main/photos se estiverem numa pasta photos/
4. Deploy só da pasta web na Vercel (sem incluir as 442MB no deploy)
`);
}
