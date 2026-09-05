/** URLs públicas das fotos — seguro pra client e server (sem fs). */

export function photosBaseUrl() {
  const raw = process.env.NEXT_PUBLIC_PHOTOS_BASE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/$/, "");
}

export function photoPublicUrl(name: string, base = photosBaseUrl()) {
  if (!base) return `/photos/${encodeURIComponent(name)}`;
  return `${base}/${encodeURIComponent(name)}`;
}
