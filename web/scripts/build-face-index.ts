#!/usr/bin/env -S npx tsx
/**
 * Gera o índice facial do álbum: public/photos/faces.bin.
 *
 * O reconhecimento usa **ArcFace** (insightface w600k_mbf, 512-d). O descritor
 * anterior (ResNet do face-api) confundia pessoas diferentes em foto de grupo a
 * distâncias baixas — conferido recortando os rostos casados e olhando um a um.
 * O face-api continua no papel que ele faz bem: detectar rosto e marcar os 68
 * pontos que alimentam o alinhamento.
 *
 * Pipeline por foto:
 *   1. detecta na imagem inteira e em ladrilhos 2x2 (rosto de fundo em foto de
 *      grupo só aparece grande o suficiente dentro do ladrilho);
 *   2. funde por IoU e descarta detecção fraca — abaixo de MIN_CONFIDENCE o que
 *      aparece é torso, mão e areia, não gente;
 *   3. alinha pelos 5 pontos canônicos e roda o ArcFace;
 *   4. grava os embeddings quantizados em int8.
 *
 * Uso:
 *   npm run faces:index              # usa todos os núcleos
 *   npm run faces:index -- --jobs 4
 */
import { createRequire } from "module";
import { spawn } from "child_process";
import { existsSync, readdirSync, mkdirSync, readFileSync, rmSync } from "fs";
import { writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createCanvas, loadImage, Image, ImageData } from "@napi-rs/canvas";
import * as ort from "onnxruntime-node";
import {
  ARCFACE_INPUT_SIZE,
  ARCFACE_MODEL_PATH,
  ARCFACE_TEMPLATE,
  fivePointsFrom68,
  l2normalize,
  rgbaToNchw,
  similarityTransform,
  type Point,
} from "../src/lib/faceAlign.ts";

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const faceapi: any = require("@vladmandic/face-api/dist/face-api.node-wasm.js");

const FACE_INDEX_VERSION = 10;
const EMBEDDING_DIMS = 512;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** Lado máximo da passada de imagem inteira. */
const FULL_MAX_SIDE = 1024;
/** Acima disso vale varrer ladrilhos atrás de rosto pequeno. */
const TILE_MIN_SIDE = 1100;
const TILE_MAX_SIDE = 768;
const TILE_OVERLAP = 0.18;

/**
 * Piso de confiança. Medido no álbum: abaixo de ~0.65 a "detecção" costuma ser
 * ombro, mão, tatuagem ou areia — e esses vetores caem perto de qualquer
 * consulta, que era a maior fonte de falso positivo.
 */
const MIN_CONFIDENCE = 0.65;
/** Rosto menor que isto não tem pixel suficiente nem depois do ladrilho. */
const MIN_FACE_AREA = 0.0004;

/** Embedding normalizado tem componentes bem dentro de ±0.3. */
const QUANT_SCALE = 0.3;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const photosDir = path.resolve(__dirname, "../public/photos");
const modelsDir = path.resolve(__dirname, "../public/models");
/**
 * O SSD acha mais rosto que o Tiny, mas são 5.4MB que o navegador não precisa
 * baixar: online a detecção é só da selfie, e o álbum já vem pronto no índice.
 * Por isso ele mora fora de `public/`.
 */
const buildOnlyModelsDir = path.resolve(__dirname, "../.models-build");
const arcfacePath = path.resolve(__dirname, "../public", ARCFACE_MODEL_PATH);
const outFile = path.join(photosDir, "faces.bin");
const shardDir = path.resolve(__dirname, "../.face-index-cache");

type FaceRecord = {
  box: { x: number; y: number; width: number; height: number };
  confidence: number;
  embedding: string;
};

const CanvasCtor = createCanvas(1, 1).constructor;
faceapi.env.monkeyPatch({
  Canvas: CanvasCtor,
  Image,
  ImageData,
  createCanvasElement: () => createCanvas(1, 1),
  createImageElement: () => new Image(),
});

function iou(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

type RawDetection = {
  box: { x: number; y: number; width: number; height: number };
  confidence: number;
  /** Marcos já em coordenadas da foto inteira, em pixels. */
  landmarks: Point[];
};

/** Non-max suppression sobre caixas normalizadas. */
function mergeDetections(list: RawDetection[]) {
  const sorted = list.slice().sort((a, b) => b.confidence - a.confidence);
  const kept: RawDetection[] = [];
  for (const d of sorted) {
    if (kept.some((k) => iou(k.box, d.box) >= 0.4)) continue;
    kept.push(d);
  }
  return kept;
}

async function detectOn(canvas: unknown) {
  const [ssd, tiny] = await Promise.all([
    faceapi
      .detectAllFaces(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks(),
    faceapi
      .detectAllFaces(
        canvas,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.5 }),
      )
      .withFaceLandmarks(),
  ]);
  return [...ssd, ...tiny];
}

function drawRegion(
  img: Image,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  maxSide: number,
) {
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = createCanvas(w, h);
  canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  return { canvas, w, h };
}

/**
 * Detecção numa região → coordenadas da foto inteira. `sx/sy` é a origem do
 * recorte no original e `regionW/H` o tamanho dele antes de reduzir.
 */
