/**
 * Saída de vídeo do app.
 *
 * Caminho preferido: WebCodecs (VideoEncoder + AudioEncoder) muxado em MP4
 * (H.264 + AAC) — é o que o Instagram Stories aceita, roda **offline** (mais
 * rápido que tempo real) e usa timestamp fixo por frame, então a duração final
 * é exata e não existe judder por frame lento.
 *
 * Fallback: MediaRecorder em tempo real (MP4 no Safari antigo, WebM no resto).
 * Aí a duração depende do relógio — por isso só é usado quando WebCodecs falta.
 */
import { ArrayBufferTarget, Muxer } from "mp4-muxer";

export type FrameSink = {
  /** Entrega o conteúdo atual do canvas como frame `index`. */
  addFrame: (index: number) => Promise<void>;
  finish: () => Promise<Blob>;
  abort: () => void;
  /** "mp4" | "webm" — extensão do arquivo pro download. */
  extension: string;
  /** false = tempo real (MediaRecorder); true = encode offline. */
  offline: boolean;
};

export type SinkOptions = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  musicUrl: string;
};

/** Trilha do vídeo; as demais são fallback se a primeira faltar ou não decodificar. */
export const DEFAULT_MUSIC_URL = "/music.mp3";
const MUSIC_FALLBACKS = [DEFAULT_MUSIC_URL, "/music/tema.m4a", "/music/party.mp3"];
/** A introdução da faixa não serve de trilha — o vídeo entra no refrão. */
const MUSIC_START_SEC = 13;

const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_CHANNELS = 2;
const AUDIO_BITRATE = 128_000;
const AUDIO_CHUNK_FRAMES = 1024;
/** Sobreposição entre repetições da trilha, pra emenda não estalar. */
const LOOP_CROSSFADE_SEC = 1.5;

/** Cede o event loop sem o clamp de 4ms do setTimeout aninhado. */
function makeYield() {
  if (typeof MessageChannel === "undefined") {
    return () => new Promise<void>((r) => setTimeout(r, 0));
  }
  const channel = new MessageChannel();
  let resolveNext: (() => void) | null = null;
  channel.port1.onmessage = () => {
    const fn = resolveNext;
    resolveNext = null;
    fn?.();
  };
  return () =>
    new Promise<void>((resolve) => {
      resolveNext = resolve;
      channel.port2.postMessage(null);
    });
}

export const yieldToUi = makeYield();

/**
 * ~0.06 bit por pixel por frame ≈ 3.7 Mbps em 1080x1920@30 — a faixa que o
 * Instagram usa nos Stories. Mais que isso só engorda o upload: o app
 * recomprime tudo na entrada.
 */
function videoBitrate(width: number, height: number, fps: number) {
  return Math.round(Math.min(6_000_000, width * height * fps * 0.06));
}

/**
 * Perfis H.264 do mais capaz pro mais compatível.
 * High@4.2 aguenta 1080x1920@30; Baseline é o piso universal.
 */
const AVC_CODECS = ["avc1.64002a", "avc1.640028", "avc1.4d0032", "avc1.42003c"];

async function pickAvcCodec(width: number, height: number, fps: number) {
  if (typeof VideoEncoder === "undefined") return null;
  for (const codec of AVC_CODECS) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate: videoBitrate(width, height, fps),
        framerate: fps,
      });
      if (support.supported) return codec;
    } catch {
      // tenta o próximo
    }
  }
  return null;
}

/**
 * Carrega a trilha, tentando o tema oficial e caindo na faixa antiga.
 *
 * O fallback cobre os dois modos de falha: arquivo ausente **e** codec que o
 * navegador não decodifica (nem todo browser abre AAC). Sem isso, um decode
 * quebrado deixaria o vídeo mudo.
 */
