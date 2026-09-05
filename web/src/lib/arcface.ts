import type { InferenceSession } from "onnxruntime-web";
import {
  ARCFACE_INPUT_SIZE,
  ARCFACE_MODEL_PATH,
  ARCFACE_TEMPLATE,
  fivePointsFrom68,
  l2normalize,
  rgbaToNchw,
  similarityTransform,
  type Point,
} from "@/lib/faceAlign";

/**
 * ArcFace (insightface w600k_mbf) rodando no navegador via onnxruntime-web.
 *
 * Substitui o descritor do face-api, que confundia pessoas diferentes a
 * distâncias baixas nas fotos de grupo do álbum. O face-api segue cuidando da
 * detecção e dos 68 marcos — o alinhamento por 5 pontos é o que faz o embedding
 * valer alguma coisa.
 */
const MODEL_URL = `/${ARCFACE_MODEL_PATH}`;
const WASM_PATH = "/ort/";

let sessionPromise: Promise<InferenceSession> | null = null;
let alignCanvas: HTMLCanvasElement | null = null;

async function createSession() {
  // Entrada só-WASM: o bundle padrão puxa o runtime jsep/WebGPU, que sozinho
  // pesa 26MB. Aqui só o WASM simples é baixado.
  const ort = await import("onnxruntime-web/wasm");
  ort.env.wasm.wasmPaths = WASM_PATH;
  // Threads exigem cross-origin isolation (COOP/COEP); uma inferência de
  // 112x112 é barata o bastante pra não precisar disso.
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = "error";
  return ort.InferenceSession.create(MODEL_URL, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
}

export function loadArcFace() {
  if (!sessionPromise) sessionPromise = createSession();
  return sessionPromise;
}

/** Aquece modelo + runtime em background, enquanto o usuário tira a selfie. */
export function prefetchArcFace() {
  void loadArcFace().catch(() => {
    // sem rede agora; tenta de novo no uso real
  });
}

function scratch() {
  if (!alignCanvas) {
    alignCanvas = document.createElement("canvas");
    alignCanvas.width = ARCFACE_INPUT_SIZE;
    alignCanvas.height = ARCFACE_INPUT_SIZE;
  }
  return alignCanvas;
}

/**
 * Recorta o rosto na pose canônica do ArcFace e devolve os pixels.
 * `source` precisa ser a mesma imagem em que os marcos foram detectados.
 */
function alignFace(source: CanvasImageSource, landmarks: Point[]) {
  const five = fivePointsFrom68(landmarks);
  if (!five) return null;

  const canvas = scratch();
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!ctx) return null;

  const [a, b, c, d, e, f] = similarityTransform(five, ARCFACE_TEMPLATE);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ARCFACE_INPUT_SIZE, ARCFACE_INPUT_SIZE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(a, b, c, d, e, f);
  ctx.drawImage(source, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  return ctx.getImageData(0, 0, ARCFACE_INPUT_SIZE, ARCFACE_INPUT_SIZE).data;
}

/** Embedding de 512 dimensões, já normalizado. */
export async function embedFace(
  source: CanvasImageSource,
  landmarks: Point[],
): Promise<Float32Array | null> {
  const pixels = alignFace(source, landmarks);
  if (!pixels) return null;

  const ort = await import("onnxruntime-web/wasm");
  const session = await loadArcFace();
  const tensor = new ort.Tensor("float32", rgbaToNchw(pixels), [
    1,
    3,
    ARCFACE_INPUT_SIZE,
    ARCFACE_INPUT_SIZE,
  ]);
  const output = await session.run({ [session.inputNames[0]]: tensor });
  const raw = output[session.outputNames[0]].data as Float32Array;
  return l2normalize(Float32Array.from(raw));
}
