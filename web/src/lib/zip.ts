import { downloadZip } from "client-zip";
import { mapPool } from "@/lib/pool";
import type { PhotoItem } from "@/lib/types";

/**
 * ZIP montado no navegador.
 *
 * A rota serverless baixava as fotos do CDN **em série** dentro da função: 80
 * fotos não cabem no limite de tempo da Netlify, então o download simplesmente
 * falhava em produção. Aqui o browser baixa em paralelo (as fotos já estão no
 * cache dele, foram exibidas na tela) e compacta localmente — sem servidor no
 * caminho e sem teto de quantidade.
 *
 * `client-zip` grava em modo store (sem deflate), que é o certo aqui: JPEG já
 * é comprimido, então deflate só gastaria CPU sem reduzir nada.
 */
export async function zipPhotos(
  photos: PhotoItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const files = await mapPool(
    photos,
    6,
    async (photo) => {
      const res = await fetch(photo.src, { mode: "cors", cache: "force-cache" });
      if (!res.ok) throw new Error(`Falha ao baixar ${photo.name} (${res.status})`);
      return { name: photo.name, input: await res.blob() };
    },
    onProgress,
  );

  return downloadZip(files).blob();
}
