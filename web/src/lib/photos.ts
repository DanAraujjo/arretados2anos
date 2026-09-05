import { createReadStream, existsSync } from "fs";
import { readdir } from "fs/promises";
import path from "path";
import type { PhotoItem } from "@/lib/types";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export function photosBaseUrl() {
  const raw = process.env.NEXT_PUBLIC_PHOTOS_BASE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/$/, "");
}

export function photoPublicUrl(name: string, base = photosBaseUrl()) {
  if (!base) return `/photos/${encodeURIComponent(name)}`;
  return `${base}/${encodeURIComponent(name)}`;
}

function localPhotosDir() {
  return path.join(process.cwd(), "public", "photos");
}

export function safePhotoName(name: string) {
  const base = path.basename(name);
  if (base !== name) return null;
  if (base.includes("..")) return null;
  if (!IMAGE_EXT.has(path.extname(base).toLowerCase())) return null;
  return base;
}

async function listLocalPhotos(): Promise<PhotoItem[]> {
  const dir = localPhotosDir();
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => IMAGE_EXT.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => ({
      id: name,
      name,
      src: photoPublicUrl(name, null),
    }));
}

type Manifest = {
  photos: Array<{ id?: string; name: string; src?: string }>;
};

async function listRemotePhotos(base: string): Promise<PhotoItem[]> {
  const manifestUrl = `${base}/manifest.json`;
  const res = await fetch(manifestUrl, {
    headers: { Accept: "application/json" },
    next: { revalidate: 60 },
  });
  if (!res.ok) {
    throw new Error(
      `Não achou manifest em ${manifestUrl} (${res.status}). Rode npm run upload:r2`,
    );
  }
  const data = (await res.json()) as Manifest;
  const names = (data.photos ?? [])
    .map((p) => safePhotoName(p.name || p.id || ""))
    .filter(Boolean) as string[];

  return [...new Set(names)]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => ({
      id: name,
      name,
      src: photoPublicUrl(name, base),
    }));
}

export async function loadPhotos(): Promise<{
  photos: PhotoItem[];
  hint: string | null;
  source: "r2" | "local";
}> {
  const base = photosBaseUrl();

  if (base) {
    try {
      const photos = await listRemotePhotos(base);
      return {
        photos,
        hint:
          photos.length === 0
            ? "Manifest R2 vazio — rode npm run upload:r2"
            : null,
        source: "r2",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Falha ao ler R2";
      return { photos: [], hint: message, source: "r2" };
    }
  }

  try {
    const photos = await listLocalPhotos();
    return {
      photos,
      hint:
        photos.length === 0
          ? "Coloque fotos em web/public/photos ou configure NEXT_PUBLIC_PHOTOS_BASE_URL"
          : null,
      source: "local",
    };
  } catch {
    return {
      photos: [],
      hint: "Crie web/public/photos ou configure R2 (veja README).",
      source: "local",
    };
  }
}

export function localPhotoPath(name: string) {
  const safe = safePhotoName(name);
  if (!safe) return null;
  const full = path.join(localPhotosDir(), safe);
  if (!existsSync(full)) return null;
  return full;
}

export function openLocalPhotoStream(name: string) {
  const full = localPhotoPath(name);
  if (!full) return null;
  return createReadStream(full);
}
