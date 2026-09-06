import {
  DEFAULT_MUSIC_URL,
  countAudioSamples,
  createFrameSink,
  measureAudioPeak,
  yieldToUi,
} from "@/lib/encode";
import type { FrameSink, RenderOutput } from "@/lib/encode";
import { mapPool } from "@/lib/pool";
import type { FaceBox } from "@/lib/types";

/**
 * Fonte de imagem já reduzida pro tamanho que o vídeo usa.
 * Desenhar um JPEG de 13MP a cada frame era a maior causa de travamento —
 * `prepareClips` reduz uma vez e o render só compõe.
 */
export type ClipImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
};

export type VideoClip = {
  image: ClipImage;
  face?: FaceBox;
  key: string;
  /** Miniatura em cinza 32x32 — base da comparação de fotos parecidas. */
  signature?: Float32Array;
};

export type RenderVideoOptions = {
  clips: VideoClip[];
  width?: number;
  height?: number;
  fps?: number;
  durationSec?: number;
  musicUrl?: string;
  onProgress?: (ratio: number) => void;
};

type SubjectKind = "portrait" | "group" | "scene";
type ShotKind = "collage";
type TransitionKind = "fade" | "zoom" | "whip" | "whipV" | "softZoom" | "crossBlur";
type PinMotion = "pushIn" | "pullOut" | "panH" | "panV" | "kenBurns" | "drift";

type PlannedShot = {
  kind: ShotKind;
  clip: VideoClip;
  clips: VideoClip[];
  subject: SubjectKind;
  transition: TransitionKind;
  layoutVariant: number;
  motions: PinMotion[];
  dirX: number;
  dirY: number;
  weight: number;
};

const TRANSITIONS: TransitionKind[] = [
  "softZoom",
  "fade",
  "whip",
  "crossBlur",
  "zoom",
  "whipV",
  "softZoom",
  "fade",
];

const MOTION_CYCLE: PinMotion[] = [
  "pushIn",
  "kenBurns",
  "panH",
  "pullOut",
  "drift",
  "panV",
  "kenBurns",
  "pushIn",
];

const SIZE_CYCLE = [1, 3, 2, 4, 2, 1, 3, 4];

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function easeOutCubic(t: number) {
  return 1 - (1 - t) ** 3;
}

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function faceSpan(face?: FaceBox) {
  if (!face) return 0.2;
  return Math.max(face.width, face.height);
}

/** portrait = close face; group = small face in wide scene; else scene. */
function classifySubject(face?: FaceBox): SubjectKind {
  const span = faceSpan(face);
  if (!face) return "scene";
  if (span >= 0.16) return "portrait";
  if (span <= 0.11) return "group";
  return "scene";
}

function softApproach(t: number, hold: number, max: number) {
  // Quase sem “freeze” no início — já começa a mover
  const h = Math.min(hold, 0.06);
  if (t <= h) return max * 0.06 * (t / (h || 1));
  return max * 0.06 + easeInOutCubic((t - h) / (1 - h)) * (max * 0.94);
}

function isLandscapeImage(img: ClipImage) {
  return img.width > img.height * 1.08;
}

/** Soft dimmed cover fill behind letterboxed landscape shots (no blur — blur was killing render pace). */
function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  img: ClipImage,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
) {
  const iw = img.width;
  const ih = img.height;
  const s = Math.max(dw / iw, dh / ih);
  const bw = iw * s;
  const bh = ih * s;
  const bx = dx + (dw - bw) / 2;
  const by = dy + (dh - bh) / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  ctx.globalAlpha = 0.28;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "low";
  ctx.drawImage(img.source, bx, by, bw, bh);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(5,15,40,0.62)";
  ctx.fillRect(dx, dy, dw, dh);
  ctx.restore();
}

/**
 * Place image so pan only uses available overflow — avoids clamp fighting
 * (main cause of zoom shake).
 */
function placeCover(
  dw: number,
  dh: number,
  drawW: number,
  drawH: number,
  focusX: number,
  focusY: number,
  panX: number,
  panY: number,
) {
  const overflowX = drawW - dw;
  const overflowY = drawH - dh;

  let x = dw / 2 - focusX * drawW;
  let y = dh / 2 - focusY * drawH;

  // Pan scaled by room we actually have (0 when letterboxed)
  if (overflowX > 0) x += panX * overflowX * 0.45;
  if (overflowY > 0) y += panY * overflowY * 0.45;

  if (overflowX >= 0) {
    x = clamp(x, dw - drawW, 0);
  } else {
    x = -overflowX / 2;
  }

  if (overflowY >= 0) {
    y = clamp(y, dh - drawH, 0);
  } else {
    y = -overflowY / 2;
  }

  return { x, y };
}

/**
 * Crop/scale only — never warps pixels.
 * Portrait: cover → soft face approach.
 * Landscape: contain (full photo) → gentle cover toward face.
 */
function drawFramed(
  ctx: CanvasRenderingContext2D,
  img: ClipImage,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  face: FaceBox | undefined,
  framing: number,
  panX = 0,
  panY = 0,
) {
  const iw = img.width;
  const ih = img.height;
  const landscape = isLandscapeImage(img);
  const f = clamp(framing, 0, 1);

  const cx = face?.cx ?? 0.5;
  const cy = face?.cy ?? 0.42;
  const fSize = faceSpan(face);

  const contain = Math.min(dw / iw, dh / ih);
  const cover = Math.max(dw / iw, dh / ih);

  // Focus eases toward face; keep headroom
  const focusX = 0.5 * (1 - f) + cx * f;
  const focusY = 0.5 * (1 - f) + Math.max(0.22, cy - fSize * 0.12) * f;

  // Cap face boost up-front so scale stays continuous (no mid-zoom correction jumps)
  let faceBoost: number;
  if (landscape) {
    faceBoost = 1 + f * clamp(0.32 + (0.2 - fSize) * 0.7, 0.22, 0.42);
  } else {
    faceBoost = 1 + f * clamp(0.24 + (0.2 - fSize) * 0.45, 0.16, 0.36);
  }
  if (face && fSize > 0.01) {
    const maxBoost = (dh * 0.52) / (fSize * ih * cover);
    faceBoost = Math.min(faceBoost, Math.max(1, maxBoost));
  }

  let scale: number;
  if (landscape) {
    const target = cover * faceBoost;
    const eased = easeInOutCubic(f);
    scale = contain * (1 - eased) + target * eased;
    // Skip expensive backdrop on small collage pins
    if (dw >= 420 && dh >= 420) {
      drawBackdrop(ctx, img, dx, dy, dw, dh);
    } else {
      ctx.fillStyle = "#071638";
      ctx.fillRect(dx, dy, dw, dh);
    }
  } else {
    scale = cover * faceBoost;
  }

  const drawW = iw * scale;
  const drawH = ih * scale;

  // Fade pan while zooming so focus travel stays stable
  const panFade = 1 - f * 0.75;
  const { x, y } = placeCover(
    dw,
    dh,
    drawW,
    drawH,
    focusX,
    focusY,
    panX * panFade,
    panY * panFade,
  );

  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(img.source, dx + x, dy + y, drawW, drawH);
  ctx.restore();
}

