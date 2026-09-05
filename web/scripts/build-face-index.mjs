#!/usr/bin/env node
/**
 * Gera public/photos/faces.json (descritores pré-calculados).
 * Online o scan só baixa este JSON + compara a selfie (~segundos).
 *
 * Uso: cd web && npm run faces:index
 */
import { createRequire } from "module";
import { existsSync, readdirSync } from "fs";
import { writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { createCanvas, loadImage, Image, ImageData } from "@napi-rs/canvas";

const require = createRequire(import.meta.url);
const faceapi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");

const FACE_CACHE_VERSION = 5;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_SIDE = 512;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const photosDir = path.resolve(__dirname, "../public/photos");
const modelsDir = path.resolve(__dirname, "../public/models");
const outFile = path.join(photosDir, "faces.json");

const Canvas = createCanvas(1, 1).constructor;
faceapi.env.monkeyPatch({
  Canvas,
  Image,
  ImageData,
  createCanvasElement: () => createCanvas(1, 1),
  createImageElement: () => new Image(),
});

async function main() {
  if (!existsSync(photosDir)) {
    console.error(`Pasta não encontrada: ${photosDir}`);
    process.exit(1);
  }

  console.log("Backend WASM...");
  await faceapi.tf.setBackend("wasm");
  await faceapi.tf.ready();

  console.log("Carregando modelos...");
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromDisk(modelsDir),
    faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsDir),
    faceapi.nets.faceLandmark68Net.loadFromDisk(modelsDir),
    faceapi.nets.faceRecognitionNet.loadFromDisk(modelsDir),
  ]);

  const files = readdirSync(photosDir)
    .filter((name) => IMAGE_EXT.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  console.log(`Processando ${files.length} fotos...`);
  const photos = {};
  let done = 0;
  const started = Date.now();

  function toEntries(detections, w, h) {
    return detections
      .filter((d) => d.detection.score >= 0.32)
      .map((d) => {
        const box = d.detection.box;
        const x = box.x / w;
        const y = box.y / h;
        const width = box.width / w;
        const height = box.height / h;
        return {
          descriptor: Array.from(d.descriptor, (n) => Math.round(n * 1e5) / 1e5),
          box: {
            x: Math.round(x * 1e4) / 1e4,
            y: Math.round(y * 1e4) / 1e4,
            width: Math.round(width * 1e4) / 1e4,
            height: Math.round(height * 1e4) / 1e4,
            cx: Math.round((x + width / 2) * 1e4) / 1e4,
            cy: Math.round((y + height / 2) * 1e4) / 1e4,
          },
          confidence: Math.round(d.detection.score * 1e3) / 1e3,
        };
      });
  }

  for (const name of files) {
    try {
      const img = await loadImage(path.join(photosDir, name));
      const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = createCanvas(w, h);
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);

      let detections = await faceapi
        .detectAllFaces(
          c,
          new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.38 }),
        )
        .withFaceLandmarks()
        .withFaceDescriptors();

      // Offline: se Tiny falhar, SSD acha mais rostos (scan online só lê o JSON)
      if (detections.length === 0) {
        detections = await faceapi
          .detectAllFaces(c, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35 }))
          .withFaceLandmarks()
          .withFaceDescriptors();
      }

      photos[name] = toEntries(detections, w, h);
    } catch (err) {
      console.warn(`skip ${name}:`, err instanceof Error ? err.message : err);
      photos[name] = [];
    }
    done += 1;
    if (done % 25 === 0 || done === files.length) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(0);
      const eta =
        done > 0
          ? ((((Date.now() - started) / done) * (files.length - done)) / 1000).toFixed(0)
          : "?";
      console.log(`  ${done}/${files.length} (${elapsed}s, eta ~${eta}s)`);
    }
  }

  const payload = {
    version: FACE_CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    count: files.length,
    photos,
  };

  const json = JSON.stringify(payload);
  await writeFile(outFile, json);
  const mb = (Buffer.byteLength(json) / (1024 * 1024)).toFixed(2);
  console.log(`OK → ${outFile} (~${mb} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
