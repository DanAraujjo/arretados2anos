"use client";

import dynamic from "next/dynamic";
import type { PhotoItem } from "@/lib/types";

const Experience = dynamic(
  () => import("@/components/Experience").then((m) => m.Experience),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-screen items-center justify-center bg-[#071525] text-[#e8d5a8]">
        <p className="text-sm uppercase tracking-[0.3em]">Carregando Arretados...</p>
      </div>
    ),
  },
);

export function HomeClient({
  photos,
  hint,
}: {
  photos: PhotoItem[];
  hint: string | null;
}) {
  return <Experience initialPhotos={photos} photoHint={hint} />;
}
