#!/usr/bin/env node
/**
 * Gera public/photos/faces.json (descritores faciais pré-calculados).
 * Com isso, cada usuário só baixa ~1 arquivo em vez de analisar 890 fotos.
 *
 * Uso:
 *   cd web && npm i canvas --save-dev   # uma vez (binário nativo)
 *   npm run faces:index
 *
 * Depois commit/push do faces.json (ou sobe na mesma CDN das fotos).
 * A versão em faceCache (FACE_CACHE_VERSION) precisa bater com a do JSON.
 */
import { existsSync, readdirSync } from "fs";
import { writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const FACE_CACHE_VERSION = 5;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_SIDE = 512;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const photosDir = path.resolve(__dirname, "../public/photos");
const modelsDir = path.resolve(__dirname, "../public/models");
const outFile = path.join(photosDir, "faces.json");

async function main() {
  if (!existsSync(photosDir)) {
    console.error(`Pasta não encontrada: ${photosDir}`);
    process.exit(1);
  }

  let canvas;
  try {
    canvas = await import("canvas");
  } catch {
    console.error(
      "Falta o pacote `canvas`.\n  cd web && npm i canvas --save-dev\n  npm run faces:index",
    );
    process.exit(1);
  }

  const faceapi = await import("@vladmandic/face-api");
  const { Canvas, Image, ImageData, loadImage, createCanvas } = canvas;
  faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

  console.log("Carregando modelos...");
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromDisk(modelsDir),
    faceapi.nets.faceLandmark68Net.loadFromDisk(modelsDir),
    faceapi.nets.faceRecognitionNet.loadFromDisk(modelsDir),
  ]);

  const files = readdirSync(photosDir)
    .filter((name) => IMAGE_EXT.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  console.log(`Processando ${files.length} fotos...`);
  const photos = {};
  let done = 0;

  for (const name of files) {
    try {
      const img = await loadImage(path.join(photosDir, name));
      const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = createCanvas(w, h);
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);

      const detections = await faceapi
        .detectAllFaces(
          c,
          new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.38 }),
        )
        .withFaceLandmarks()
        .withFaceDescriptors();

      photos[name] = detections
        .filter((d) => d.detection.score >= 0.34)
        .map((d) => {
          const box = d.detection.box;
          const x = box.x / w;
          const y = box.y / h;
          const width = box.width / w;
          const height = box.height / h;
          return {
            descriptor: Array.from(d.descriptor),
            box: { x, y, width, height, cx: x + width / 2, cy: y + height / 2 },
            confidence: d.detection.score,
          };
        });
    } catch (err) {
      console.warn(`skip ${name}:`, err instanceof Error ? err.message : err);
      photos[name] = [];
    }
    done += 1;
    if (done % 25 === 0 || done === files.length) {
      console.log(`  ${done}/${files.length}`);
    }
  }

  const payload = {
    version: FACE_CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    count: files.length,
    photos,
  };

  await writeFile(outFile, JSON.stringify(payload));
  const mb = (Buffer.byteLength(JSON.stringify(payload)) / (1024 * 1024)).toFixed(2);
  console.log(`OK → ${outFile} (~${mb} MB)`);
  console.log("Faça commit/push (jsDelivr) ou copie pra CDN das fotos.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
