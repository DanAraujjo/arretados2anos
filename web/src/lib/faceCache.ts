import type { FaceBox, MatchResult, PhotoItem } from "@/lib/types";
import type { DetectedFace } from "@/lib/face";
import { MATCH_THRESHOLD } from "@/lib/face";

/** Subir quando mudar detecção/threshold — invalida o cache antigo. */
export const FACE_CACHE_VERSION = 6;

const DB_NAME = "arretados-face-cache";
const DB_VERSION = 1;
const STORE_FACES = "photo-faces";
const STORE_SESSION = "match-session";

type CachedFace = {
  descriptor: number[];
  box: FaceBox;
  confidence: number;
};

type PhotoFaceRecord = {
  photoId: string;
  version: number;
  faces: CachedFace[];
  updatedAt: number;
};

export type MatchSessionRecord = {
  id: "latest";
  version: number;
  albumKey: string;
  matches: MatchResult[];
  selectedIds: string[];
  selfieMime: string;
  selfieBuffer: ArrayBuffer;
  savedAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB indisponível"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FACES)) {
        db.createObjectStore(STORE_FACES, { keyPath: "photoId" });
      }
      if (!db.objectStoreNames.contains(STORE_SESSION)) {
        db.createObjectStore(STORE_SESSION, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Falha ao abrir cache"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Falha na transação"));
    tx.onabort = () => reject(tx.error ?? new Error("Transação abortada"));
  });
}

export function albumKey(photos: PhotoItem[]) {
  return `${FACE_CACHE_VERSION}|${MATCH_THRESHOLD}|${photos
    .map((p) => p.id)
    .sort()
    .join(",")}`;
}

export function facesToCache(faces: DetectedFace[]): CachedFace[] {
  return faces.map((f) => ({
    descriptor: Array.from(f.descriptor),
    box: f.box,
    confidence: f.confidence,
  }));
}

export function cacheToFaces(faces: CachedFace[]): DetectedFace[] {
  return faces.map((f) => ({
    descriptor: Float32Array.from(f.descriptor),
    box: f.box,
    confidence: f.confidence,
  }));
}

export async function getPhotoFaces(
  photoId: string,
): Promise<DetectedFace[] | null> {
  try {
    const db = await openDb();
    const record = await new Promise<PhotoFaceRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_FACES, "readonly");
      const req = tx.objectStore(STORE_FACES).get(photoId);
      req.onsuccess = () => resolve(req.result as PhotoFaceRecord | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!record || record.version !== FACE_CACHE_VERSION) return null;
    return cacheToFaces(record.faces);
  } catch {
    return null;
  }
}

export async function putPhotoFaces(photoId: string, faces: DetectedFace[]) {
  try {
    const db = await openDb();
    const record: PhotoFaceRecord = {
      photoId,
      version: FACE_CACHE_VERSION,
      faces: facesToCache(faces),
      updatedAt: Date.now(),
    };
    const tx = db.transaction(STORE_FACES, "readwrite");
    tx.objectStore(STORE_FACES).put(record);
    await txDone(tx);
    db.close();
  } catch {
    // cache is best-effort
  }
}

/** Grava várias fotos numa única transação (hidratar faces.json). */
export async function putPhotoFacesBatch(
  entries: Array<{ photoId: string; faces: DetectedFace[] }>,
) {
  if (entries.length === 0) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_FACES, "readwrite");
    const store = tx.objectStore(STORE_FACES);
    const now = Date.now();
    for (const { photoId, faces } of entries) {
      store.put({
        photoId,
        version: FACE_CACHE_VERSION,
        faces: facesToCache(faces),
        updatedAt: now,
      } satisfies PhotoFaceRecord);
    }
    await txDone(tx);
    db.close();
  } catch {
    // best-effort
  }
}

export async function prunePhotoFaces(validIds: Set<string>) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_FACES, "readwrite");
    const store = tx.objectStore(STORE_FACES);
    const all = await new Promise<PhotoFaceRecord[]>((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result as PhotoFaceRecord[]) ?? []);
      req.onerror = () => reject(req.error);
    });
    for (const row of all) {
      if (!validIds.has(row.photoId) || row.version !== FACE_CACHE_VERSION) {
        store.delete(row.photoId);
      }
    }
    await txDone(tx);
    db.close();
  } catch {
    // ignore
  }
}

export async function saveMatchSession(input: {
  albumKey: string;
  matches: MatchResult[];
  selectedIds: string[];
  selfieBlob: Blob;
}) {
  try {
    const selfieBuffer = await input.selfieBlob.arrayBuffer();
    const record: MatchSessionRecord = {
      id: "latest",
      version: FACE_CACHE_VERSION,
      albumKey: input.albumKey,
      matches: input.matches,
      selectedIds: input.selectedIds,
      selfieMime: input.selfieBlob.type || "image/jpeg",
      selfieBuffer,
      savedAt: Date.now(),
    };
    const db = await openDb();
    const tx = db.transaction(STORE_SESSION, "readwrite");
    tx.objectStore(STORE_SESSION).put(record);
    await txDone(tx);
    db.close();
  } catch {
    // ignore
  }
}

export async function peekMatchSession(
  expectedAlbumKey: string,
): Promise<{ count: number; savedAt: number } | null> {
  try {
    const db = await openDb();
    const record = await new Promise<MatchSessionRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_SESSION, "readonly");
      const req = tx.objectStore(STORE_SESSION).get("latest");
      req.onsuccess = () => resolve(req.result as MatchSessionRecord | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!record) return null;
    if (record.version !== FACE_CACHE_VERSION) return null;
    if (record.albumKey !== expectedAlbumKey) return null;
    if (!record.matches?.length) return null;
    return { count: record.matches.length, savedAt: record.savedAt };
  } catch {
    return null;
  }
}

export async function loadMatchSession(
  expectedAlbumKey: string,
): Promise<{
  matches: MatchResult[];
  selectedIds: string[];
  selfieUrl: string;
  savedAt: number;
} | null> {
  try {
    const db = await openDb();
    const record = await new Promise<MatchSessionRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_SESSION, "readonly");
      const req = tx.objectStore(STORE_SESSION).get("latest");
      req.onsuccess = () => resolve(req.result as MatchSessionRecord | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!record) return null;
    if (record.version !== FACE_CACHE_VERSION) return null;
    if (record.albumKey !== expectedAlbumKey) return null;
    if (!record.matches?.length) return null;

    const blob = new Blob([new Uint8Array(record.selfieBuffer)], {
      type: record.selfieMime,
    });
    const selfieUrl = URL.createObjectURL(blob);
    return {
      matches: record.matches,
      selectedIds: record.selectedIds,
      selfieUrl,
      savedAt: record.savedAt,
    };
  } catch {
    return null;
  }
}

export async function clearMatchSession() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_SESSION, "readwrite");
    tx.objectStore(STORE_SESSION).delete("latest");
    await txDone(tx);
    db.close();
  } catch {
    // ignore
  }
}

export async function blobFromObjectUrl(url: string): Promise<Blob | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}
