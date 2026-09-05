import type { DetectedFace } from "@/lib/face";
import { bestFaceMatch, distanceToScore, isMatch } from "@/lib/face";
import { FACE_CACHE_VERSION, cacheToFaces } from "@/lib/faceCache";
import { photosBaseUrl } from "@/lib/photos-url";
import type { FaceBox, MatchResult, PhotoItem } from "@/lib/types";

export type FaceIndexFile = {
  version: number;
  generatedAt?: string;
  photos: Record<
    string,
    Array<{
      descriptor: number[];
      box: FaceBox;
      confidence: number;
    }>
  >;
};

export type FaceIndex = Map<string, DetectedFace[]>;

let cachedIndex: { key: string; index: FaceIndex; source: string } | null = null;
let loading: Promise<{ index: FaceIndex; source: string } | null> | null = null;

function indexUrls() {
  const base = photosBaseUrl();
  // ?v= bust CDN/browser cache quando o índice muda (jsDelivr @main é agressivo)
  const q = `?v=${FACE_CACHE_VERSION}`;
  return [base ? `${base}/faces.json${q}` : null, `/photos/faces.json${q}`].filter(
    Boolean,
  ) as string[];
}

function parseIndex(data: FaceIndexFile): FaceIndex {
  const map: FaceIndex = new Map();
  for (const [photoId, faces] of Object.entries(data.photos ?? {})) {
    map.set(photoId, cacheToFaces(faces));
  }
  return map;
}

/** Baixa faces.json uma vez (CDN/local) e mantém em memória — scan vira só distância. */
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
          const res = await fetch(url, {
            headers: { Accept: "application/json" },
            cache: "no-cache",
          });
          if (!res.ok) continue;
          const data = (await res.json()) as FaceIndexFile;
          // Aceita índice atual ou o imediatamente anterior (CDN em propagação)
          if (
            !data?.photos ||
            (data.version !== FACE_CACHE_VERSION && data.version !== FACE_CACHE_VERSION - 1)
          ) {
            continue;
          }
          const index = parseIndex(data);
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

/**
 * Matching síncrono contra o índice — tipicamente <1s p/ ~900 fotos.
 * Não baixa imagens do álbum.
 */
export function matchQueryAgainstIndex(
  query: Float32Array,
  photos: PhotoItem[],
  index: FaceIndex,
  onProgress?: (done: number, total: number) => void,
): MatchResult[] {
  const found: MatchResult[] = [];
  const total = photos.length;
  const reportEvery = Math.max(1, Math.floor(total / 40));

  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i];
    const faces = index.get(photo.id);
    if (faces && faces.length > 0) {
      const best = bestFaceMatch(query, faces);
      if (
        best &&
        Number.isFinite(best.distance) &&
        isMatch(best.distance, best.face, best.secondDistance)
      ) {
        found.push({
          photo,
          distance: best.distance,
          score: distanceToScore(best.distance),
          face: best.face,
        });
      }
    }
    if (onProgress && (i % reportEvery === 0 || i === total - 1)) {
      onProgress(i + 1, total);
    }
  }

  found.sort((a, b) => a.distance - b.distance);
  return found;
}
