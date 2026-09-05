import { embedFace, prefetchArcFace } from "@/lib/arcface";
import type { Point } from "@/lib/faceAlign";

let faceapi: typeof import("@vladmandic/face-api") | null = null;
let modelsReady: Promise<void> | null = null;

/**
 * Limiar de distância euclidiana entre embeddings do ArcFace (norma 1).
 *
 * Nessa escala, `d² = 2 - 2·cos`, então 1.10 ≈ cosseno 0.40 — a faixa que o
 * insightface usa pra verificação. Calibrado no álbum recortando os rostos
 * casados e conferindo um a um.
 */
export const MATCH_THRESHOLD = 1.1;
/**
 * Rosto pequeno na foto original tem menos pixel real mesmo depois do
 * ladrilho, então o embedding é mais ruidoso: exige um pouco mais.
 */
export const SMALL_FACE_THRESHOLD = 1.02;
export const SMALL_FACE_AREA = 0.002;

async function api() {
  if (!faceapi) {
    faceapi = await import("@vladmandic/face-api");
  }
  return faceapi;
}

/**
 * Só detector + marcos. O reconhecimento saiu do face-api pro ArcFace, então o
 * `face_recognition_model` (6MB) e o SSD (5.4MB) não são mais baixados.
 */
export function loadFaceModels() {
  if (!modelsReady) {
    modelsReady = (async () => {
      const fa = await api();
      await Promise.all([
        fa.nets.tinyFaceDetector.loadFromUri("/models"),
        fa.nets.faceLandmark68Net.loadFromUri("/models"),
      ]);
      prefetchArcFace();
    })();
  }
  return modelsReady;
}

export async function detectFaceScore(
  input: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
) {
  const fa = await api();
  await loadFaceModels();
  const detection = await fa.detectSingleFace(
    input,
    new fa.TinyFaceDetectorOptions({
      inputSize: 320,
      scoreThreshold: 0.5,
    }),
  );
  return detection?.score ?? 0;
}

export function euclideanDistance(
  a: Float32Array | number[],
  b: Float32Array | number[],
) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Média simples e renormalizada. Embeddings do ArcFace vivem na esfera
 * unitária: a média de vários ângulos da mesma pessoa é um template melhor que
 * qualquer um deles isolado, mas precisa voltar pra norma 1.
 */
function averageEmbeddings(list: Float32Array[]) {
  if (list.length === 0) return null;
  const out = new Float32Array(list[0].length);
  for (const d of list) {
    for (let i = 0; i < out.length; i += 1) out[i] += d[i];
  }
  let norm = 0;
  for (let i = 0; i < out.length; i += 1) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return null;
  for (let i = 0; i < out.length; i += 1) out[i] /= norm;
  return out;
}

/** Embedding mais "central" do conjunto — base pra descartar outlier. */
function medoid(list: Float32Array[]) {
  let best = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let i = 0; i < list.length; i += 1) {
    let cost = 0;
    for (let j = 0; j < list.length; j += 1) {
      if (i !== j) cost += euclideanDistance(list[i], list[j]);
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  return best;
}

/**
 * Funde vários embeddings da mesma pessoa: descarta o que destoa do medoid
 * (frame borrado, rosto de outra pessoa que entrou no quadro) e tira a média
 * do resto.
 */
export function fuseEmbeddings(list: Float32Array[], maxSpread = 0.95) {
  if (list.length === 0) return null;
  if (list.length <= 2) return averageEmbeddings(list);
  const center = list[medoid(list)];
  const kept = list.filter((d) => euclideanDistance(d, center) <= maxSpread);
  return averageEmbeddings(kept.length > 0 ? kept : [center]);
}

/** Espelha horizontalmente — embedding de rosto não é invariante a espelho. */
export function mirrorToCanvas(
  input: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
  maxSide = 640,
): HTMLCanvasElement {
  const iw =
    "naturalWidth" in input && input.naturalWidth
      ? input.naturalWidth
      : "videoWidth" in input && input.videoWidth
        ? input.videoWidth
        : (input as HTMLCanvasElement).width;
  const ih =
    "naturalHeight" in input && input.naturalHeight
      ? input.naturalHeight
      : "videoHeight" in input && input.videoHeight
        ? input.videoHeight
        : (input as HTMLCanvasElement).height;

  const scale = Math.min(1, maxSide / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas indisponível");
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(input, 0, 0, w, h);
  return canvas;
}

/** Reduz a entrada pra um canvas — o alinhamento precisa da mesma superfície. */
function toCanvas(
  input: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
  maxSide: number,
): HTMLCanvasElement {
  if (input instanceof HTMLCanvasElement && Math.max(input.width, input.height) <= maxSide) {
    return input;
  }
  const iw =
    "naturalWidth" in input && input.naturalWidth
      ? input.naturalWidth
      : "videoWidth" in input && input.videoWidth
        ? input.videoWidth
        : (input as HTMLCanvasElement).width;
  const ih =
    "naturalHeight" in input && input.naturalHeight
      ? input.naturalHeight
      : "videoHeight" in input && input.videoHeight
        ? input.videoHeight
        : (input as HTMLCanvasElement).height;

  const scale = Math.min(1, maxSide / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas indisponível");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(input, 0, 0, w, h);
  return canvas;
}

/** Embedding do rosto principal da selfie. */
export async function getPrimaryEmbedding(
  input: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
): Promise<Float32Array | null> {
  const fa = await api();
  await loadFaceModels();

  const canvas = toCanvas(input, 720);
  const detection = await fa
    .detectSingleFace(
      canvas,
      new fa.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.4 }),
    )
    .withFaceLandmarks();
  if (!detection) return null;

  return embedFace(canvas, detection.landmarks.positions as Point[]);
}

export type DetectedFace = {
  descriptor: Float32Array;
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
    cx: number;
    cy: number;
  };
  confidence: number;
};