async function decodeMusic(ctx: BaseAudioContext, url: string): Promise<AudioBuffer> {
  const candidates = url === DEFAULT_MUSIC_URL ? MUSIC_FALLBACKS : [url];
  let last: unknown = null;
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate);
      if (!res.ok) {
        last = new Error(`${candidate} (${res.status})`);
        continue;
      }
      return await ctx.decodeAudioData(await res.arrayBuffer());
    } catch (err) {
      last = err;
    }
  }
  throw new Error(
    `Não deu pra carregar a música de fundo. ${last instanceof Error ? last.message : ""}`.trim(),
  );
}

/**
 * Renderiza exatamente `durationSec` de trilha (com loop + fades) num
 * AudioBuffer, pronto pra encodar em AAC.
 */
async function renderMusicOffline(url: string, durationSec: number) {
  /**
   * O AAC só fecha quadros de 1024 amostras, então a trilha sempre arredonda
   * pra cima. Encurtando alguns quadros, a faixa de áudio termina **antes** do
   * vídeo e a duração do arquivo continua sendo a do vídeo — o cap de 58s vale.
   */
  const frames = Math.max(
    AUDIO_CHUNK_FRAMES,
    Math.floor(durationSec * AUDIO_SAMPLE_RATE) - AUDIO_CHUNK_FRAMES * 4,
  );
  const trackSec = frames / AUDIO_SAMPLE_RATE;

  const offline = new OfflineAudioContext(
    AUDIO_CHANNELS,
    frames,
    AUDIO_SAMPLE_RATE,
  );
  const buffer = await decodeMusic(offline, url);

  const master = offline.createGain();
  const fadeIn = 0.35;
  // Mesma janela do fade de imagem em video.ts: som e imagem apagam juntos.
  const fadeOut = 1.2;
  master.gain.setValueAtTime(0.0001, 0);
  master.gain.exponentialRampToValueAtTime(0.9, fadeIn);
  master.gain.setValueAtTime(0.9, Math.max(fadeIn, trackSec - fadeOut));
  master.gain.exponentialRampToValueAtTime(0.0001, trackSec);
  master.connect(offline.destination);

  /**
   * A trilha é mais curta que o vídeo, então repete. `source.loop` emenda seco
   * no fim do trecho e o corte fica audível — parece que a música acabou e
   * recomeçou. Cada repetição entra sobreposta, com crossfade na emenda.
   */
  // A faixa começa em MUSIC_START_SEC; só o que vem depois disso é usado.
  const offset = Math.min(MUSIC_START_SEC, Math.max(0, buffer.duration - 1));
  const clipSec = buffer.duration - offset;
  const crossfade = Math.min(LOOP_CROSSFADE_SEC, clipSec / 4);
  const stride = Math.max(0.5, clipSec - crossfade);
  const [fadeInCurve, fadeOutCurve] = equalPowerCurves();

  for (let start = 0; start < trackSec; start += stride) {
    const source = offline.createBufferSource();
    source.buffer = buffer;

    const gain = offline.createGain();
    if (start === 0) {
      gain.gain.setValueAtTime(1, 0);
    } else {
      gain.gain.setValueCurveAtTime(fadeInCurve, start, crossfade);
    }

    const end = Math.min(trackSec, start + clipSec);
    if (end < trackSec) {
      gain.gain.setValueCurveAtTime(fadeOutCurve, end - crossfade, crossfade);
    }

    source.connect(gain);
    gain.connect(master);
    source.start(start, offset);
    source.stop(end);
  }

  return offline.startRendering();
}

/**
 * Curvas de entrada/saída do crossfade, em potência constante (sen/cos).
 *
 * Rampa exponencial nos dois lados **não** serve: no meio da emenda cada lado
 * vale 0.01, a soma dá silêncio e a música parece cortar. Com sen²+cos²=1 a
 * energia se mantém.
 */
