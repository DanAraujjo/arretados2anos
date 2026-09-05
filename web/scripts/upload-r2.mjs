#!/usr/bin/env node
/**
 * Upload web/public/photos → Cloudflare R2 + gera manifest.json
 *
 * Requisitos (.env.local na pasta web):
 *   R2_ACCOUNT_ID=
 *   R2_ACCESS_KEY_ID=
 *   R2_SECRET_ACCESS_KEY=
 *   R2_BUCKET=arretados-photos
 *   R2_PREFIX=photos
 *   NEXT_PUBLIC_PHOTOS_BASE_URL=https://pub-xxxxx.r2.dev/photos
 *
 * Uso:
 *   cd web && npm run upload:r2
 *   cd web && npm run upload:r2 -- --force
 */
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i < 0) continue;
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(path.join(webRoot, ".env.local"));
loadEnvFile(path.join(webRoot, ".env"));

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET || "arretados-photos";
const prefix = (process.env.R2_PREFIX || "photos").replace(/^\/|\/$/g, "");
const publicBase = (process.env.NEXT_PUBLIC_PHOTOS_BASE_URL || "").replace(/\/$/, "");
const photosDir = path.join(webRoot, "public", "photos");
const force = process.argv.includes("--force");

if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error("Faltam R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY no .env.local");
  process.exit(1);
}

if (!existsSync(photosDir)) {
  console.error(`Pasta não encontrada: ${photosDir}`);
  process.exit(1);
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

const files = readdirSync(photosDir)
  .filter((name) => IMAGE_EXT.has(path.extname(name).toLowerCase()))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

console.log(`Bucket ${bucket} · prefix ${prefix}/ · ${files.length} fotos`);

async function objectExists(key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

function contentType(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpeg") return "image/jpeg";
  return "image/jpeg";
}

let uploaded = 0;
let skipped = 0;

for (let i = 0; i < files.length; i += 1) {
  const name = files[i];
  const key = `${prefix}/${name}`;
  const full = path.join(photosDir, name);

  if (!force && (await objectExists(key))) {
    skipped += 1;
    if ((i + 1) % 50 === 0 || i === files.length - 1) {
      process.stdout.write(`\r${i + 1}/${files.length} (skip ${skipped}, up ${uploaded})`);
    }
    continue;
  }

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(full),
      ContentType: contentType(name),
      CacheControl: "public, max-age=31536000, immutable",
      ContentLength: statSync(full).size,
    }),
  );
  uploaded += 1;
  process.stdout.write(`\r${i + 1}/${files.length} (skip ${skipped}, up ${uploaded})`);
}

console.log("\nGerando manifest.json...");

const photos = files.map((name) => ({
  id: name,
  name,
  src: publicBase
    ? `${publicBase}/${encodeURIComponent(name)}`
    : `/${prefix}/${encodeURIComponent(name)}`,
}));

const manifest = {
  generatedAt: new Date().toISOString(),
  count: photos.length,
  photos,
};

await client.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: `${prefix}/manifest.json`,
    Body: Buffer.from(JSON.stringify(manifest), "utf8"),
    ContentType: "application/json",
    CacheControl: "public, max-age=60",
  }),
);

console.log(`OK · uploaded ${uploaded} · skipped ${skipped} · manifest ${photos.length}`);
if (publicBase) {
  console.log(`App URL base: ${publicBase}`);
  console.log(`Manifest:     ${publicBase}/manifest.json`);
} else {
  console.log("Defina NEXT_PUBLIC_PHOTOS_BASE_URL no .env.local (URL pública do R2 + /photos)");
}
console.log("Lembre CORS no R2: GET/HEAD, origin * (ou seu domínio Vercel)");
