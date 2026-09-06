"use client";

import { useEffect, useRef, useState } from "react";
import {
  bestFaceMatch,
  buildFaceQuery,
  detectFaceScore,
  distanceToScore,
  getAlbumFaces,
  isMatch,
  loadFaceModels,
  loadImage,
} from "@/lib/face";
import {
  albumKey,
  blobFromObjectUrl,
  getPhotoFaces,
  loadMatchSession,
  peekMatchSession,
  prunePhotoFaces,
  putPhotoFaces,
  saveMatchSession,
} from "@/lib/faceCache";
import {
  loadFaceIndex,
  matchQueryAgainstIndex,
  prefetchFaceIndex,
} from "@/lib/faceIndex";
import { loadArcFace, onArcFaceProgress } from "@/lib/arcface";
import { dropBurstDuplicates } from "@/lib/bursts";
import { unlockAudio } from "@/lib/encode";
import { mapPool } from "@/lib/pool";
import { zipPhotos } from "@/lib/zip";
import type { AppStep, MatchResult, PhotoItem } from "@/lib/types";
import {
  MAX_VIDEO_SEC,
  prepareClips,
  releaseClips,
  renderAnniversaryVideo,
} from "@/lib/video";

type Props = {
  initialPhotos: PhotoItem[];
  photoHint: string | null;
};

/** Frames da câmera fundidos numa query — cobre piscada, contraluz e ângulo. */
const SELFIE_FRAMES = 4;

