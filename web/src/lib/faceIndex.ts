import type { DetectedFace, FaceQuery } from "@/lib/face";
import {
  bestFaceMatch,
  distanceToScore,
  fuseEmbeddings,
  isMatch,
  queryDistance,
} from "@/lib/face";
import { FACE_CACHE_VERSION } from "@/lib/faceCache";
import { photosBaseUrl } from "@/lib/photos-url";
import type { MatchResult, PhotoItem } from "@/lib/types";

export type FaceIndex = Map<string, DetectedFace[]>;

let cachedIndex: { key: string; index: FaceIndex; source: string } | null = null;
let loading: Promise<{ index: FaceIndex; source: string } | null> | null = null;

function indexUrls() {
  const base = photosBaseUrl();
  // ?v= evita cache stale no browser
  const q = `?v=${FACE_CACHE_VERSION}`;
  // Site (Netlify, atualiza a cada deploy) antes do CDN das fotos, que com
  // jsDelivr @main pode grudar numa versão velha.
  return [`/photos/faces.bin${q}`, base ? `${base}/faces.bin${q}` : null].filter(
    Boolean,
  ) as string[];
}

const BIN_MAGIC = 0x49465241; // "ARFI" em little-endian
const BIN_HEADER_SIZE = 24;

const align4 = (n: number) => (n + 3) & ~3;

/**
 * Lê o índice binário gerado por `npm run faces:index`.
 *
 * O arquivo é organizado em blocos por tipo e alinhado a 4 bytes, então a
 * leitura é só criar views sobre o ArrayBuffer — nada de laço de parsing. Os
 * descritores vêm quantizados em int8 (erro médio de 0.001 na distância, ~7×
 * menor que JSON) e são desquantizados de uma vez num Float32Array só.
 */
function parseBinaryIndex(buffer: ArrayBuffer): FaceIndex | null {
  if (buffer.byteLength < BIN_HEADER_SIZE) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== BIN_MAGIC) return null;

  // Versão exata: um índice antigo traz embedding de outro modelo, e comparar
  // vetores de modelos diferentes devolve lixo com cara de resultado.
  if (view.getUint16(4, true) !== FACE_CACHE_VERSION) return null;

  const dims = view.getUint16(6, true);
  const photoCount = view.getUint32(8, true);
  const faceCount = view.getUint32(12, true);
  const scale = view.getFloat32(16, true);
  const namesBytes = view.getUint32(20, true);

  const countsOffset = align4(BIN_HEADER_SIZE + namesBytes);
  const descOffset = align4(countsOffset + photoCount * 2);
  const boxOffset = align4(descOffset + faceCount * dims);
  const confOffset = align4(boxOffset + faceCount * 8);
  if (confOffset + faceCount > buffer.byteLength) return null;

  const names = new TextDecoder()
    .decode(new Uint8Array(buffer, BIN_HEADER_SIZE, namesBytes))
    .split("\n");
  if (names.length !== photoCount) return null;

  const counts = new Uint16Array(buffer, countsOffset, photoCount);
  const quantized = new Int8Array(buffer, descOffset, faceCount * dims);
  const boxes = new Uint16Array(buffer, boxOffset, faceCount * 4);
  const confidences = new Uint8Array(buffer, confOffset, faceCount);

  const descriptors = new Float32Array(faceCount * dims);
  const step = scale / 127;
  for (let i = 0; i < descriptors.length; i += 1) {
    descriptors[i] = quantized[i] * step;
  }

  const map: FaceIndex = new Map();
  let face = 0;
  for (let p = 0; p < photoCount; p += 1) {
    const faces: DetectedFace[] = [];
    for (let k = 0; k < counts[p]; k += 1) {
      const b = face * 4;
      const x = boxes[b] / 65535;
      const y = boxes[b + 1] / 65535;
      const width = boxes[b + 2] / 65535;
      const height = boxes[b + 3] / 65535;
      faces.push({
        descriptor: descriptors.subarray(face * dims, (face + 1) * dims),
        box: { x, y, width, height, cx: x + width / 2, cy: y + height / 2 },
        confidence: confidences[face] / 255,
      });
      face += 1;
    }
    map.set(names[p], faces);
  }

  return map;
}

/** Baixa faces.bin uma vez (site/CDN) e mantém em memória — scan vira só distância. */
export async function loadFaceIndex(): Promise<{
  index: FaceIndex;
  source: string;
  count: number;
} | null> {
  const key = indexUrls().join("|");
  if (cachedIndex?.key === key) {
    return {
      index: cachedIndex.index,
      source: cachedIndex.source,
      count: cachedIndex.index.size,
    };
  }

  if (!loading) {
    loading = (async () => {
      for (const url of indexUrls()) {
        try {
          const res = await fetch(url, { cache: "no-cache" });
          if (!res.ok) continue;

          const index = parseBinaryIndex(await res.arrayBuffer());
          if (!index || index.size === 0) continue;

          cachedIndex = { key, index, source: url };
          return { index, source: url };
        } catch {
          // próximo
        }
      }
      return null;
    })().finally(() => {
      loading = null;
    });
  }

  const result = await loading;
  if (!result) return null;
  return { index: result.index, source: result.source, count: result.index.size };
}

