/**
 * Alinhamento de rosto para o ArcFace.
 *
 * O modelo espera o rosto recortado em 112x112 **na pose canônica** do
 * insightface: olhos, nariz e cantos da boca em posições fixas. Sem esse
 * alinhamento o embedding degrada muito — foi por isso que o descritor antigo
 * confundia pessoas em foto de grupo.
 *
 * Módulo puro (sem DOM, sem Node): usado tanto no navegador quanto no script
 * que gera o índice, pra os dois lados produzirem exatamente o mesmo vetor.
 */

export type Point = { x: number; y: number };

/** Gabarito de 5 pontos do insightface para entrada 112x112. */
export const ARCFACE_TEMPLATE: Point[] = [
  { x: 38.2946, y: 51.6963 }, // olho esquerdo (na imagem)
  { x: 73.5318, y: 51.5014 }, // olho direito
  { x: 56.0252, y: 71.7366 }, // ponta do nariz
  { x: 41.5493, y: 92.3655 }, // canto esquerdo da boca
  { x: 70.7299, y: 92.2041 }, // canto direito da boca
];

export const ARCFACE_INPUT_SIZE = 112;

/**
 * Caminho do modelo, compartilhado pelo navegador e pelo script do índice.
 *
 * Os dois **têm** que usar o mesmo arquivo: o int8 não é numericamente igual ao
 * fp32 (deriva ~0.26 no mesmo rosto), então misturar os dois lados espalha erro
 * silencioso pelos matches.
 */
export const ARCFACE_MODEL_PATH = "models/arcface/w600k_mbf.int8.onnx";

function centroid(points: Point[], from: number, to: number): Point {
  let x = 0;
  let y = 0;
  for (let i = from; i <= to; i += 1) {
    x += points[i].x;
    y += points[i].y;
  }
  const n = to - from + 1;
  return { x: x / n, y: y / n };
}

/** Reduz os 68 marcos do face-api aos 5 pontos que o ArcFace usa. */
export function fivePointsFrom68(landmarks: Point[]): Point[] | null {
  if (landmarks.length < 68) return null;
  return [
    centroid(landmarks, 36, 41),
    centroid(landmarks, 42, 47),
    landmarks[30],
    landmarks[48],
    landmarks[54],
  ];
}

/** Matriz de transformação do canvas: setTransform(a, b, c, d, e, f). */
export type Transform = [number, number, number, number, number, number];

/**
 * Semelhança 2D (rotação + escala uniforme + translação) por mínimos quadrados,
 * sem reflexão. Forma fechada — é o mesmo resultado do `SimilarityTransform`
 * do skimage que o insightface usa.
 */
export function similarityTransform(from: Point[], to: Point[]): Transform {
  const n = Math.min(from.length, to.length);
  let fx = 0;
  let fy = 0;
  let tx = 0;
  let ty = 0;
  for (let i = 0; i < n; i += 1) {
    fx += from[i].x;
    fy += from[i].y;
    tx += to[i].x;
    ty += to[i].y;
  }
  fx /= n;
  fy /= n;
  tx /= n;
  ty /= n;

  let sumDot = 0;
  let sumCross = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = from[i].x - fx;
    const dy = from[i].y - fy;
    const du = to[i].x - tx;
    const dv = to[i].y - ty;
    sumDot += dx * du + dy * dv;
    sumCross += dx * dv - dy * du;
    sumSq += dx * dx + dy * dy;
  }
  if (sumSq === 0) return [1, 0, 0, 1, 0, 0];

  const a = sumDot / sumSq;
  const b = sumCross / sumSq;
  return [a, b, -b, a, tx - (a * fx - b * fy), ty - (b * fx + a * fy)];
}

/**
 * RGBA do recorte alinhado → tensor NCHW do modelo.
 * Normalização do insightface: RGB, (pixel - 127.5) / 127.5.
 */
export function rgbaToNchw(
  rgba: Uint8ClampedArray | Uint8Array,
  size = ARCFACE_INPUT_SIZE,
): Float32Array {
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    const p = i * 4;
    out[i] = (rgba[p] - 127.5) / 127.5;
    out[plane + i] = (rgba[p + 1] - 127.5) / 127.5;
    out[plane * 2 + i] = (rgba[p + 2] - 127.5) / 127.5;
  }
  return out;
}

/**
 * Embeddings do ArcFace se comparam por ângulo, então normalizar pra norma 1 é
 * parte do modelo — não um detalhe. Depois disso, distância euclidiana e
 * similaridade de cosseno viram a mesma medida.
 */
export function l2normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}

/** Cosseno entre vetores já normalizados. 1 = idêntico. */
export function cosineSimilarity(a: Float32Array, b: Float32Array) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}
