#!/usr/bin/env -S npx tsx
/**
 * Despeja recortes de rosto já alinhados como tensores float32 crus.
 *
 * Servem de conjunto de calibração pra quantização estática do ArcFace. Tem que
 * ser o **mesmo** pré-processamento do índice e do navegador — por isso o dump
 * sai daqui, e não de um script Python lendo PNG por conta própria.
 *
 * Uso: npx tsx scripts/dump-calibration.ts <dir-saida> [qtd-fotos]
 */
import { createRequire } from "module";
import { mkdirSync, readdirSync, writeFileSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createCanvas, loadImage, Image, ImageData } from "@napi-rs/canvas";
import {
  ARCFACE_INPUT_SIZE,
  ARCFACE_TEMPLATE,
  fivePointsFrom68,
  rgbaToNchw,
  similarityTransform,
  type Point,
} from "../src/lib/faceAlign.ts";

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const faceapi: any = require("@vladmandic/face-api/dist/face-api.node-wasm.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const photosDir = path.resolve(__dirname, "../public/photos");
const modelsDir = path.resolve(__dirname, "../public/models");

const CanvasCtor = createCanvas(1, 1).constructor;
faceapi.env.monkeyPatch({
  Canvas: CanvasCtor,
  Image,
  ImageData,
  createCanvasElement: () => createCanvas(1, 1),
  createImageElement: () => new Image(),
});

async function main() {
  const outDir = process.argv[2];
  const wanted = Number(process.argv[3] ?? 200);
  if (!outDir) {
    console.error("uso: npx tsx scripts/dump-calibration.ts <dir> [qtd]");
    process.exit(1);
  }

  await faceapi.tf.setBackend("wasm");
  await faceapi.tf.ready();
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromDisk(modelsDir),
    faceapi.nets.faceLandmark68Net.loadFromDisk(modelsDir),
  ]);

  const files = readdirSync(photosDir).filter((n) => /\.(jpe?g|png|webp)$/i.test(n));
  // Amostra espalhada pelo álbum: luz e enquadramento variam muito ao longo dele.
  const step = Math.max(1, Math.floor(files.length / wanted));
  const sample = files.filter((_, i) => i % step === 0);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  let saved = 0;
  for (const name of sample) {
    if (saved >= wanted) break;
    try {
      const img = await loadImage(path.join(photosDir, name));
      const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = createCanvas(w, h);
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);

      const detections = await faceapi
        .detectAllFaces(
          canvas,
          new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.6 }),
        )
        .withFaceLandmarks();

      for (const d of detections.slice(0, 2)) {
        const five = fivePointsFrom68(d.landmarks.positions as Point[]);
        if (!five) continue;
        const [a, b, c, dd, e, f] = similarityTransform(five, ARCFACE_TEMPLATE);
        const crop = createCanvas(ARCFACE_INPUT_SIZE, ARCFACE_INPUT_SIZE);
        const cctx = crop.getContext("2d");
        cctx.setTransform(a, b, c, dd, e, f);
        cctx.drawImage(canvas, 0, 0);
        cctx.resetTransform();
        const pixels = cctx.getImageData(0, 0, ARCFACE_INPUT_SIZE, ARCFACE_INPUT_SIZE).data;
        const tensor = rgbaToNchw(pixels);
        writeFileSync(
          path.join(outDir, `${String(saved).padStart(4, "0")}.f32`),
          Buffer.from(tensor.buffer, tensor.byteOffset, tensor.byteLength),
        );
        saved += 1;
        if (saved >= wanted) break;
      }
    } catch {
      // pula foto problemática
    }
  }

  console.log(`${saved} tensores em ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
