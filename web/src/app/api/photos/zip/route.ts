import { PassThrough, Readable } from "stream";
import { ZipArchive } from "archiver";
import {
  loadPhotos,
  localPhotoPath,
  openLocalPhotoStream,
  photoPublicUrl,
  photosBaseUrl,
  safePhotoName,
} from "@/lib/photos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
    const base = photosBaseUrl();
    const catalog = await loadPhotos();

    let names: string[];
    if (Array.isArray(body.ids) && body.ids.length > 0) {
      const unique = [...new Set(body.ids.map(safePhotoName).filter(Boolean) as string[])];
      const allowed = new Set(catalog.photos.map((p) => p.id));
      names = unique.filter((name) => allowed.has(name));
    } else {
      names = catalog.photos.map((p) => p.id);
    }

    if (names.length === 0) {
      return Response.json({ error: "Nenhuma foto para baixar" }, { status: 400 });
    }

    // Cap ZIP size on serverless to avoid timeouts
    if (names.length > 80) {
      return Response.json(
        { error: "Selecione no máximo 80 fotos por ZIP" },
        { status: 400 },
      );
    }

    const archive = new ZipArchive({ zlib: { level: 5 } });
    const passthrough = new PassThrough();
    archive.pipe(passthrough);

    for (const name of names) {
      if (base) {
        const url = photoPublicUrl(name, base);
        const res = await fetch(url);
        if (!res.ok || !res.body) {
          throw new Error(`Falha ao baixar ${name} do R2 (${res.status})`);
        }
        archive.append(Readable.fromWeb(res.body as import("stream/web").ReadableStream), {
          name,
        });
      } else {
        const stream = openLocalPhotoStream(name);
        if (!stream || !localPhotoPath(name)) continue;
        archive.append(stream, { name });
      }
    }

    void archive.finalize();
    const webStream = Readable.toWeb(passthrough) as ReadableStream;

    return new Response(webStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="arretados-fotos.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Falha ao gerar ZIP";
    return Response.json({ error: message }, { status: 500 });
  }
}