/**
 * Assinatura da pessoa. Guarda mais de um embedding (frontal + espelhado +
 * expansão) e o match usa a **menor** distância — recall maior sem mexer no
 * limiar.
 */
export type FaceQuery = {
  descriptors: Float32Array[];
  /** Quantos frames de selfie entraram na fusão. */
  frames: number;
  /** Quantas fotos do álbum realimentaram a busca. */
  expanded: number;
};

/**
 * Monta a query a partir de N frames da câmera (ou uma foto enviada).
 *
 * Um frame só carrega o azar do instante: piscada, contraluz, ângulo. Fundir
 * 3–4 frames e adicionar a versão espelhada cobre perfil pros dois lados.
 */
export async function buildFaceQuery(
  frames: Array<HTMLImageElement | HTMLVideoElement | HTMLCanvasElement>,
): Promise<FaceQuery | null> {
  const direct: Float32Array[] = [];
  const mirrored: Float32Array[] = [];

  for (const frame of frames) {
    const embedding = await getPrimaryEmbedding(frame);
    if (embedding) direct.push(embedding);
  }
  if (direct.length === 0) return null;

  for (const frame of frames.slice(0, 2)) {
    try {
      const flipped = await getPrimaryEmbedding(mirrorToCanvas(frame));
      if (flipped) mirrored.push(flipped);
    } catch {
      // espelho é bônus, não bloqueia
    }
  }

  const descriptors: Float32Array[] = [];
  const fusedDirect = fuseEmbeddings(direct);
  if (fusedDirect) descriptors.push(fusedDirect);
  const fusedMirror = fuseEmbeddings(mirrored);
  if (fusedMirror) descriptors.push(fusedMirror);

  if (descriptors.length === 0) return null;
  return { descriptors, frames: direct.length, expanded: 0 };
}

function toFaceBox(
  box: { x: number; y: number; width: number; height: number },
  imgW: number,
  imgH: number,
) {
  const x = box.x / imgW;
  const y = box.y / imgH;
  const width = box.width / imgW;
  const height = box.height / imgH;
  return { x, y, width, height, cx: x + width / 2, cy: y + height / 2 };
}

/**
 * Caminho de emergência: sem `faces.bin`, analisa a foto no próprio navegador.
 * Lento e com menos alcance que o índice (sem ladrilhos), mas o app não trava.
 */
export async function getAlbumFaces(img: HTMLImageElement): Promise<DetectedFace[]> {
  const fa = await api();
  await loadFaceModels();
  const canvas = toCanvas(img, 640);
  const detections = await fa
    .detectAllFaces(
      canvas,
      new fa.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.5 }),
    )
    .withFaceLandmarks();

  const faces: DetectedFace[] = [];
  for (const d of detections) {
    if (d.detection.score < 0.65) continue;
    const embedding = await embedFace(canvas, d.landmarks.positions as Point[]);
    if (!embedding) continue;
    faces.push({
      descriptor: embedding,
      box: toFaceBox(d.detection.box, canvas.width, canvas.height),
      confidence: d.detection.score,
    });
  }
  return faces;
}

export function thresholdForFace(face: DetectedFace["box"]) {
  const area = face.width * face.height;
  return area < SMALL_FACE_AREA ? SMALL_FACE_THRESHOLD : MATCH_THRESHOLD;
}

/** Menor distância entre a query (vários embeddings) e um rosto. */
export function queryDistance(query: FaceQuery, descriptor: Float32Array) {
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of query.descriptors) {
    const d = euclideanDistance(candidate, descriptor);
    if (d < best) best = d;
  }
  return best;
}

export function bestFaceMatch(
  query: FaceQuery,
  faces: DetectedFace[],
): { distance: number; face: DetectedFace["box"]; descriptor: Float32Array } | null {
  if (faces.length === 0) return null;

  let best: { distance: number; hit: DetectedFace } | null = null;
  for (const hit of faces) {
    const distance = queryDistance(query, hit.descriptor);
    if (!best || distance < best.distance) best = { distance, hit };
  }
  if (!best) return null;

  return {
    distance: best.distance,
    face: best.hit.box,
    descriptor: best.hit.descriptor,
  };
}

export function isMatch(distance: number, face?: DetectedFace["box"]) {
  const limit = face ? thresholdForFace(face) : MATCH_THRESHOLD;
  return distance < limit;
}

/** 100% = rosto idêntico; 0% = no limite do que ainda conta como match. */
export function distanceToScore(distance: number) {
  const floor = 0.6;
  const ratio = (distance - floor) / (MATCH_THRESHOLD - floor);
  return Math.max(0, Math.min(100, Math.round((1 - ratio) * 100)));
}

export function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Falha ao carregar ${src}`));
    img.src = src;
  });
}