function equalPowerCurves(points = 128): [Float32Array, Float32Array] {
  const fadeIn = new Float32Array(points);
  const fadeOut = new Float32Array(points);
  for (let i = 0; i < points; i += 1) {
    const t = (i / (points - 1)) * (Math.PI / 2);
    fadeIn[i] = Math.sin(t);
    fadeOut[i] = Math.cos(t);
  }
  return [fadeIn, fadeOut];
}

/** Fatia planar (canal 0 inteiro, depois canal 1) — formato do AudioData. */
function planarSlice(buffer: AudioBuffer, start: number, count: number) {
  const channels = buffer.numberOfChannels;
  const out = new Float32Array(channels * count);
  for (let c = 0; c < channels; c += 1) {
    out.set(buffer.getChannelData(c).subarray(start, start + count), c * count);
  }
  return out;
}

async function encodeAudioTrack(
  buffer: AudioBuffer,
  muxer: Muxer<ArrayBufferTarget>,
) {
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (err) => {
      throw err;
    },
  });
  encoder.configure({
    codec: "mp4a.40.2",
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
    bitrate: AUDIO_BITRATE,
  });

  for (let start = 0; start < buffer.length; start += AUDIO_CHUNK_FRAMES) {
    const count = Math.min(AUDIO_CHUNK_FRAMES, buffer.length - start);
    const data = new AudioData({
      format: "f32-planar",
      sampleRate: buffer.sampleRate,
      numberOfFrames: count,
      numberOfChannels: buffer.numberOfChannels,
      timestamp: Math.round((start / buffer.sampleRate) * 1e6),
      data: planarSlice(buffer, start, count),
    });
    encoder.encode(data);
    data.close();
    if (encoder.encodeQueueSize > 24) await yieldToUi();
  }

  await encoder.flush();
  encoder.close();
}

async function createWebCodecsSink(opts: SinkOptions): Promise<FrameSink | null> {
  if (
    typeof VideoEncoder === "undefined" ||
    typeof AudioEncoder === "undefined" ||
    typeof VideoFrame === "undefined" ||
    typeof OfflineAudioContext === "undefined"
  ) {
    return null;
  }

  const { canvas, width, height, fps, totalFrames, musicUrl } = opts;
  const codec = await pickAvcCodec(width, height, fps);
  if (!codec) return null;

  const durationSec = totalFrames / fps;
  const audioSupport = await AudioEncoder.isConfigSupported({
    codec: "mp4a.40.2",
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: AUDIO_CHANNELS,
    bitrate: AUDIO_BITRATE,
  }).catch(() => null);
  if (!audioSupport?.supported) return null;

  const music = await renderMusicOffline(musicUrl, durationSec);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    fastStart: "in-memory",
    video: { codec: "avc", width, height, frameRate: fps },
    audio: {
      codec: "aac",
      numberOfChannels: music.numberOfChannels,
      sampleRate: music.sampleRate,
    },
  });

  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      encoderError = err instanceof Error ? err : new Error(String(err));
    },
  });
  encoder.configure({
    codec,
    width,
    height,
    bitrate: videoBitrate(width, height, fps),
    framerate: fps,
    latencyMode: "quality",
    hardwareAcceleration: "prefer-hardware",
    avc: { format: "avc" },
  });

  const frameDurationUs = Math.round(1e6 / fps);
  let closed = false;

  return {
    extension: "mp4",
    offline: true,
    async addFrame(index: number) {
      if (encoderError) throw encoderError;
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((index * 1e6) / fps),
        duration: frameDurationUs,
      });
      // Keyframe a cada 2s: seek rápido e player do Instagram feliz.
      encoder.encode(frame, { keyFrame: index % (fps * 2) === 0 });
      frame.close();
      // Backpressure: não deixa a fila do encoder estourar memória.
      while (encoder.encodeQueueSize > 8) await yieldToUi();
      if (index % 4 === 0) await yieldToUi();
    },
    async finish() {
      await encoder.flush();
      encoder.close();
      closed = true;
      if (encoderError) throw encoderError;
      await encodeAudioTrack(music, muxer);
      muxer.finalize();
      return new Blob([target.buffer as ArrayBuffer], { type: "video/mp4" });
    },
    abort() {
      if (!closed) {
        try {
          encoder.close();
        } catch {
          // já fechado
        }
      }
    },
  };
}