/** Pré-aquece o índice em background (hero). */
export function prefetchFaceIndex() {
  void loadFaceIndex();
}

type ScanHit = MatchResult & { descriptor: Float32Array };

/**
 * Uma passada de distância pura contra o índice — sem baixar imagem nenhuma.
 * Tipicamente <1s pra ~900 fotos.
 */
function scanIndex(
  query: FaceQuery,
  photos: PhotoItem[],
  index: FaceIndex,
  onProgress?: (ratio: number) => void,
): ScanHit[] {
  const found: ScanHit[] = [];
  const total = photos.length;
  const reportEvery = Math.max(1, Math.floor(total / 40));

  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i];
    const faces = index.get(photo.id);
    if (faces && faces.length > 0) {
      const best = bestFaceMatch(query, faces);
      if (best && Number.isFinite(best.distance) && isMatch(best.distance, best.face)) {
        found.push({
          photo,
          distance: best.distance,
          score: distanceToScore(best.distance),
          face: best.face,
          descriptor: best.descriptor,
        });
      }
    }
    if (onProgress && (i % reportEvery === 0 || i === total - 1)) {
      onProgress((i + 1) / total);
    }
  }

  return found;
}

/** Distância abaixo da qual um match serve de semente pra expansão. */
const SEED_DISTANCE = 0.9;
const MAX_SEEDS = 8;
/**
 * Teto de quanto a expansão pode se afastar da selfie original.
 *
 * Sem freio, a query realimentada anda de rosto em rosto e uma hora chega em
 * outra pessoa. Conferindo os recortes no álbum, a mesma pessoa aparece até
 * ~1.11 e a partir de ~1.18 já é gente diferente — 1.12 fica do lado seguro.
 */
const EXPANSION_MAX_DISTANCE = 1.12;

/**
 * Expansão de consulta (pseudo-relevance feedback).
 *
 * A selfie é sempre frontal e bem iluminada; as fotos do álbum não. Os matches
 * mais confiantes da 1ª passada são a mesma pessoa **em condição de álbum** —
 * realimentar esses descritores na query alcança as fotos de perfil, de longe e
 * mal iluminadas que a selfie sozinha nunca pegaria.
 *
 * Só entram sementes bem abaixo do threshold e mutuamente coerentes
 * (`fuseDescriptors` descarta quem destoa), pra não amplificar falso positivo.
 */
function expandQuery(query: FaceQuery, hits: ScanHit[]): FaceQuery | null {
  const seeds = hits
    .filter((hit) => hit.distance <= SEED_DISTANCE)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_SEEDS)
    .map((hit) => hit.descriptor);

  if (seeds.length < 2) return null;

  const fused = fuseEmbeddings(seeds, 0.9);
  if (!fused) return null;

  // Descritor novo demais parecido com o que já existe não acrescenta nada.
  if (queryDistance(query, fused) < 0.25) return null;

  return {
    descriptors: [...query.descriptors, fused],
    frames: query.frames,
    expanded: seeds.length,
  };
}

export type MatchRun = {
  matches: MatchResult[];
  /** Query final (já expandida) — útil pra refinar depois com confirmação. */
  query: FaceQuery;
};

/**
 * Busca completa contra o índice: uma passada, expansão de consulta, segunda
 * passada. A 2ª só roda se a expansão trouxe descritor novo.
 */
export function matchQueryAgainstIndex(
  query: FaceQuery,
  photos: PhotoItem[],
  index: FaceIndex,
  onProgress?: (ratio: number) => void,
): MatchRun {
  // Progresso monotônico: 1ª passada ocupa 55%, expansão o resto.
  const first = scanIndex(query, photos, index, (r) => onProgress?.(r * 0.55));
  const expanded = expandQuery(query, first);

  const hits = expanded
    ? scanIndex(expanded, photos, index, (r) => onProgress?.(0.55 + r * 0.45))
    : first;
  onProgress?.(1);

  /**
   * A distância mostrada é sempre contra a **selfie**, não contra a query
   * expandida: é isso que o usuário entende por "parece comigo", e mantém as
   * fotos mais certeiras no topo da lista.
   */
  const matches: MatchResult[] = [];
  for (const hit of hits) {
    const distance = expanded ? queryDistance(query, hit.descriptor) : hit.distance;
    if (expanded && distance > EXPANSION_MAX_DISTANCE) continue;
    matches.push({
      photo: hit.photo,
      distance,
      score: distanceToScore(distance),
      face: hit.face,
    });
  }
  matches.sort((a, b) => a.distance - b.distance);

  return { matches, query: expanded ?? query };
}
