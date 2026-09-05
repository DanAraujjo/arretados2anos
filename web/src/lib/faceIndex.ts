import {
  FACE_CACHE_VERSION,
  cacheToFaces,
  putPhotoFacesBatch,
} from "@/lib/faceCache";
import { photosBaseUrl } from "@/lib/photos-url";

export type FaceIndexFile = {
  version: number;
  generatedAt?: string;
  photos: Record<
    string,
    Array<{
      descriptor: number[];
      box: {
        x: number;
        y: number;
        width: number;
        height: number;
        cx: number;
        cy: number;
      };
      confidence: number;
    }>
  >;
};

/** Baixa faces.json da CDN/local e hidrata o IndexedDB — scan vira só comparação. */
export async function hydrateFaceIndexFromCdn(): Promise<{
  loaded: number;
  source: string | null;
}> {
  const base = photosBaseUrl();
  const candidates = [
    base ? `${base}/faces.json` : null,
    "/photos/faces.json",
  ].filter(Boolean) as string[];

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "force-cache",
      });
      if (!res.ok) continue;
      const data = (await res.json()) as FaceIndexFile;
      if (!data?.photos || data.version !== FACE_CACHE_VERSION) continue;

      const entries = Object.entries(data.photos);
      const batch = 80;
      for (let i = 0; i < entries.length; i += batch) {
        const slice = entries.slice(i, i + batch);
        await putPhotoFacesBatch(
          slice.map(([photoId, faces]) => ({
            photoId,
            faces: cacheToFaces(faces),
          })),
        );
      }
      return { loaded: entries.length, source: url };
    } catch {
      // tenta próximo
    }
  }
  return { loaded: 0, source: null };
}