const RECORDER_MIME_TYPES = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

/**
 * Fallback em tempo real. Grava na velocidade do relógio; se um frame demorar
 * mais que 1/fps o vídeo alonga — por isso é o último recurso.
 */
async function createMediaRecorderSink(opts: SinkOptions): Promise<FrameSink> {
  const { canvas, fps, musicUrl } = opts;

  const mimeType = RECORDER_MIME_TYPES.find(
    (type) =>
      typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type),
  );
  if (!mimeType) throw new Error("Seu navegador não consegue gravar vídeo.");

  const audioCtx = new AudioContext();
  await audioCtx.resume();

  const dest = audioCtx.createMediaStreamDestination();
  const master = audioCtx.createGain();
  master.gain.value = 0.9;
  master.connect(dest);

  let musicSource: AudioBufferSourceNode;
  try {
    musicSource = audioCtx.createBufferSource();
    musicSource.buffer = await decodeMusic(audioCtx, musicUrl);
    musicSource.loop = true;
    musicSource.loopStart = Math.min(MUSIC_START_SEC, Math.max(0, musicSource.buffer.duration - 1));
    musicSource.connect(master);
    musicSource.start(0, musicSource.loopStart);
  } catch (err) {
    await audioCtx.close();
    throw err instanceof Error ? err : new Error("Falha na música de fundo");
  }

  type CaptureTrack = MediaStreamTrack & { requestFrame?: () => void };
  let videoStream: MediaStream;
  let requestFrame: (() => void) | null = null;
  try {
    const manual = canvas.captureStream(0);
    const track = manual.getVideoTracks()[0] as CaptureTrack;
    if (typeof track.requestFrame === "function") {
      videoStream = manual;
      requestFrame = () => track.requestFrame?.();
    } else {
      videoStream = canvas.captureStream(fps);
    }
  } catch {
    videoStream = canvas.captureStream(fps);
  }

  const mixed = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(mixed, {
    mimeType,
    videoBitsPerSecond: videoBitrate(opts.width, opts.height, fps),
    audioBitsPerSecond: AUDIO_BITRATE,
  });
  const containerType = mimeType.startsWith("video/mp4") ? "video/mp4" : "video/webm";
  const done = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = () => reject(new Error("Falha ao gravar vídeo"));
    recorder.onstop = () => resolve(new Blob(chunks, { type: containerType }));
  });
  recorder.start(100);

  const frameDurationMs = 1000 / fps;
  const started = performance.now();
  const cleanup = () => {
    try {
      musicSource.stop();
    } catch {
      // já parado
    }
    videoStream.getTracks().forEach((t) => t.stop());
    dest.stream.getTracks().forEach((t) => t.stop());
  };

  return {
    extension: containerType === "video/mp4" ? "mp4" : "webm",
    offline: false,
    async addFrame(index: number) {
      const target = started + (index + 1) * frameDurationMs;
      const delay = target - performance.now();
      if (delay > 1) {
        await new Promise((r) => setTimeout(r, delay));
      } else {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
      requestFrame?.();
    },
    async finish() {
      master.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.2);
      await new Promise((r) => setTimeout(r, 40));
      recorder.stop();
      cleanup();
      const blob = await done;
      await audioCtx.close();
      return blob;
    },
    abort() {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        // ignore
      }
      cleanup();
      void audioCtx.close();
    },
  };
}

export async function createFrameSink(opts: SinkOptions): Promise<FrameSink> {
  try {
    const webcodecs = await createWebCodecsSink(opts);
    if (webcodecs) return webcodecs;
  } catch {
    // cai pro MediaRecorder
  }
  return createMediaRecorderSink(opts);
}