function drawFlash(ctx: CanvasRenderingContext2D, width: number, height: number, alpha: number) {
  if (alpha <= 0) return;
  ctx.fillStyle = `rgba(255,255,255,${clamp(alpha, 0, 1)})`;
  ctx.fillRect(0, 0, width, height);
}

function drawLightSweep(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  t: number,
) {
  const x = -width * 0.4 + t * width * 1.8;
  const grad = ctx.createLinearGradient(x, 0, x + width * 0.22, height);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.08)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
}

/** Linha da cartela: `size` é fração da largura do vídeo. */
type CardLine = { text: string; size: number; color: string };

/**
 * Mensagem de encerramento. A primeira linha é a fala, a segunda o respiro e a
 * terceira o agradecimento — por isso os tamanhos e as cores diferentes.
 */
const OUTRO_LINES: CardLine[] = [
  { text: "Eu fiz parte", size: 0.1, color: "#f7f4ee" },
  { text: "dessa história.", size: 0.1, color: "#f7f4ee" },
  { text: "E que história! ❤️🏐", size: 0.082, color: "#f0c419" },
  { text: "Obrigado, Arretados,", size: 0.078, color: "#f7f4ee" },
  { text: "por esses 2 anos!", size: 0.078, color: "#f7f4ee" },
];

/**
 * Abertura e encerramento em cima da própria arte: ela já traz logo, "2 ANOS",
 * o slogan e a data — recriar isso em canvas só competiria com o desenho.
 * A arte fica **parada**; o movimento é todo das fotos.
 */
function drawArtCard(
  ctx: CanvasRenderingContext2D,
  backdrop: HTMLCanvasElement,
  width: number,
  height: number,
  t: number,
  headline: CardLine[],
) {
  ctx.drawImage(backdrop, 0, 0);
  drawLightSweep(ctx, width, height, clamp(t * 0.9, 0, 1));

  if (headline.length === 0) return;

  // Centralizado na mesma faixa que as fotos ocupam.
  const cy = (PHOTO_AREA.y + PHOTO_AREA.height / 2) * height;
  // Estica em ~0.35s e para: o resto da cartela é tempo de leitura.
  const pop = 0.92 + easeOutCubic(clamp(t / 0.35, 0, 1)) * 0.1;
  const lineGap = 1.35;

  ctx.save();
  ctx.translate(width / 2, cy);
  ctx.scale(pop, pop);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const sizes = headline.map((line) => Math.floor(width * line.size));
  const totalHeight = sizes.reduce((a, size) => a + size * lineGap, 0);
  let y = -totalHeight / 2 + (sizes[0] * lineGap) / 2;

  for (let i = 0; i < headline.length; i += 1) {
    const line = headline[i];
    // Emoji precisa da fonte colorida do sistema; o resto é a display do tema.
    ctx.font = `700 ${sizes[i]}px Bebas Neue, Impact, Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif`;
    ctx.lineWidth = Math.max(4, sizes[i] * 0.11);
    ctx.strokeStyle = "rgba(6,20,51,0.8)";
    ctx.strokeText(line.text, 0, y);
    ctx.fillStyle = line.color;
    ctx.fillText(line.text, 0, y);
    y += ((sizes[i] + (sizes[i + 1] ?? sizes[i])) / 2) * lineGap;
  }
  ctx.restore();
}

