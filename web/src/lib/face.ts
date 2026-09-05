let faceapi: typeof import("@vladmandic/face-api") | null = null;
let modelsReady: Promise<void> | null = null;

/**
 * Distância euclidiana entre descritores.
 * face-api costuma usar ~0.6. Quanto MENOR o limite, menos falso positivo.
 * 0.48 ≈ meio-termo: acha mais você sem liberar geral.
 */
export const MATCH_THRESHOLD = 0.48;
/** Rostos minúsculos em grupo são ruidosos — um pouco mais rigoroso. */
export const SMALL_FACE_THRESHOLD = 0.44;
export const SMALL_FACE_AREA = 0.01; // ~1% da imagem

async function api() {
  if (!faceapi) {
    faceapi = await import("@vladmandic/face-api");
  }
  return faceapi;
}

export function loadFaceModels() {
  if (!modelsReady) {
    modelsReady = (async () => {
      const fa = await api();
      await Promise.all([
        fa.nets.tinyFaceDetector.loadFromUri("/models"),
        fa.nets.ssdMobilenetv1.loadFromUri("/models"),
        fa.nets.faceLandmark68Net.loadFromUri("/models"),
        fa.nets.faceRecognitionNet.loadFromUri("/models"),
      ]);
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

function averageDescriptors(list: Float32Array[]) {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const out = new Float32Array(list[0].length);
  for (const d of list) {
    for (let i = 0; i < out.length; i += 1) out[i] += d[i];
  }
  for (let i = 0; i < out.length; i += 1) out[i] /= list.length;
  return out;
}

/** Selfie: prioriza SSD; se os dois baterem, faz média. */
export async function getPrimaryDescriptor(
  input: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
) {
  const fa = await api();
  await loadFaceModels();

  const [ssd, tiny] = await Promise.all([
    fa
      .detectSingleFace(input, new fa.SsdMobilenetv1Options({ minConfidence: 0.45 }))
      .withFaceLandmarks()
      .withFaceDescriptor(),
    fa
      .detectSingleFace(
        input,
        new fa.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 }),
      )
      .withFaceLandmarks()
      .withFaceDescriptor(),
  ]);

  if (ssd?.descriptor && tiny?.descriptor) {
    const gap = euclideanDistance(ssd.descriptor, tiny.descriptor);
    // Se Tiny e SSD discordam demais, fica só com SSD (mais estável).
    if (gap < 0.35) return averageDescriptors([ssd.descriptor, tiny.descriptor]);
    return ssd.descriptor;
  }
  return ssd?.descriptor ?? tiny?.descriptor ?? null;
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

function toFaceBox(
  box: { x: number; y: number; width: number; height: number },
  imgW: number,
  imgH: number,
) {
  const x = box.x / imgW;
  const y = box.y / imgH;
  const width = box.width / imgW;
  const height = box.height / imgH;
  return {
    x,
    y,
    width,
    height,
    cx: x + width / 2,
    cy: y + height / 2,
  };
}

/** Álbum: só rostos com confiança razoável (menos lixo = menos falso positivo). */
export async function getAllFaces(
  input: HTMLImageElement | HTMLCanvasElement,
): Promise<DetectedFace[]> {
  const fa = await api();
  await loadFaceModels();
  const imgW =
    "naturalWidth" in input && input.naturalWidth
      ? input.naturalWidth
      : input.width;
  const imgH =
    "naturalHeight" in input && input.naturalHeight
      ? input.naturalHeight
      : input.height;

  let detections = await fa
    .detectAllFaces(input, new fa.SsdMobilenetv1Options({ minConfidence: 0.35 }))
    .withFaceLandmarks()
    .withFaceDescriptors();

  if (detections.length === 0) {
    detections = await fa
      .detectAllFaces(
        input,
        new fa.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.35 }),
      )
      .withFaceLandmarks()
      .withFaceDescriptors();
  }

  return detections
    .map((d) => ({
      descriptor: d.descriptor,
      box: toFaceBox(d.detection.box, imgW, imgH),
      confidence: d.detection.score,
    }))
    .filter((f) => f.confidence >= 0.32);
}

/**
 * Versão rápida pro scan do álbum: redimensiona + só TinyFaceDetector.
 * (~3–5× mais rápido que SSD em foto cheia; qualidade ok pra matching).
 */
export function resizeForScan(
  img: HTMLImageElement,
  maxSide = 512,
): HTMLCanvasElement {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.min(1, maxSide / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas indisponível");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

export async function getAlbumFaces(img: HTMLImageElement): Promise<DetectedFace[]> {
  const fa = await api();
  await loadFaceModels();
  const canvas = resizeForScan(img, 512);
  const detections = await fa
    .detectAllFaces(
      canvas,
      new fa.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.38 }),
    )
    .withFaceLandmarks()
    .withFaceDescriptors();

  return detections
    .map((d) => ({
      descriptor: d.descriptor,
      box: toFaceBox(d.detection.box, canvas.width, canvas.height),
      confidence: d.detection.score,
    }))
    .filter((f) => f.confidence >= 0.34);
}

/** @deprecated use getAllFaces */
export async function getAllDescriptors(
  input: HTMLImageElement | HTMLCanvasElement,
) {
  const faces = await getAllFaces(input);
  return faces.map((f) => f.descriptor);
}

export function thresholdForFace(face: DetectedFace["box"]) {
  const area = face.width * face.height;
  return area < SMALL_FACE_AREA ? SMALL_FACE_THRESHOLD : MATCH_THRESHOLD;
}

export function bestFaceMatch(
  query: Float32Array,
  faces: DetectedFace[],
): { distance: number; face: DetectedFace["box"]; secondDistance: number } | null {
  if (faces.length === 0) return null;

  const ranked = faces
    .map((hit) => ({
      distance: euclideanDistance(query, hit.descriptor),
      face: hit.box,
      confidence: hit.confidence,
    }))
    .sort((a, b) => a.distance - b.distance);

  const best = ranked[0];
  const secondDistance = ranked[1]?.distance ?? Number.POSITIVE_INFINITY;
  return {
    distance: best.distance,
    face: best.face,
    secondDistance,
  };
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

export function bestDistanceToQuery(
  query: Float32Array,
  candidates: Float32Array[],
) {
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    best = Math.min(best, euclideanDistance(query, candidate));
  }
  return best;
}

export function isMatch(
  distance: number,
  face?: DetectedFace["box"],
  secondDistance?: number,
) {
  const limit = face ? thresholdForFace(face) : MATCH_THRESHOLD;
  if (!(distance < limit)) return false;

  // Só descarta ambiguidade quando o "melhor" já está bem no limite.
  if (
    typeof secondDistance === "number" &&
    Number.isFinite(secondDistance) &&
    secondDistance - distance < 0.04 &&
    distance > 0.4
  ) {
    return false;
  }

  return true;
}

export function distanceToScore(distance: number) {
  return Math.max(
    0,
    Math.min(100, Math.round((1 - distance / (MATCH_THRESHOLD + 0.1)) * 100)),
  );
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