/** Cópia leve do frame atual do vídeo (o detector reduz pra 416 de qualquer jeito). */
function grabFrame(video: HTMLVideoElement, maxSide = 640): HTMLCanvasElement {
  const vw = video.videoWidth || 720;
  const vh = video.videoHeight || 720;
  const scale = Math.min(1, maxSide / Math.max(vw, vh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(vw * scale));
  canvas.height = Math.max(1, Math.round(vh * scale));
  const ctx = canvas.getContext("2d", { alpha: false });
  if (ctx) ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function Experience({ initialPhotos, photoHint }: Props) {
  const [step, setStep] = useState<AppStep>("hero");
  const [photos, setPhotos] = useState(initialPhotos);
  const [hint, setHint] = useState(photoHint);
  const [photosLoading, setPhotosLoading] = useState(true);
  const [modelsReady, setModelsReady] = useState(false);
  const [selfieUrl, setSelfieUrl] = useState<string | null>(null);
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanLabel, setScanLabel] = useState("Preparando...");
  const [renderProgress, setRenderProgress] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoExt, setVideoExt] = useState("mp4");
  const [canShareVideo, setCanShareVideo] = useState(false);
  const [videoInfo, setVideoInfo] = useState("");
  const [sharing, setSharing] = useState(false);
  const videoFileRef = useRef<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [captureHint, setCaptureHint] = useState("Posicione o rosto");
  const [faceLock, setFaceLock] = useState(0);
  const [autoCapture, setAutoCapture] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [zipLabel, setZipLabel] = useState("");
  const [renderLabel, setRenderLabel] = useState("Montando o vídeo");
  const [savedSession, setSavedSession] = useState<{
    count: number;
    savedAt: number;
  } | null>(null);
  const [cacheHits, setCacheHits] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const capturingRef = useRef(false);
  /** Frames bons da câmera — fundidos num descritor só, bem mais estável. */
  const selfieFramesRef = useRef<HTMLCanvasElement[]>([]);
  const captureRef = useRef<() => void>(() => {});
  const selfieUrlRef = useRef<string | null>(null);
  const faceHitsRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function refreshPhotos() {
      try {
        const res = await fetch(`/api/photos?t=${Date.now()}`, { cache: "no-store" });
        const data = (await res.json()) as {
          photos: PhotoItem[];
          hint: string | null;
          count: number;
        };
        if (cancelled) return;
        const list = data.photos ?? [];
        setPhotos(list);
        setHint(data.hint ?? null);

        void prunePhotoFaces(new Set(list.map((p) => p.id)));
        const key = albumKey(list);
        const session = await peekMatchSession(key);
        if (!cancelled) setSavedSession(session);

        // Pré-baixa faces.json enquanto o usuário tira a selfie
        prefetchFaceIndex();
      } catch {
        if (!cancelled) setHint("Não consegui listar as fotos do álbum.");
      } finally {
        if (!cancelled) setPhotosLoading(false);
      }
    }

    void refreshPhotos();
    loadFaceModels()
      .then(() => {
        if (cancelled) return;
        setModelsReady(true);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const detail = err instanceof Error ? err.message : String(err);
        setError(`Não foi possível carregar o modelo de reconhecimento facial. ${detail}`);
      });

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (selfieUrlRef.current) URL.revokeObjectURL(selfieUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (step !== "capture" || !cameraOn || !modelsReady || !autoCapture) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    let detecting = false;

    const tick = async () => {
      if (cancelled || capturingRef.current) return;
      const video = videoRef.current;
      if (!video || video.readyState < 2) {
        timer = setTimeout(() => void tick(), 250);
        return;
      }
      // Detecção no celular passa de 300ms; sem essa trava as chamadas
      // empilhavam e a câmera engasgava logo na primeira captura.
      if (detecting) {
        timer = setTimeout(() => void tick(), 120);
        return;
      }
      detecting = true;

      try {
        const score = await detectFaceScore(video);
        if (cancelled || capturingRef.current) return;

        if (score >= 0.6) {
          faceHitsRef.current += 1;
          if (selfieFramesRef.current.length < SELFIE_FRAMES) {
            selfieFramesRef.current.push(grabFrame(video));
          }
          const progress = Math.min(1, faceHitsRef.current / SELFIE_FRAMES);
          setFaceLock(progress);
          setCaptureHint(
            progress >= 1 ? "Capturando..." : "Rosto ok — segure um instante",
          );
          if (faceHitsRef.current >= SELFIE_FRAMES) {
            setAutoCapture(false);
            captureRef.current();
            return;
          }
        } else {
          faceHitsRef.current = 0;
          selfieFramesRef.current = [];
          setFaceLock(0);
          setCaptureHint("Olhe pra câmera");
        }
      } catch {
        // ignore transient detector errors
      } finally {
        detecting = false;
      }

      timer = setTimeout(() => void tick(), 220);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [step, cameraOn, modelsReady, autoCapture]);

  async function runMatch(url: string, frames: HTMLCanvasElement[] = []) {
    setError(null);
    setStep("scanning");
    setScanProgress(0);
    setMatches([]);
    setCacheHits(0);
    const started = performance.now();

    try {
      if (photos.length === 0) {
        throw new Error(
          hint ??
            "Nenhuma foto no projeto ainda. Configure R2 ou coloque imagens em web/public/photos.",
        );
      }

      setScanLabel("Carregando reconhecimento...");
      setScanProgress(0.05);

      // O modelo tem 3.5MB e o runtime 13MB: sem barra andando isso parecia
      // travamento logo depois de detectar o rosto.
      const stopWatching = onArcFaceProgress((ratio) => {
        setScanProgress(0.05 + ratio * 0.1);
        if (ratio < 1) setScanLabel(`Carregando reconhecimento · ${Math.round(ratio * 100)}%`);
      });

      // Paraleliza selfie + índice + modelo. O ArcFace tem ~12MB: no 4G isso
      // demora, e sem rótulo próprio parecia que o app tinha travado.
      let selfie: HTMLImageElement;
      let faceIndex: Awaited<ReturnType<typeof loadFaceIndex>>;
      try {
        [selfie, faceIndex] = await Promise.all([
          loadImage(url),
          loadFaceIndex(),
          loadArcFace(),
        ]);
      } finally {
        stopWatching();
      }
      setScanProgress(0.15);
      setScanLabel("Lendo seu rosto...");

      // Vários frames + versão espelhada = descritor bem mais estável
      const query = await buildFaceQuery(frames.length > 0 ? frames : [selfie]);
      if (!query) {
        throw new Error("Não achei um rosto nítido na selfie. Tente de novo com mais luz.");
      }
      setScanProgress(0.25);

      let found: MatchResult[] = [];
      let hits = 0;

      if (faceIndex && faceIndex.count > 0) {
        // Caminho rápido online: só compara vetores (~1s), sem baixar 400MB
        setScanLabel(`Comparando · ${faceIndex.count} fotos`);
        const run = matchQueryAgainstIndex(
          query,
          photos,
          faceIndex.index,
          (ratio) => setScanProgress(0.25 + ratio * 0.7),
        );
        found = run.matches;
        if (run.query.expanded > 0) {
          setScanLabel(`Refinado com ${run.query.expanded} fotos suas`);
        }
        hits = faceIndex.count;
        setCacheHits(hits);
      } else {
        // Fallback local (sem faces.json): paralelo, mas bem mais lento
        setScanLabel("Índice ausente · analisando fotos...");
        const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
        const concurrency = Math.min(6, Math.max(3, Math.floor(cores / 2)));

        const rows = await mapPool(
          photos,
          concurrency,
          async (photo) => {
            try {
              let faces = await getPhotoFaces(photo.id);
              if (faces) {
                hits += 1;
                setCacheHits(hits);
              } else {
                const img = await loadImage(photo.src);
                faces = await getAlbumFaces(img);
                await putPhotoFaces(photo.id, faces);
              }
              if (faces.length === 0) return null;
              const best = bestFaceMatch(query, faces);
              if (best && Number.isFinite(best.distance) && isMatch(best.distance, best.face)) {
                return {
                  photo,
                  distance: best.distance,
                  score: distanceToScore(best.distance),
                  face: best.face,
                } satisfies MatchResult;
              }
              return null;
            } catch {
              return null;
            }
          },
          (done, total) => {
            setScanProgress(0.25 + (done / total) * 0.7);
            setScanLabel(`Analisando · ${done}/${total}`);
          },
        );
        found = rows.filter((row): row is MatchResult => row !== null);
        found.sort((a, b) => a.distance - b.distance);
      }

      setScanProgress(0.98);
      const elapsed = ((performance.now() - started) / 1000).toFixed(1);
      setScanLabel(`Pronto em ${elapsed}s`);

      const nextSelected = found.slice(0, 24).map((m) => m.photo.id);
      setMatches(found);
      setSelectedIds(nextSelected);
      setCacheHits(hits);

      const selfieBlob = await blobFromObjectUrl(url);
      if (selfieBlob) {
        await saveMatchSession({
          albumKey: albumKey(photos),
          matches: found,
          selectedIds: nextSelected,
          selfieBlob,
        });
        setSavedSession({ count: found.length, savedAt: Date.now() });
      }

      setStep("results");
    } catch (err) {
      capturingRef.current = false;
      setAutoCapture(false);
      stopCamera();
      setError(err instanceof Error ? err.message : "Erro no reconhecimento");
      setStep("capture");
      setCaptureHint("Toque em tentar de novo");
      setFaceLock(0);
    }
  }

  async function startCamera() {
    setError(null);
    capturingRef.current = false;
    faceHitsRef.current = 0;
    selfieFramesRef.current = [];
    setFaceLock(0);
    setCaptureHint("Olhe pra câmera");
    setAutoCapture(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
    } catch {
      setAutoCapture(false);
      setError("Permissão da câmera negada. Você pode enviar uma selfie.");
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
    setAutoCapture(false);
  }

  function captureFromCamera() {
    if (capturingRef.current) return;
    capturingRef.current = true;
    setAutoCapture(false);

    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) {
      capturingRef.current = false;
      return;
    }
    canvas.width = video.videoWidth || 720;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      capturingRef.current = false;
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          capturingRef.current = false;
          return;
        }
        if (selfieUrlRef.current) URL.revokeObjectURL(selfieUrlRef.current);
        const url = URL.createObjectURL(blob);
        selfieUrlRef.current = url;
        setSelfieUrl(url);
        const frames = selfieFramesRef.current.slice();
        stopCamera();
        void runMatch(url, frames);
      },
      "image/jpeg",
      0.92,
    );
  }

  // O loop de auto-captura roda num efeito declarado antes desta função.
  useEffect(() => {
    captureRef.current = captureFromCamera;
  });

  function onFile(file: File | undefined) {
    if (!file) return;
    capturingRef.current = true;
    selfieFramesRef.current = [];
    setAutoCapture(false);
    if (selfieUrlRef.current) URL.revokeObjectURL(selfieUrlRef.current);
    const url = URL.createObjectURL(file);
    selfieUrlRef.current = url;
    setSelfieUrl(url);
    stopCamera();
    void runMatch(url);
  }

  /** Abre a folha nativa de compartilhamento com o MP4 (Instagram, WhatsApp...). */
  async function shareVideo() {
    const file = videoFileRef.current;
    if (!file) return;
    setSharing(true);
    try {
      await navigator.share({
        files: [file],
        title: "Arretados 2 anos",
        text: "Minha retrospectiva dos Arretados 🥳",
      });
    } catch (err) {
      // Cancelar no menu do sistema não é erro.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError("Não deu pra compartilhar. Use o botão Baixar.");
    } finally {
      setSharing(false);
    }
  }

  async function restoreSavedSession() {
    setError(null);
    try {
      const session = await loadMatchSession(albumKey(photos));
      if (!session) {
        setSavedSession(null);
        setError("Não achei busca salva neste navegador.");
        return;
      }
      if (selfieUrlRef.current) URL.revokeObjectURL(selfieUrlRef.current);
      selfieUrlRef.current = session.selfieUrl;
      setSelfieUrl(session.selfieUrl);
      setMatches(session.matches);
      setSelectedIds(
        session.selectedIds.length > 0
          ? session.selectedIds
          : session.matches.slice(0, 24).map((m) => m.photo.id),
      );
      capturingRef.current = false;
      stopCamera();
      setStep("results");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao restaurar busca");
    }
  }

  async function persistSelection(nextSelected: string[]) {
    if (!selfieUrl || matches.length === 0) return;
    const selfieBlob = await blobFromObjectUrl(selfieUrl);
    if (!selfieBlob) return;
    await saveMatchSession({
      albumKey: albumKey(photos),
      matches,
      selectedIds: nextSelected,
      selfieBlob,
    });
  }

  function togglePhoto(id: string) {
    setSelectedIds((current) => {
      const next = current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
      void persistSelection(next);
      return next;
    });
  }

  async function downloadZip() {
    const wanted = new Set(
      selectedIds.length > 0 ? selectedIds : matches.map((m) => m.photo.id),
    );
    const chosen = matches
      .filter((m) => wanted.has(m.photo.id))
      .map((m) => m.photo);
    if (chosen.length === 0) {
      setError("Nenhuma foto para baixar.");
      return;
    }

    setError(null);
    setZipping(true);
    try {
      const blob = await zipPhotos(chosen, (done, total) =>
        setZipLabel(done < total ? `${done}/${total}` : "Compactando"),
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `arretados-fotos-${chosen.length}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao baixar ZIP");
    } finally {
      setZipping(false);
      setZipLabel("");
    }
  }

  async function makeVideo() {
    // Antes de qualquer await: no iOS o áudio só libera dentro do gesto.
    unlockAudio();
    setError(null);
    setStep("rendering");
    setRenderProgress(0);
    setRenderLabel("Montando retrospectiva...");

    try {
      const selectedMatches = matches.filter((m) => selectedIds.includes(m.photo.id));
      const seen = new Set<string>();
      const unique = selectedMatches.filter((m) => {
        if (seen.has(m.photo.id)) return false;
        seen.add(m.photo.id);
        return true;
      });
      // Rajada de câmera vira uma foto só — 25 quadros do mesmo segundo no
      // vídeo parecem a mesma foto repetindo.
      const source = dropBurstDuplicates(unique, (m) => m.photo.name).slice(0, 48);
      if (source.length === 0) {
        throw new Error("Selecione ao menos uma foto para o vídeo.");
      }

      // Reduz as fotos antes do render — original de 13MP a 30fps trava o celular
      setRenderLabel("Preparando as fotos...");
      const clips = await prepareClips(
        source.map((m) => ({ key: m.photo.id, src: m.photo.src, face: m.face })),
        {
          onProgress: (done, total) => {
            setRenderProgress((done / total) * 0.2);
            setRenderLabel(`Preparando fotos · ${done}/${total}`);
          },
        },
      );
      if (clips.length === 0) {
        throw new Error("Não consegui carregar as fotos selecionadas.");
      }

      setRenderLabel("Montando retrospectiva...");
      try {
        const { blob, extension, diagnostics } = await renderAnniversaryVideo({
          clips,
          durationSec: MAX_VIDEO_SEC,
          onProgress: (ratio) => setRenderProgress(0.2 + ratio * 0.8),
        });

        if (videoUrl) URL.revokeObjectURL(videoUrl);
        const file = new File([blob], `arretados-2-anos.${extension}`, {
          type: blob.type,
        });
        videoFileRef.current = file;
        // Compartilhar arquivo é Web Share nível 2: existe no iOS e no Android,
        // quase nunca no desktop. Sem suporte, sobra o botão de baixar.
        setCanShareVideo(
          typeof navigator !== "undefined" &&
            typeof navigator.canShare === "function" &&
            navigator.canShare({ files: [file] }),
        );
        setVideoUrl(URL.createObjectURL(blob));
        setVideoExt(extension);
        setVideoInfo(diagnostics);
        setStep("video");
      } finally {
        releaseClips(clips);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao gerar vídeo");
      setStep("results");
    }
  }

  /**
   * Ações da tela do vídeo. No celular vão **abaixo** do player, em duas linhas.
   */
  const videoActions = (
    <>
      {canShareVideo && (
        <button
          type="button"
          className="btn-primary col-span-3 sm:w-auto"
          disabled={sharing}
          onClick={() => void shareVideo()}
        >
          {sharing ? "Abrindo..." : "Compartilhar"}
        </button>
      )}
      <a
        className={`text-center sm:w-auto ${canShareVideo ? "btn-ghost" : "btn-primary col-span-3"}`}
        href={videoUrl ?? undefined}
        download={`arretados-2-anos.${videoExt}`}
      >
        Baixar
      </a>
      <button
        type="button"
        className={`btn-ghost sm:w-auto ${canShareVideo ? "" : "col-span-2 sm:col-auto"}`}
        onClick={() => setStep("results")}
      >
        Fotos
      </button>
      <button
        type="button"
        className={`btn-ghost sm:w-auto ${canShareVideo ? "" : "col-span-1 sm:col-auto"}`}
        onClick={() => setStep("hero")}
      >
        Início
      </button>
    </>
  );

  /**
   * Ações da tela de resultados. No celular elas vão **abaixo** da grade, em
   * duas linhas — no topo elas empurravam as fotos pra fora da tela.
   */
  const resultActions = (
    <>
      <button
        type="button"
        className="btn-primary col-span-3 w-full sm:w-auto"
        disabled={matches.length > 0 && selectedIds.length === 0}
        onClick={() => void makeVideo()}
      >
        Vídeo com Fotos
      </button>
      {matches.length > 0 && (
        <button
          type="button"
          className="btn-ghost w-full sm:w-auto"
          disabled={zipping || selectedIds.length === 0}
          onClick={() => void downloadZip()}
        >
          {zipping ? `ZIP ${zipLabel}` : "Baixar ZIP"}
        </button>
      )}
      {matches.length > 0 && (
        <button
          type="button"
          className="btn-ghost w-full sm:w-auto"
          onClick={() =>
            setSelectedIds((current) => {
              const next =
                current.length === matches.length
                  ? []
                  : matches.map((m) => m.photo.id);
              void persistSelection(next);
              return next;
            })
          }
        >
          {selectedIds.length === matches.length ? "Limpar" : "Todas"}
        </button>
      )}
      <button
        type="button"
        className={`btn-ghost w-full sm:w-auto ${matches.length === 0 ? "col-span-3" : ""}`}
        onClick={() => {
          setStep("capture");
          void startCamera();
        }}
      >
        Nova selfie
      </button>
    </>
  );

  return (
    <div className="relative flex h-dvh max-h-dvh flex-col overflow-hidden bg-navy text-foam">
      <div className="pointer-events-none absolute inset-0">
        <div className="animate-drift absolute -left-20 top-0 h-[42vh] w-[42vh] rounded-full bg-[radial-gradient(circle,rgba(26,107,138,0.28),transparent_68%)]" />
        <div className="animate-drift absolute -right-14 bottom-0 h-[34vh] w-[34vh] rounded-full bg-[radial-gradient(circle,rgba(240,180,41,0.12),transparent_70%)] [animation-delay:-4s]" />
      </div>

      <header className="relative z-10 mx-auto flex w-full max-w-6xl shrink-0 items-center justify-between px-4 pb-1 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.jpg"
            alt="Arretados do Vôlei"
            className="h-10 w-10 rounded-full object-cover ring-2 ring-gold/45 sm:h-12 sm:w-12"
          />
          <p className="font-[family-name:var(--font-display)] text-xl tracking-[0.08em] text-sand sm:text-2xl">
            ARRETADOS
          </p>
        </div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-gold sm:text-sm">
          2 anos
        </p>
      </header>

      <main className="relative z-10 mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col overflow-hidden px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 sm:px-6">
        {step === "hero" && (
          <section className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 text-center sm:gap-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.jpg"
              alt="Logo Arretados"
              className="logo-glow h-[min(42vw,180px)] w-[min(42vw,180px)] rounded-full object-cover shadow-[0_16px_40px_rgba(0,0,0,0.45)] ring-[3px] ring-gold/55 sm:h-48 sm:w-48"
            />
            <div className="space-y-2">
              <h1 className="sr-only">Arretados 2 anos</h1>
              <p className="font-[family-name:var(--font-display)] text-[3.2rem] leading-none text-foam sm:text-6xl">
                2 ANOS
              </p>
              <p className="mx-auto max-w-md text-base leading-snug text-foam/75 sm:text-lg">
                Selfie → suas fotos → vídeo da celebração
              </p>
            </div>
            <button
              type="button"
              className="btn-primary w-full max-w-sm text-lg"
              disabled={!modelsReady || photosLoading}
              onClick={() => {
                setStep("capture");
                void startCamera();
              }}
            >
              {modelsReady ? "Começar" : "Carregando IA..."}
            </button>
            {savedSession && (
              <button
                type="button"
                className="btn-ghost w-full max-w-sm"
                disabled={photosLoading}
                onClick={() => void restoreSavedSession()}
              >
                Continuar última busca ({savedSession.count} fotos)
              </button>
            )}
            <p className="text-sm text-foam/55 sm:text-base">
              {photosLoading
                ? "Carregando álbum..."
                : photos.length > 0
                  ? `${photos.length} fotos no álbum${savedSession ? " · cache pronto" : ""}`
                  : "Álbum vazio — configure R2 ou public/photos"}
            </p>
          </section>
        )}

        {step === "capture" && (
          <section className="mx-auto flex min-h-0 w-full max-w-lg flex-1 flex-col items-center justify-center gap-4 text-center sm:gap-5">
            <div>
              <h2 className="font-[family-name:var(--font-display)] text-3xl text-sand sm:text-5xl">
                Olhe pra câmera
              </h2>
              <p className="mt-1 text-base text-foam/70 sm:text-lg">
                {autoCapture ? "Captura automática" : "Toque em tentar de novo"}
              </p>
            </div>
            <div className="relative h-[min(58vw,280px)] w-[min(58vw,280px)] sm:h-80 sm:w-80">
              <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(242,230,201,0.15)" strokeWidth="3.5" />
                <circle
                  cx="50"
                  cy="50"
                  r="46"
                  fill="none"
                  stroke="#f0c419"
                  strokeWidth="3.5"
                  strokeLinecap="round"
                  strokeDasharray={`${faceLock * 289} 289`}
                  className="transition-[stroke-dasharray] duration-200"
                />
              </svg>
              <div className="absolute inset-3 overflow-hidden rounded-full border border-sand/20 bg-ink">
                <video
                  ref={videoRef}
                  className={`h-full w-full scale-x-[-1] object-cover ${cameraOn ? "block" : "hidden"}`}
                  playsInline
                  muted
                />
                {!cameraOn && selfieUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={selfieUrl} alt="Selfie" className="h-full w-full object-cover" />
                )}
                {!cameraOn && !selfieUrl && (
                  <div className="flex h-full items-center justify-center bg-navy-mid/90">
                    <p className="text-sm text-foam/70">Câmera off</p>
                  </div>
                )}
              </div>
            </div>
            <p className="text-lg font-semibold text-gold sm:text-xl">{captureHint}</p>
            <canvas ref={canvasRef} className="hidden" />
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="user"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            <div className="flex w-full max-w-sm flex-col gap-3">
              {!autoCapture && (
                <button type="button" className="btn-primary w-full" onClick={() => void startCamera()}>
                  Tentar de novo
                </button>
              )}
              <div className="grid grid-cols-2 gap-3">
                <button type="button" className="btn-ghost w-full" onClick={() => fileRef.current?.click()}>
                  Enviar
                </button>
                <button
                  type="button"
                  className="btn-ghost w-full"
                  onClick={() => {
                    stopCamera();
                    setStep("hero");
                  }}
                >
                  Voltar
                </button>
              </div>
            </div>
          </section>
        )}

        {step === "scanning" && (
          <section className="mx-auto flex min-h-0 w-full max-w-lg flex-1 flex-col items-center justify-center gap-5 text-center">
            <div className="relative h-36 w-36 overflow-hidden rounded-full border-2 border-gold/45 sm:h-44 sm:w-44">
              {selfieUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={selfieUrl} alt="Selfie" className="h-full w-full object-cover" />
              )}
              <div className="animate-scan-line absolute inset-x-0 h-1 bg-gradient-to-r from-transparent via-gold to-transparent" />
            </div>
            <h2 className="font-[family-name:var(--font-display)] text-3xl text-sand sm:text-5xl">
              Procurando você...
            </h2>
            <p className="max-w-full truncate px-2 text-base text-foam/65 sm:text-lg">{scanLabel}</p>
            <div className="h-3 w-full overflow-hidden rounded-full bg-ink/60">
              <div
                className="h-full rounded-full bg-gradient-to-r from-ocean to-gold transition-all duration-300"
                style={{ width: `${Math.round(scanProgress * 100)}%` }}
              />
            </div>
            <p className="text-lg font-semibold text-foam/70 sm:text-xl">
              {Math.round(scanProgress * 100)}%
              {cacheHits > 0 ? ` · ${cacheHits} do cache` : ""}
            </p>
          </section>
        )}

        {step === "results" && (
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 flex-col gap-3 pb-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="font-[family-name:var(--font-display)] text-[2.4rem] leading-none text-sand sm:text-5xl">
                  {matches.length > 0
                    ? `${selectedIds.length}/${matches.length}`
                    : "Nenhuma"}
                </h2>
                <p className="mt-1 text-base text-foam/65">
                  {matches.length > 0
                    ? "selecionadas · toque pra marcar"
                    : "Tente outra selfie"}
                </p>
              </div>
              <div className="hidden sm:flex sm:w-auto sm:flex-wrap sm:justify-end sm:gap-2">
                {resultActions}
              </div>
            </div>

            {matches.length > 0 ? (
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
                <div className="grid grid-cols-2 gap-3 pb-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                  {matches.map((match) => {
                    const selected = selectedIds.includes(match.photo.id);
                    const posX = Math.round(match.face.cx * 100);
                    const posY = Math.round(Math.min(0.7, match.face.cy) * 100);
                    return (
                      <button
                        key={match.photo.id}
                        type="button"
                        onClick={() => togglePhoto(match.photo.id)}
                        className={`relative block w-full overflow-hidden rounded-2xl border-[3px] ${
                          selected
                            ? "border-gold opacity-100"
                            : "border-white/10 opacity-45 grayscale"
                        }`}
                        style={{ paddingBottom: "125%", height: 0 }}
                        aria-pressed={selected}
                        title={selected ? "Desmarcar" : "Marcar"}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={match.photo.src}
                          alt={match.photo.name}
                          /**
                           * Sem lazy o navegador baixa e decodifica as centenas
                           * de fotos do álbum (13MP cada) assim que o scan
                           * termina — era a trava logo depois de achar as fotos.
                           */
                          loading="lazy"
                          decoding="async"
                          className="absolute inset-0 h-full w-full"
                          style={{
                            objectFit: "cover",
                            objectPosition: `${posX}% ${posY}%`,
                          }}
                        />
                        <span
                          className={`absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full text-base font-bold shadow ${
                            selected ? "bg-gold text-ink" : "bg-ink/75 text-foam/70"
                          }`}
                        >
                          {selected ? "✓" : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-hidden opacity-60">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                  {photos.slice(0, 8).map((photo) => (
                    <div
                      key={photo.id}
                      className="relative w-full overflow-hidden rounded-2xl"
                      style={{ paddingBottom: "125%", height: 0 }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={photo.src}
                        alt={photo.name}
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="grid shrink-0 grid-cols-3 gap-2 pt-3 sm:hidden">
              {resultActions}
            </div>
          </section>
        )}

        {step === "rendering" && (
          <section className="mx-auto flex min-h-0 w-full max-w-lg flex-1 flex-col items-center justify-center gap-5 text-center">
            <h2 className="font-[family-name:var(--font-display)] text-3xl text-sand sm:text-5xl">
              {renderLabel}
            </h2>
            <div className="h-3 w-full overflow-hidden rounded-full bg-ink/60">
              <div
                className="h-full rounded-full bg-gradient-to-r from-gold to-flame transition-all duration-200"
                style={{ width: `${Math.round(renderProgress * 100)}%` }}
              />
            </div>
            <p className="text-xl font-semibold text-foam/70">
              {Math.round(renderProgress * 100)}%
            </p>
          </section>
        )}

        {step === "video" && videoUrl && (
          <section className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3 overflow-hidden">
            <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="font-[family-name:var(--font-display)] text-3xl text-sand sm:text-4xl">
                Seu vídeo
              </h2>
              <div className="hidden sm:flex sm:flex-wrap sm:justify-end sm:gap-2">
                {videoActions}
              </div>
            </div>
            <video
              src={videoUrl}
              controls
              autoPlay
              playsInline
              className="min-h-0 w-full flex-1 rounded-2xl border border-sand/20 bg-ink object-contain"
            />
            {videoInfo && (
              <p className="shrink-0 text-center text-xs text-foam/40">{videoInfo}</p>
            )}

            <div className="grid shrink-0 grid-cols-3 gap-2 pt-1 sm:hidden">
              {videoActions}
            </div>
          </section>
        )}

        {error && (
          <div className="pointer-events-none absolute bottom-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 rounded-2xl border border-flame/40 bg-ink/95 px-4 py-3 text-sm leading-snug text-foam shadow-xl">
            {error}
          </div>
        )}
      </main>
    </div>
  );
}