function toFullFrame(
  detections: Array<{ detection: { box: DOMRectLike; score: number }; landmarks: { positions: Point[] } }>,
  sx: number,
  sy: number,
  regionW: number,
  regionH: number,
  drawnW: number,
  drawnH: number,
): RawDetection[] {
  const kx = regionW / drawnW;
  const ky = regionH / drawnH;
  return detections
    .filter((d) => d.detection.score >= MIN_CONFIDENCE)
    .map((d) => {
      const b = d.detection.box;
      return {
        confidence: d.detection.score,
        box: {
          x: sx + b.x * kx,
          y: sy + b.y * ky,
          width: b.width * kx,
          height: b.height * ky,
        },
        landmarks: d.landmarks.positions.map((p) => ({
          x: sx + p.x * kx,
          y: sy + p.y * ky,
        })),
      };
    });
}

type DOMRectLike = { x: number; y: number; width: number; height: number };

async function detectFaces(img: Image): Promise<RawDetection[]> {
  const fullW = img.width;
  const fullH = img.height;
  const found: RawDetection[] = [];

  const full = drawRegion(img, 0, 0, fullW, fullH, FULL_MAX_SIDE);
  found.push(
    ...toFullFrame(await detectOn(full.canvas), 0, 0, fullW, fullH, full.w, full.h),
  );

  if (Math.max(fullW, fullH) >= TILE_MIN_SIDE) {
    const tileW = Math.round(fullW * (0.5 + TILE_OVERLAP / 2));
    const tileH = Math.round(fullH * (0.5 + TILE_OVERLAP / 2));
    for (const sx of [0, fullW - tileW]) {
      for (const sy of [0, fullH - tileH]) {
        const tile = drawRegion(img, sx, sy, tileW, tileH, TILE_MAX_SIDE);
        found.push(
          ...toFullFrame(
            await detectOn(tile.canvas),
            sx,
            sy,
            tileW,
            tileH,
            tile.w,
            tile.h,
          ),
        );
      }
    }
  }

  return mergeDetections(found);
}

/** Recorta o rosto na pose canônica do ArcFace. */
function alignFace(img: Image, landmarks: Point[]) {
  const five = fivePointsFrom68(landmarks);
  if (!five) return null;
  const [a, b, c, d, e, f] = similarityTransform(five, ARCFACE_TEMPLATE);
  const canvas = createCanvas(ARCFACE_INPUT_SIZE, ARCFACE_INPUT_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.resetTransform();
  return ctx.getImageData(0, 0, ARCFACE_INPUT_SIZE, ARCFACE_INPUT_SIZE).data;
}

async function embed(session: ort.InferenceSession, pixels: Uint8ClampedArray) {
  const input = new ort.Tensor("float32", rgbaToNchw(pixels), [
    1,
    3,
    ARCFACE_INPUT_SIZE,
    ARCFACE_INPUT_SIZE,
  ]);
  const output = await session.run({ [session.inputNames[0]]: input });
  const raw = output[session.outputNames[0]].data as Float32Array;
  return l2normalize(Float32Array.from(raw));
}

async function runShard(shard: number, total: number) {
  await faceapi.tf.setBackend("wasm");
  await faceapi.tf.ready();
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromDisk(modelsDir),
    faceapi.nets.ssdMobilenetv1.loadFromDisk(buildOnlyModelsDir),
    faceapi.nets.faceLandmark68Net.loadFromDisk(modelsDir),
  ]);
  const session = await ort.InferenceSession.create(arcfacePath, {
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });

  const files = listPhotos().filter((_, i) => i % total === shard);
  const result: Record<string, FaceRecord[]> = {};

  for (const name of files) {
    try {
      const img = await loadImage(path.join(photosDir, name));
      const faces: FaceRecord[] = [];
      for (const det of await detectFaces(img)) {
        const areaNorm = (det.box.width / img.width) * (det.box.height / img.height);
        if (areaNorm < MIN_FACE_AREA) continue;
        const pixels = alignFace(img, det.landmarks);
        if (!pixels) continue;
        const vector = await embed(session, pixels);
        faces.push({
          box: {
            x: det.box.x / img.width,
            y: det.box.y / img.height,
            width: det.box.width / img.width,
            height: det.box.height / img.height,
          },
          confidence: det.confidence,
          embedding: Buffer.from(
            vector.buffer,
            vector.byteOffset,
            vector.byteLength,
          ).toString("base64"),
        });
      }
      result[name] = faces;
    } catch (err) {
      console.warn(`skip ${name}:`, err instanceof Error ? err.message : err);
      result[name] = [];
    }
    process.stdout.write(".");
  }

  mkdirSync(shardDir, { recursive: true });
  await writeFile(path.join(shardDir, `shard-${shard}.json`), JSON.stringify(result));
}

