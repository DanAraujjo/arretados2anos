/**
 * Fotos em rajada.
 *
 * Boa parte do álbum é sequência de câmera rápida: 25 arquivos com o mesmo
 * segundo no nome, quadros praticamente idênticos. No vídeo isso aparece como
 * "a mesma foto de novo". Aqui a rajada vira uma foto só.
 *
 * Só o nome é usado — nada de baixar imagem nem comparar pixel.
 */

/** `00011876-PHOTO-2024-12-08-00-36-46.jpg` → epoch em segundos. */
function timestampFromName(name: string): number | null {
  const m = name.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, year, month, day, hour, minute, second] = m;
  const t = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return Number.isFinite(t) ? t / 1000 : null;
}

/** Fotos dentro dessa janela contam como a mesma cena. */
const BURST_WINDOW_SEC = 3;

/**
 * Mantém uma foto por rajada. `items` já deve vir na ordem de preferência
 * (melhor primeiro): dentro de cada rajada, a primeira da lista é a que fica.
 *
 * Foto sem data no nome passa direto — não dá pra saber se é rajada.
 */
export function dropBurstDuplicates<T>(
  items: T[],
  nameOf: (item: T) => string,
): T[] {
  const dated: Array<{ item: T; time: number; rank: number }> = [];
  const undated: Array<{ item: T; rank: number }> = [];

  items.forEach((item, rank) => {
    const time = timestampFromName(nameOf(item));
    if (time === null) undated.push({ item, rank });
    else dated.push({ item, time, rank });
  });

  // Agrupa por proximidade no tempo, guardando o melhor colocado de cada grupo.
  dated.sort((a, b) => a.time - b.time);
  const kept: Array<{ item: T; rank: number }> = [];
  let group: Array<{ item: T; time: number; rank: number }> = [];

  const flush = () => {
    if (group.length === 0) return;
    const best = group.reduce((a, b) => (a.rank <= b.rank ? a : b));
    kept.push({ item: best.item, rank: best.rank });
    group = [];
  };

  for (const entry of dated) {
    if (group.length > 0 && entry.time - group[0].time > BURST_WINDOW_SEC) flush();
    group.push(entry);
  }
  flush();

  // Volta pra ordem original de preferência.
  return [...kept, ...undated].sort((a, b) => a.rank - b.rank).map((e) => e.item);
}