function drawVolleyCourt(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  t: number,
) {
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, "#0c2758");
  g.addColorStop(0.55, "#0a1f4d");
  g.addColorStop(1, "#071638");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = "rgba(247,244,238,0.28)";
  ctx.lineWidth = Math.max(2, width * 0.003);
  // sidelines
  ctx.strokeRect(width * 0.08, height * 0.12, width * 0.84, height * 0.7);
  // attack lines
  ctx.beginPath();
  ctx.moveTo(width * 0.08, height * 0.3);
  ctx.lineTo(width * 0.92, height * 0.3);
  ctx.moveTo(width * 0.08, height * 0.64);
  ctx.lineTo(width * 0.92, height * 0.64);
  ctx.stroke();
  // center line (gold)
  ctx.strokeStyle = "rgba(240,196,25,0.55)";
  ctx.lineWidth = Math.max(3, width * 0.004);
  ctx.beginPath();
  ctx.moveTo(width * 0.08, height * 0.47);
  ctx.lineTo(width * 0.92, height * 0.47);
  ctx.stroke();
  // center circle
  ctx.beginPath();
  ctx.arc(width * 0.5, height * 0.47, width * 0.09, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // net
  ctx.save();
  ctx.globalAlpha = 0.4;
  const netY = height * 0.455;
  const netH = height * 0.045;
  ctx.fillStyle = "rgba(247,244,238,0.08)";
  ctx.fillRect(width * 0.06, netY, width * 0.88, netH);
  ctx.strokeStyle = "rgba(240,196,25,0.5)";
  ctx.lineWidth = 2;
  ctx.strokeRect(width * 0.06, netY, width * 0.88, netH);
  ctx.beginPath();
  for (let x = width * 0.08; x < width * 0.92; x += width * 0.028) {
    ctx.moveTo(x, netY);
    ctx.lineTo(x, netY + netH);
  }
  for (let y = netY; y < netY + netH; y += netH / 3) {
    ctx.moveTo(width * 0.06, y);
    ctx.lineTo(width * 0.94, y);
  }
  ctx.strokeStyle = "rgba(247,244,238,0.25)";
  ctx.stroke();
  ctx.restore();

  // soft ball watermark
  const ballR = width * 0.11;
  const bx = width * 0.86;
  const by = height * 0.16 + Math.sin(t * Math.PI) * height * 0.01;
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.beginPath();
  ctx.arc(bx, by, ballR, 0, Math.PI * 2);
  ctx.fillStyle = "#f7f4ee";
  ctx.fill();
  ctx.strokeStyle = "#f0c419";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = "rgba(240,196,25,0.85)";
  ctx.font = `700 ${Math.floor(width * 0.055)}px Bebas Neue, Impact, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText("MURAL ARRETADOS", width * 0.08, height * 0.09);
}

/**
 * Célula da colagem, em fração da área útil (canto superior esquerdo + tamanho).
 *
 * Retângulo em vez de centro+tamanho máximo porque as células precisam ser uma
 * **partição** da área: com centros soltos as fotos se sobrepunham e a de cima
 * cobria o rosto de quem estava embaixo.
 */
type PinSlot = { x: number; y: number; w: number; h: number; rot: number };

/** Respiro entre células, em fração da área. */
const CELL_GAP = 0.018;

/**
 * Divide `count` fotos em células que não se cruzam.
 *
 * Cada layout parte da área inteira e a corta; o `rot` é pequeno de propósito,
 * porque o giro cresce a caixa e é o que sobrava por cima da célula vizinha.
 */
function collageSlots(count: number, variant: number): PinSlot[] {
  const g = CELL_GAP;
  const half = (1 - g) / 2;

  const layouts: PinSlot[][][] = [
    // 1 foto
    [[{ x: 0, y: 0, w: 1, h: 1, rot: -1.2 }], [{ x: 0, y: 0, w: 1, h: 1, rot: 1.4 }]],
    // 2 fotos
    [
      [
        { x: 0, y: 0, w: 1, h: half, rot: -1.6 },
        { x: 0, y: half + g, w: 1, h: half, rot: 1.4 },
      ],
      [
        { x: 0, y: 0, w: 1, h: 0.56 - g, rot: -1.2 },
        { x: 0, y: 0.56, w: 1, h: 0.44, rot: 1.6 },
      ],
      [
        { x: 0, y: 0, w: half, h: 1, rot: -1.8 },
        { x: half + g, y: 0, w: half, h: 1, rot: 1.5 },
      ],
    ],
    // 3 fotos
    [
      [
        { x: 0, y: 0, w: 1, h: 0.52 - g, rot: -1.4 },
        { x: 0, y: 0.52, w: half, h: 0.48, rot: 1.6 },
        { x: half + g, y: 0.52, w: half, h: 0.48, rot: -1.5 },
      ],
      [
        { x: 0, y: 0, w: half, h: 0.5 - g, rot: -1.6 },
        { x: half + g, y: 0, w: half, h: 0.5 - g, rot: 1.4 },
        { x: 0, y: 0.5, w: 1, h: 0.5, rot: -1.2 },
      ],
      [
        { x: 0, y: 0, w: 0.54 - g, h: 1, rot: -1.5 },
        { x: 0.54, y: 0, w: 0.46, h: half, rot: 1.6 },
        { x: 0.54, y: half + g, w: 0.46, h: half, rot: -1.4 },
      ],
    ],
    // 4 fotos
    [
      [
        { x: 0, y: 0, w: half, h: half, rot: -1.6 },
        { x: half + g, y: 0, w: half, h: half, rot: 1.5 },
        { x: 0, y: half + g, w: half, h: half, rot: 1.4 },
        { x: half + g, y: half + g, w: half, h: half, rot: -1.5 },
      ],
      [
        { x: 0, y: 0, w: 1, h: 0.42 - g, rot: -1.3 },
        { x: 0, y: 0.42, w: 0.33 - g, h: 0.58, rot: 1.5 },
        { x: 0.335, y: 0.42, w: 0.33 - g, h: 0.58, rot: -1.4 },
        { x: 0.67, y: 0.42, w: 0.33, h: 0.58, rot: 1.6 },
      ],
      [
        { x: 0, y: 0, w: 0.6 - g, h: 1, rot: -1.4 },
        { x: 0.6, y: 0, w: 0.4, h: 0.33 - g, rot: 1.5 },
        { x: 0.6, y: 0.335, w: 0.4, h: 0.33 - g, rot: -1.5 },
        { x: 0.6, y: 0.67, w: 0.4, h: 0.33, rot: 1.3 },
      ],
    ],
  ];

  const forCount = layouts[clamp(count, 1, 4) - 1];
  return forCount[variant % forCount.length];
}

function frameSizeForPhoto(
  img: ClipImage,
  maxW: number,
  maxH: number,
): { w: number; h: number; landscape: boolean } {
  const landscape = isLandscapeImage(img);
  if (landscape) {
    let w = maxW;
    let h = w / 1.42;
    if (h > maxH) {
      h = maxH;
      w = h * 1.42;
    }
    return { w, h, landscape: true };
  }
  let h = maxH;
  let w = h * 0.72;
  if (w > maxW) {
    w = maxW;
    h = w / 0.72;
  }
  return { w, h, landscape: false };
}

function pinMotion(
  kind: PinMotion,
  t: number,
  dir: number,
  landscape: boolean,
  hasFace: boolean,
) {
  const e = easeInOutCubic(t);
  const faceBoost = hasFace ? 1 : 0.75;
  if (kind === "pushIn") {
    const max = (landscape ? 0.26 : 0.44) * faceBoost;
    return {
      framing: softApproach(t, 0.04, max),
      panX: dir * 0.06 * e,
      panY: -0.05 * e * faceBoost,
    };
  }
  if (kind === "pullOut") {
    const start = (landscape ? 0.24 : 0.38) * faceBoost;
    return {
      framing: start * (1 - e) + 0.05,
      panX: dir * 0.1 * (1 - e),
      panY: 0.04 * (1 - e),
    };
  }
  if (kind === "panH") {
    return {
      framing: 0.1 + e * 0.1 * faceBoost,
      panX: dir * (-0.38 + e * 0.76),
      panY: dir * 0.05 * Math.sin(t * Math.PI),
    };
  }
  if (kind === "panV") {
    return {
      framing: 0.1 + e * 0.12 * faceBoost,
      panX: dir * 0.05,
      panY: dir * (-0.3 + e * 0.6),
    };
  }
  if (kind === "drift") {
    return {
      framing: 0.08 + Math.sin(t * Math.PI) * 0.14 * faceBoost,
      panX: dir * Math.sin(t * Math.PI * 2) * 0.14,
      panY: Math.cos(t * Math.PI) * 0.09,
    };
  }
  return {
    framing: softApproach(t, 0.03, (landscape ? 0.2 : 0.34) * faceBoost),
    panX: dir * (0.05 + e * 0.22),
    panY: (dir > 0 ? -1 : 1) * (0.03 + e * 0.14),
  };
}

function drawPinnedPhoto(
  ctx: CanvasRenderingContext2D,
  clip: VideoClip,
  x: number,
  y: number,
  w: number,
  h: number,
  rotDeg: number,
  appear: number,
  motionT: number,
  motion: PinMotion,
  dir: number,
  landscape: boolean,
) {
  const a = clamp(appear, 0, 1);
  if (a <= 0.01) return;
  const pop = 0.9 + easeOutCubic(a) * 0.12;
  const m = pinMotion(motion, clamp(motionT, 0, 1), dir, landscape, Boolean(clip.face));

  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate((rotDeg * Math.PI) / 180);
  ctx.scale(pop, pop);
  ctx.translate(-(x + w / 2), -(y + h / 2));

  const pad = Math.min(w, h) * 0.04;
  const bottomExtra = landscape ? pad * 1.2 : pad * 2.4;
  ctx.fillStyle = "#f7f4ee";
  ctx.fillRect(x - pad, y - pad, w + pad * 2, h + pad + bottomExtra);

  ctx.fillStyle = "rgba(240,196,25,0.48)";
  ctx.fillRect(x + w * 0.1, y - pad * 0.8, w * 0.26, pad);
  ctx.fillRect(x + w * 0.64, y - pad * 0.7, w * 0.26, pad);

  ctx.imageSmoothingQuality = "medium";
  drawFramed(ctx, clip.image, x, y, w, h, clip.face, m.framing, m.panX, m.panY);
  ctx.restore();
}

/** Arte de fundo do vídeo (9:16). Se faltar, cai no gráfico de quadra gerado. */
const BACKGROUND_URL = "/bg-arretados.jpg";

/**
 * Faixa da arte onde as fotos podem entrar: da base do banner
 * "SEMPRE ARRETADOS!" até o rodapé, largura quase cheia. Pode cobrir a rede, a
 * areia e a bola — só o cabeçalho fica reservado. Fração da tela.
 */
const PHOTO_AREA = { x: 0.02, y: 0.22, width: 0.96, height: 0.76 };

/**
 * Folga dos layouts dentro da área. Com a área ocupando quase a tela toda, os
 * presets no tamanho natural já entregam foto grande — passar de 1 fazia o
 * slide solo estourar a largura e comer a moldura branca.
 */
const SLOT_SAFETY = 1;

function loadImageElement(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Falha ao carregar ${src}`));
    img.src = src;
  });
}