function listPhotos() {
  return readdirSync(photosDir)
    .filter((name) => IMAGE_EXT.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Blocos por tipo e alinhado a 4 bytes: no navegador a leitura é só criar views
 * sobre o ArrayBuffer, sem laço de parsing.
 */
function serialize(names: string[], perPhoto: FaceRecord[][]) {
  const faceCount = perPhoto.reduce((n, faces) => n + faces.length, 0);
  const namesBuf = Buffer.from(names.join("\n"), "utf8");

  const align = (n: number) => (n + 3) & ~3;
  const headerSize = 24;
  const namesOffset = headerSize;
  const countsOffset = align(namesOffset + namesBuf.length);
  const embOffset = align(countsOffset + perPhoto.length * 2);
  const boxOffset = align(embOffset + faceCount * EMBEDDING_DIMS);
  const confOffset = align(boxOffset + faceCount * 8);
  const totalSize = align(confOffset + faceCount);

  const buffer = Buffer.alloc(totalSize);
  buffer.write("ARFI", 0, "ascii");
  buffer.writeUInt16LE(FACE_INDEX_VERSION, 4);
  buffer.writeUInt16LE(EMBEDDING_DIMS, 6);
  buffer.writeUInt32LE(perPhoto.length, 8);
  buffer.writeUInt32LE(faceCount, 12);
  buffer.writeFloatLE(QUANT_SCALE, 16);
  buffer.writeUInt32LE(namesBuf.length, 20);
  namesBuf.copy(buffer, namesOffset);

  let faceIndex = 0;
  let clipped = 0;
  const u16 = (v: number) => Math.max(0, Math.min(65535, Math.round(v * 65535)));

  for (let p = 0; p < perPhoto.length; p += 1) {
    buffer.writeUInt16LE(perPhoto[p].length, countsOffset + p * 2);
    for (const face of perPhoto[p]) {
      const vector = decodeEmbedding(face.embedding);
      const base = embOffset + faceIndex * EMBEDDING_DIMS;
      for (let i = 0; i < EMBEDDING_DIMS; i += 1) {
        const q = Math.round((vector[i] / QUANT_SCALE) * 127);
        if (q > 127 || q < -127) clipped += 1;
        buffer.writeInt8(Math.max(-127, Math.min(127, q)), base + i);
      }
      const b = boxOffset + faceIndex * 8;
      buffer.writeUInt16LE(u16(face.box.x), b);
      buffer.writeUInt16LE(u16(face.box.y), b + 2);
      buffer.writeUInt16LE(u16(face.box.width), b + 4);
      buffer.writeUInt16LE(u16(face.box.height), b + 6);
      buffer.writeUInt8(
        Math.max(0, Math.min(255, Math.round(face.confidence * 255))),
        confOffset + faceIndex,
      );
      faceIndex += 1;
    }
  }

  return { buffer, faceCount, clipped };
}

/**
 * `Buffer.from(base64)` devolve uma view dentro do pool interno do Node — usar
 * `.buffer` direto leria lixo vizinho. Copiar é o jeito seguro.
 */
function decodeEmbedding(base64: string) {
  const bytes = Buffer.from(base64, "base64");
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Float32Array(copy);
}

function spawnShard(shard: number, jobs: number) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url), "--shard", String(shard), "--jobs", String(jobs)],
      { cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`shard ${shard} saiu com ${code}`)),
    );
    child.on("error", reject);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? Number(argv[i + 1]) : null;
  };
  const shard = flag("--shard");
  const jobs = flag("--jobs") ?? Math.max(1, Math.min(8, os.cpus().length - 2));

  if (!existsSync(photosDir)) {
    console.error(`Pasta não encontrada: ${photosDir}`);
    process.exit(1);
  }
  if (!existsSync(arcfacePath)) {
    console.error(`Modelo ArcFace não encontrado: ${arcfacePath}`);
    process.exit(1);
  }

  if (shard !== null) {
    await runShard(shard, jobs);
    return;
  }

  const files = listPhotos();
  console.log(`${files.length} fotos · ArcFace 512-d · ${jobs} processos`);
  rmSync(shardDir, { recursive: true, force: true });
  const started = Date.now();

  await Promise.all(
    Array.from({ length: jobs }, (_, i) => spawnShard(i, jobs)),
  );
  process.stdout.write("\n");

  // Remonta na ordem original: cada shard levou as fotos i % jobs === shard.
  const shards = Array.from({ length: jobs }, (_, i) =>
    JSON.parse(readFileSync(path.join(shardDir, `shard-${i}.json`), "utf8")) as Record<
      string,
      FaceRecord[]
    >,
  );
  const perPhoto = files.map((name) => {
    for (const s of shards) if (s[name]) return s[name];
    return [];
  });

  const { buffer, faceCount, clipped } = serialize(files, perPhoto);
  await writeFile(outFile, buffer);
  rmSync(shardDir, { recursive: true, force: true });

  const withFaces = perPhoto.filter((f) => f.length > 0).length;
  const mb = (buffer.length / (1024 * 1024)).toFixed(2);
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(
    `OK → ${outFile} (${mb} MB) · ${withFaces}/${files.length} fotos · ${faceCount} rostos · ${secs}s`,
  );
  if (clipped > 0) {
    const pct = ((clipped / (faceCount * EMBEDDING_DIMS)) * 100).toFixed(4);
    console.log(`  ${clipped} componentes saturados na quantização (${pct}%)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
