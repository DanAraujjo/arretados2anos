import { NextResponse } from "next/server";
import { loadPhotos } from "@/lib/photos";

export const dynamic = "force-dynamic";

export async function GET() {
  const { photos, hint, source } = await loadPhotos();

  return NextResponse.json(
    {
      count: photos.length,
      photos,
      source,
      hint,
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