/** Desenha a arte cobrindo a tela inteira (recorta o excedente, sem deformar). */
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  width: number,
  height: number,
) {
  const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
}

function createPhotoLayer(width: number, height: number) {
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  return layer;
}

/** Compõe uma camada de fotos escalada a partir do centro, com opacidade. */
function drawLayerScaled(
  ctx: CanvasRenderingContext2D,
  layer: HTMLCanvasElement,
  width: number,
  height: number,
  scale: number,
  alpha: number,
) {
  if (alpha <= 0.001) return;
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.translate(width / 2, height / 2);
  ctx.scale(scale, scale);
  ctx.translate(-width / 2, -height / 2);
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

async function createBackdropLayer(width: number, height: number) {
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const lctx = layer.getContext("2d", { alpha: false });
  if (!lctx) return layer;

  try {
    const art = await loadImageElement(BACKGROUND_URL);
    lctx.imageSmoothingEnabled = true;
    lctx.imageSmoothingQuality = "high";
    drawCover(lctx, art, width, height);
  } catch {
    drawVolleyCourt(lctx, width, height, 0.35);
  }
  return layer;
}

/**
 * Desenha **só** as fotos, em canvas transparente.
 *
 * O fundo fica de fora de propósito: é ele que dá a identidade da peça e não
 * pode balançar junto com as transições. A arte é desenhada uma vez por frame,
 * sem transformação, e esta camada é a única que se mexe.
 */
function drawPhotoLayer(
  ctx: CanvasRenderingContext2D,
  shot: PlannedShot,
  width: number,
  height: number,
  t: number,
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // Os layouts são desenhados em espaço 0–1 e mapeados pra área útil da arte.
  const areaX = PHOTO_AREA.x * width;
  const areaY = PHOTO_AREA.y * height;
  const areaW = PHOTO_AREA.width * width;
  const areaH = PHOTO_AREA.height * height;

  const group = shot.clips.slice(0, 4);
  const slots = collageSlots(group.length, shot.layoutVariant);
  // Só entra uma vez — saída fica a cargo da transição entre slides
  const enterWindow = 0.28;
  const stagger = group.length <= 2 ? 0.07 : 0.05;
  const appearDur = 0.16;

  for (let i = 0; i < group.length; i += 1) {
    const slot = slots[i];
    const clip = group[i];
    const motion = shot.motions[i] ?? MOTION_CYCLE[i % MOTION_CYCLE.length];
    const cellW = slot.w * areaW;
    const cellH = slot.h * areaH;

    /**
     * A foto é dimensionada pelo que sobra da célula **depois** de descontar a
     * moldura polaroid e o crescimento do giro. Assim a caixa girada cabe
     * inteira na célula, e como as células não se cruzam, nenhuma foto cobre a
     * outra — antes a de cima escondia o rosto de quem estava embaixo.
     */
    const rad = ((Math.abs(slot.rot) + 1) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // pad ≈ 4% do menor lado, e a aba de baixo vale 3.4 pads no total.
    const padRatio = 0.04;
    const growW = (1 + 2 * padRatio) * cos + (1 + 3.4 * padRatio) * sin;
    const growH = (1 + 2 * padRatio) * sin + (1 + 3.4 * padRatio) * cos;

    const { w, h, landscape } = frameSizeForPhoto(
      clip.image,
      (cellW / growW) * SLOT_SAFETY,
      (cellH / growH) * SLOT_SAFETY,
    );

    const pad = Math.min(w, h) * padRatio;
    // Centro da célula, com a aba branca de baixo compensada.
    const x = areaX + slot.x * areaW + (cellW - w) / 2;
    const y = areaY + slot.y * areaH + (cellH - h) / 2 - pad * 0.7;

    const enter = easeOutCubic(clamp((t / enterWindow - i * stagger) / appearDur, 0, 1));
    if (enter <= 0.01) continue;

    const dir = i % 2 === 0 ? 1 : -1;
    const fromX = (i % 2 === 0 ? -1 : 1) * areaW * 0.16;
    const fromY = (i < group.length / 2 ? -1 : 1) * areaH * 0.12;
    const slideIn = 1 - enter;
    const driftX = Math.sin((t * 1.2 + i * 0.45) * Math.PI) * areaW * 0.005;
    const driftY = Math.cos((t * 1.15 + i * 0.37) * Math.PI) * areaH * 0.005;

    drawPinnedPhoto(
      ctx,
      clip,
      x + fromX * slideIn + driftX,
      y + fromY * slideIn + driftY,
      w,
      h,
      slot.rot + dir * t * 1.1,
      enter,
      t,
      motion,
      dir,
      landscape,
    );
  }
}

function uniqueClips(clips: VideoClip[]): VideoClip[] {
  const unique: VideoClip[] = [];
  const seen = new Set<string>();
  for (const clip of clips) {
    if (seen.has(clip.key)) continue;
    seen.add(clip.key);
    unique.push(clip);
  }
  return unique;
}

function pickSoloIndex(clips: VideoClip[]): number {
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < clips.length; i += 1) {
    const face = clips[i].face;
    const span = faceSpan(face);
    const score = face ? span * 2 : 0.05;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Duração máxima do vídeo (hard cap). */
export const MAX_VIDEO_SEC = 58;
/** Teto por slide — acima disso a foto "congela" na tela. */
const MAX_SLIDE_SEC = 5.2;
/** Fade final. Casa com o da trilha, então imagem e som apagam juntos. */
const FADE_OUT_SEC = 1.2;
/** Abertura: só a arte entrando, sem texto por cima. */
const INTRO_SEC = 0.55;
/**
 * Encerramento. Precisa ser bem maior que `FADE_OUT_SEC`: são cinco linhas de
 * texto, e com a cartela curta a mensagem nascia dentro do fade.
 */
const OUTRO_SEC = 5;

/**
 * Calcula quantas fotos por slide a partir de N fotos e do tempo de corpo,
 * pra caber em ≤58s com ~12–15 slides em álbuns ~40 fotos (não 4 estáticas sempre).
 */
export function planGroupSizes(photoCount: number, bodySec: number): number[] {
  const n = Math.max(1, photoCount);
  const minSlideSec = 2.15;
  const maxSlideSec = MAX_SLIDE_SEC;
  const minSlides = Math.ceil(n / 4);
  const maxSlides = Math.min(n, Math.max(minSlides, Math.floor(bodySec / minSlideSec)));

  // Alvo: ~2.7–3.1 fotos/slide → 40 fotos ≈ 13–15 slides
  let slides = Math.round(n / 2.9);
  slides = clamp(slides, minSlides, maxSlides);

  // Se o slide ficaria longo demais, abre mais — mas evita “1 foto por slide” em álbum pequeno
  if (bodySec / slides > maxSlideSec && slides < maxSlides) {
    const byTime = Math.ceil(bodySec / maxSlideSec);
    const pairCap = Math.max(minSlides, Math.ceil(n / 2));
    slides = Math.min(maxSlides, Math.max(slides, Math.min(byTime, pairCap)));
  }

  const sizes: number[] = [];
  let left = n;
  for (let i = 0; i < slides; i += 1) {
    const slotsLeft = slides - i;
    const maxTake = Math.min(4, left - (slotsLeft - 1));
    const minTake = Math.max(1, left - (slotsLeft - 1) * 4);
    const avgNeeded = left / slotsLeft;

    let take = SIZE_CYCLE[i % SIZE_CYCLE.length];
    if (avgNeeded >= 3.3) take = Math.max(take, 3);
    else if (avgNeeded >= 2.6) take = Math.max(take, 2);
    if (avgNeeded <= 1.6) take = Math.min(take, 2);
    if (slides > Math.round(n / 2.5)) take = Math.max(take, Math.round(avgNeeded));

    take = clamp(take, minTake, maxTake);
    sizes.push(take);
    left -= take;
  }

  if (left !== 0) {
    for (let i = 0; left !== 0 && i < sizes.length * 4; i += 1) {
      const idx = i % sizes.length;
      if (left > 0 && sizes[idx] < 4) {
        sizes[idx] += 1;
        left -= 1;
      } else if (left < 0 && sizes[idx] > 1) {
        sizes[idx] -= 1;
        left += 1;
      }
    }
  }

  return sizes.filter((s) => s > 0);
}

/**
 * Tempo relativo do slide. Cresce com o nº de fotos (uma colagem de 4 precisa
 * de mais tela que um solo), mas sublinear pra colagem não engolir o vídeo.
 * Solo ganha bônus de destaque.
 */
function shotWeight(photoCount: number) {
  const n = clamp(photoCount, 1, 4);
  if (n === 1) return 1.3;
  return 1 + (n - 1) * 0.55;
}

/**
 * Rede de segurança contra foto repetida: nenhuma pode aparecer em dois slides.
 * Slide que fique vazio depois da limpeza sai da lista.
 */
function dropRepeatedClips(shots: PlannedShot[]): PlannedShot[] {
  const seen = new Set<string>();
  const out: PlannedShot[] = [];
  for (const shot of shots) {
    const clips: VideoClip[] = [];
    for (const clip of shot.clips.slice(0, 4)) {
      if (seen.has(clip.key)) continue;
      seen.add(clip.key);
      clips.push(clip);
    }
    if (clips.length === 0) continue;
    out.push({
      ...shot,
      clips,
      clip: clips[0],
      motions: clips.map((_, i) => shot.motions[i] ?? MOTION_CYCLE[i % MOTION_CYCLE.length]),
      weight: shotWeight(clips.length),
    });
  }
  return out;
}

function planShots(clips: VideoClip[], bodySec: number): PlannedShot[] {
  const remaining = uniqueClips(clips);
  if (remaining.length === 0) return [];

  const groupSizes = planGroupSizes(remaining.length, bodySec);
  const shots: PlannedShot[] = [];
  const dirs = [
    { x: 1, y: 0.35 },
    { x: -1, y: 0.25 },
    { x: 0.7, y: -0.45 },
    { x: -0.65, y: 0.5 },
    { x: 1, y: -0.2 },
    { x: -0.8, y: -0.35 },
  ];

  for (let s = 0; s < groupSizes.length; s += 1) {
    const want = Math.min(groupSizes[s], remaining.length);
    if (want <= 0) break;

    let group: VideoClip[];
    if (want === 1) {
      const idx = pickSoloIndex(remaining);
      group = remaining.splice(idx, 1);
    } else {
      group = remaining.splice(0, want);
    }

    const dir = dirs[s % dirs.length];
    const n = group.length;
    const weight = shotWeight(n);
    const motions = group.map((_, i) => {
      if (n === 1 && group[0].face) return "pushIn" as PinMotion;
      return MOTION_CYCLE[(s * 3 + i) % MOTION_CYCLE.length];
    });

    shots.push({
      kind: "collage",
      clip: group[0],
      clips: group,
      subject: classifySubject(group[0].face),
      transition: TRANSITIONS[s % TRANSITIONS.length],
      layoutVariant: s,
      motions,
      dirX: dir.x,
      dirY: dir.y,
      weight,
    });
  }

  // Fotos que sobraram (não deveria) — empurra no último slide até 4
  while (remaining.length > 0 && shots.length > 0) {
    const last = shots[shots.length - 1];
    if (last.clips.length >= 4) {
      const extra = remaining.splice(0, Math.min(4, remaining.length));
      shots.push({
        ...last,
        clip: extra[0],
        clips: extra,
        layoutVariant: shots.length,
        motions: extra.map((_, i) => MOTION_CYCLE[i % MOTION_CYCLE.length]),
        transition: TRANSITIONS[shots.length % TRANSITIONS.length],
        weight: shotWeight(extra.length),
      });
    } else {
      last.clips.push(remaining.shift()!);
      last.motions.push(MOTION_CYCLE[last.clips.length % MOTION_CYCLE.length]);
      last.weight = shotWeight(last.clips.length);
    }
  }

  return dropRepeatedClips(shots);
}

/** Lado máximo de cada foto no render — cobre o maior slot com folga de zoom. */
const CLIP_MAX_SIDE = 1180;

async function decodeScaled(
  blob: Blob,
  maxSide: number,
  scratch: HTMLCanvasElement,
): Promise<ClipImage> {
  const source = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  if (scale >= 1) {
    return { source, width: source.width, height: source.height };
  }

  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const ctx = scratch.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas indisponível");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Reduções acima de 2× ficam serrilhadas em um passo só — vai pela metade.
  let currentW = source.width;
  let currentH = source.height;
  let current: CanvasImageSource = source;
  while (currentW > width * 2 && currentH > height * 2) {
    const nextW = Math.max(width, Math.round(currentW / 2));
    const nextH = Math.max(height, Math.round(currentH / 2));
    scratch.width = nextW;
    scratch.height = nextH;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(current, 0, 0, currentW, currentH, 0, 0, nextW, nextH);
    if (current !== source) (current as ImageBitmap).close();
    current = await createImageBitmap(scratch, 0, 0, nextW, nextH);
    currentW = nextW;
    currentH = nextH;
  }

  scratch.width = width;
  scratch.height = height;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(current, 0, 0, currentW, currentH, 0, 0, width, height);
  if (current !== source) (current as ImageBitmap).close();
  source.close();

  const bitmap = await createImageBitmap(scratch, 0, 0, width, height);
  return { source: bitmap, width, height };
}

/**
 * Baixa e reduz as fotos **uma vez** antes do render.
 *
 * O original tem ~13MP; redesenhá-lo 30×/s em quatro pins era o que fazia o
 * vídeo travar e o Safari mobile derrubar a aba. Aqui o pico de memória fica em
 * uma foto decodificada por worker, e o resultado vira ImageBitmap (fora do
 * heap do JS).
 */
export async function prepareClips(
  items: Array<{ key: string; src: string; face?: FaceBox }>,
  options: {
    maxSide?: number;
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<VideoClip[]> {
  const maxSide = options.maxSide ?? CLIP_MAX_SIDE;
  const concurrency = options.concurrency ?? 3;
  const scratch = document.createElement("canvas");
  const signatureCanvas = document.createElement("canvas");

  const prepared = await mapPool<
    { key: string; src: string; face?: FaceBox },
    VideoClip | null
  >(
    items,
    concurrency,
    async (item) => {
      try {
        const res = await fetch(item.src, { mode: "cors", cache: "force-cache" });
        if (!res.ok) return null;
        const image = await decodeScaled(await res.blob(), maxSide, scratch);
        return {
          image,
          face: item.face,
          key: item.key,
          signature: imageSignature(image, signatureCanvas),
        } satisfies VideoClip;
      } catch {
        return null;
      }
    },
    options.onProgress,
  );

  return prepared.filter((clip): clip is VideoClip => clip !== null);
}

const SIGNATURE_SIDE = 32;

/**
 * Assinatura visual: a foto reduzida a 32x32 em tons de cinza.
 *
 * Sai de graça — a imagem já está decodificada aqui — e é o bastante pra
 * reconhecer duas fotos da mesma cena, que é o que o olho lê como repetida.
 */
function imageSignature(image: ClipImage, scratch: HTMLCanvasElement) {
  scratch.width = SIGNATURE_SIDE;
  scratch.height = SIGNATURE_SIDE;
  const ctx = scratch.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "low";
  ctx.drawImage(image.source, 0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE);

  const { data } = ctx.getImageData(0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE);
  const out = new Float32Array(SIGNATURE_SIDE * SIGNATURE_SIDE);
  for (let i = 0; i < out.length; i += 1) {
    const p = i * 4;
    out[i] = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
  }

  /**
   * Normaliza pra média 0 e desvio 1. Sem isso o brilho domina a conta: duas
   * fotos da mesma cena com exposições diferentes ficavam tão distantes quanto
   * duas cenas distintas.
   */
  let mean = 0;
  for (const v of out) mean += v;
  mean /= out.length;
  let sd = 0;
  for (const v of out) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / out.length) || 1;
  for (let i = 0; i < out.length; i += 1) out[i] = (out[i] - mean) / sd;

  return out;
}

/** 0 = mesma imagem, 1 = sem relação. Correlação entre assinaturas. */
function signatureDistance(a: Float32Array, b: Float32Array) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return 1 - dot / a.length;
}

/**
 * Limiar calibrado no álbum, comparando rajadas (mesma cena garantida) com
 * pares aleatórios: em 0.35 pega 60% das repetidas sem descartar **nenhuma**
 * foto distinta. Subir daqui começa a jogar fora foto boa.
 */
const SIMILAR_MAX_DISTANCE = 0.35;

/**
 * Descarta fotos visualmente parecidas, mantendo a primeira de cada grupo.
 *
 * A limpeza por horário do arquivo pega a rajada de câmera, mas não a mesma
 * cena fotografada com alguns segundos de diferença — e no vídeo essas leem
 * como foto repetida. `clips` já deve vir na ordem de preferência.
 */
export function dropSimilarClips(clips: VideoClip[]): VideoClip[] {
  const kept: VideoClip[] = [];
  for (const clip of clips) {
    if (!clip.signature) {
      kept.push(clip);
      continue;
    }
    const duplicate = kept.some(
      (other) =>
        other.signature &&
        signatureDistance(clip.signature!, other.signature) <= SIMILAR_MAX_DISTANCE,
    );
    if (!duplicate) kept.push(clip);
  }
  return kept;
}

/** Libera os ImageBitmap do render (senão ficam presos até o GC). */
export function releaseClips(clips: VideoClip[]) {
  for (const clip of clips) {
    const source = clip.image.source;
    if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
      source.close();
    }
  }
}

/**
 * Reparte `total` frames entre os slides pelos pesos, garantindo soma exata
 * (maior resto). Sem isso o vídeo fecha alguns frames curto ou longo demais.
 */
function splitFrames(weights: number[], total: number, minPerSlide: number) {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const exact = weights.map((w) => (w / sum) * total);
  const counts = exact.map((n) => Math.max(minPerSlide, Math.floor(n)));

  let drift = total - counts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((n, i) => ({ i, frac: n - Math.floor(n) }))
    .sort((a, b) => b.frac - a.frac);

  for (let k = 0; drift > 0 && order.length > 0; k += 1) {
    counts[order[k % order.length].i] += 1;
    drift -= 1;
  }
  for (let k = 0; drift < 0; k += 1) {
    const idx = order[k % order.length].i;
    if (counts[idx] > minPerSlide) {
      counts[idx] -= 1;
      drift += 1;
    } else if (k > order.length * 4) {
      break;
    }
  }

  return counts;
}

export async function renderAnniversaryVideo({
  clips,
  width = 1080,
  height = 1920,
  fps = 30,
  durationSec = MAX_VIDEO_SEC,
  musicUrl = DEFAULT_MUSIC_URL,
  onProgress,
}: RenderVideoOptions): Promise<RenderOutput> {
  if (clips.length === 0) throw new Error("Nenhuma foto para animar");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas não disponível");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";

  const backdrop = await createBackdropLayer(width, height);

  // Camadas transparentes só com as fotos: a arte nunca entra nas transições.
  const current = createPhotoLayer(width, height);
  const incoming = createPhotoLayer(width, height);
  const currentCtx = current.getContext("2d");
  const incomingCtx = incoming.getContext("2d");
  if (!currentCtx || !incomingCtx) throw new Error("Canvas não disponível");

  /**
   * Orçamento de frames fechado antes de desenhar qualquer coisa: o vídeo tem
   * exatamente `totalFrames` frames a 1/fps cada, então dura o que promete —
   * independente de quanto cada frame custa pra desenhar.
   */
  const totalFrames = Math.round(Math.min(durationSec, MAX_VIDEO_SEC) * fps);
  const introFrames = Math.max(4, Math.round(fps * INTRO_SEC));
  const outroFrames = Math.max(
    Math.round(fps * (FADE_OUT_SEC + 0.8)),
    Math.round(fps * OUTRO_SEC),
  );
  const bodyFrames = Math.max(fps, totalFrames - introFrames - outroFrames);
  const bodySec = bodyFrames / fps;

  const shots = planShots(clips, bodySec);
  if (shots.length === 0) throw new Error("Nenhuma foto para animar");

  /**
   * Álbum pequeno encurta o vídeo em vez de esticar o slide. Segurar 8 fotos
   * por 58s daria ~13s por slide — cansativo. O cap de 58s continua valendo.
   */
  const pacedBodyFrames = Math.min(
    bodyFrames,
    Math.round(shots.length * MAX_SLIDE_SEC * fps),
  );

  const minSlideFrames = Math.max(8, Math.round(fps * 1.2));
  const slideFrameCounts = splitFrames(
    shots.map((s) => s.weight),
    pacedBodyFrames,
    Math.min(minSlideFrames, Math.floor(pacedBodyFrames / shots.length)),
  );

  const sinkFrames =
    introFrames + slideFrameCounts.reduce((a, b) => a + b, 0) + outroFrames;

  const totalFramesFinal =
    introFrames + slideFrameCounts.reduce((a, b) => a + b, 0) + outroFrames;

  const fadeOutFrames = Math.min(
    Math.round(fps * FADE_OUT_SEC),
    Math.max(1, Math.floor(totalFramesFinal / 3)),
  );

  let frame = 0;
  /** Recebe o sink por parâmetro: a tentativa pode ser refeita com outro. */
  const makeCommit = (sink: FrameSink) => async () => {
    // Apaga no fim junto com a música, em vez de cortar seco no último frame.
    const remaining = totalFramesFinal - frame;
    if (remaining <= fadeOutFrames) {
      const k = 1 - remaining / fadeOutFrames;
      ctx.save();
      ctx.globalAlpha = clamp(easeInOutCubic(k), 0, 1);
      ctx.fillStyle = "#050f28";
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
    await sink.addFrame(frame);
    frame += 1;
    onProgress?.(Math.min(0.97, (frame / totalFramesFinal) * 0.97));
  };

  const renderWith = async (sink: FrameSink) => {
  const commitFrame = makeCommit(sink);
  try {
    for (let i = 0; i < introFrames; i += 1) {
      const t = i / (introFrames - 1 || 1);
      drawArtCard(ctx, backdrop, width, height, t, []);
      if (t < 0.08) drawFlash(ctx, width, height, 0.22 * (1 - t / 0.08));
      await commitFrame();
    }

    for (let s = 0; s < shots.length; s += 1) {
      const shot = shots[s];
      const next = shots[s + 1];
      const slideFrames = slideFrameCounts[s];
      const transitionFrames = next
        ? Math.min(Math.round(fps * 0.5), Math.max(6, Math.floor(slideFrames * 0.2)))
        : 0;
      const bodyFramesShot = slideFrames - transitionFrames;
      // Depois da transição o próximo slide já entrou — não reinicia enter (t≥0.4)
      const enteredT = 0.4;
      const tStart = s === 0 ? 0 : enteredT;

      for (let i = 0; i < bodyFramesShot; i += 1) {
        const u = i / (bodyFramesShot - 1 || 1);
        const t = tStart + (1 - tStart) * u;
        drawPhotoLayer(currentCtx, shot, width, height, t);
        ctx.drawImage(backdrop, 0, 0);
        ctx.drawImage(current, 0, 0);
        await commitFrame();
      }

      if (next && transitionFrames > 0) {
        /**
         * O próximo slide entra "cheio" e não muda durante a transição, então a
         * camada dele é desenhada uma vez só. `current` já tem o slide que está
         * saindo, no último estado.
         */
        drawPhotoLayer(incomingCtx, next, width, height, enteredT);

        for (let i = 0; i < transitionFrames; i += 1) {
          const tp = i / (transitionFrames - 1 || 1);
          const e = easeInOutCubic(tp);

          // A arte é redesenhada sem transformação: quem se mexe são as fotos.
          ctx.drawImage(backdrop, 0, 0);

          if (shot.transition === "whip" || shot.transition === "whipV") {
            const vertical = shot.transition === "whipV";
            const travel = vertical ? height : width;
            ctx.drawImage(
              current,
              vertical ? 0 : -travel * e,
              vertical ? -travel * e : 0,
            );
            ctx.drawImage(
              incoming,
              vertical ? 0 : travel * (1 - e),
              vertical ? travel * (1 - e) : 0,
            );
          } else if (shot.transition === "zoom" || shot.transition === "softZoom") {
            const outScale = shot.transition === "softZoom" ? 1 + e * 0.12 : 1 + e * 0.2;
            const inScale =
              shot.transition === "softZoom" ? 0.92 + e * 0.08 : 0.85 + e * 0.15;
            drawLayerScaled(ctx, current, width, height, outScale, 1 - e);
            drawLayerScaled(ctx, incoming, width, height, inScale, e);
          } else if (shot.transition === "crossBlur") {
            const smear = Math.sin(e * Math.PI);
            ctx.save();
            ctx.globalAlpha = 1 - e;
            ctx.drawImage(current, 0, 0);
            ctx.globalAlpha = (1 - e) * 0.25 * smear;
            for (let k = 1; k <= 3; k += 1) {
              ctx.drawImage(current, k * 7 * smear, k * 4 * smear);
              ctx.drawImage(current, -k * 7 * smear, -k * 3 * smear);
            }
            ctx.restore();
            ctx.save();
            ctx.globalAlpha = e;
            ctx.drawImage(incoming, 0, 0);
            ctx.restore();
          } else {
            ctx.save();
            ctx.globalAlpha = 1 - easeInOut(tp);
            ctx.drawImage(current, 0, 0);
            ctx.globalAlpha = easeInOut(tp);
            ctx.drawImage(incoming, 0, 0);
            ctx.restore();
          }

          await commitFrame();
        }
      }
    }

    for (let i = 0; i < outroFrames; i += 1) {
      const t = i / (outroFrames - 1 || 1);
      drawArtCard(ctx, backdrop, width, height, t, OUTRO_LINES);
      await commitFrame();
    }
  } catch (err) {
    sink.abort();
    throw err;
  }

  onProgress?.(0.98);
  await yieldToUi();
  return sink.finish();
  };

  const attempt = async (forceRealtime: boolean) => {
    frame = 0;
    const sink = await createFrameSink({
      canvas,
      width,
      height,
      fps,
      totalFrames: sinkFrames,
      musicUrl,
      forceRealtime,
    });
    const blob = await renderWith(sink);
    return { blob, sink };
  };

  let { blob, sink } = await attempt(false);
  let audioSamples = await countAudioInBlob(blob);
  let peak = await measureAudioPeak(blob);

  /**
   * Arquivo mudo não levanta erro em lugar nenhum: encoder que falha por
   * callback, faixa vazia no muxer ou PCM entregue no layout errado passam
   * batido, e só quem assiste percebe. Confirmado o silêncio, refaz pela via
   * nativa do navegador.
   */
  const silent = peak !== null ? peak <= 0.01 : audioSamples === 0;
  if (sink.offline && silent) {
    onProgress?.(0.3);
    ({ blob, sink } = await attempt(true));
    audioSamples = await countAudioInBlob(blob);
    peak = await measureAudioPeak(blob);
  }

  onProgress?.(1);

  const audioNote =
    peak !== null
      ? peak > 0.01
        ? `som ok (pico ${peak.toFixed(2)})`
        : "faixa muda"
      : audioSamples === null
        ? "áudio não verificado"
        : audioSamples > 0
          ? `${audioSamples} amostras`
          : "sem faixa de áudio";

  const notes = sink.notes?.();
  return {
    blob,
    extension: sink.extension,
    diagnostics: [sink.label, notes, audioNote].filter(Boolean).join(" · "),
  };
}

/** O `moov` vem no início (fastStart), então o começo do arquivo basta. */
async function countAudioInBlob(blob: Blob) {
  if (!blob.type.includes("mp4")) return null;
  try {
    const head = await blob.slice(0, 4_000_000).arrayBuffer();
    const fromHead = countAudioSamples(head);
    if (fromHead !== null) return fromHead;
    return countAudioSamples(await blob.arrayBuffer());
  } catch {
    return null;
  }
}
