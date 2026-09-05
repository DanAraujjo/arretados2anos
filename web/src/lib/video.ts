import type { FaceBox } from "@/lib/types";

export type VideoClip = {
  image: HTMLImageElement;
  face?: FaceBox;
};

export type RenderVideoOptions = {
  clips: VideoClip[];
  title?: string;
  subtitle?: string;
  width?: number;
  height?: number;
  fps?: number;
  durationSec?: number;
  bpm?: number;
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

function easeOutBack(t: number) {
  const c = 1.70158;
  const x = t - 1;
  return 1 + c * x * x * x + c * x * x;
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

/** Max approach to face — moderate, never crop facial features tightly. */
function maxFraming(subject: SubjectKind, face?: FaceBox) {
  const span = faceSpan(face);
  if (subject === "group") return 0.28;
  if (subject === "portrait") return clamp(0.42 + (0.22 - span) * 0.6, 0.38, 0.58);
  return 0.45;
}

function softApproach(t: number, hold: number, max: number) {
  // Quase sem “freeze” no início — já começa a mover
  const h = Math.min(hold, 0.06);
  if (t <= h) return max * 0.06 * (t / (h || 1));
  return max * 0.06 + easeInOutCubic((t - h) / (1 - h)) * (max * 0.94);
}

function isLandscapeImage(img: HTMLImageElement) {
  return img.naturalWidth > img.naturalHeight * 1.08;
}

/** Soft dimmed cover fill behind letterboxed landscape shots (no blur — blur was killing render pace). */
function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
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
  ctx.drawImage(img, bx, by, bw, bh);
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
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  face: FaceBox | undefined,
  framing: number,
  _zoom = 1,
  panX = 0,
  panY = 0,
) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
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
  ctx.drawImage(img, dx + x, dy + y, drawW, drawH);
  ctx.restore();
}

function drawFlash(ctx: CanvasRenderingContext2D, width: number, height: number, alpha: number) {
  if (alpha <= 0) return;
  ctx.fillStyle = `rgba(255,255,255,${clamp(alpha, 0, 1)})`;
  ctx.fillRect(0, 0, width, height);
}

function drawVignette(ctx: CanvasRenderingContext2D, width: number, height: number) {
  // Leve e barato (sem radial grande todo frame)
  ctx.fillStyle = "rgba(4,12,32,0.22)";
  ctx.fillRect(0, 0, width, height * 0.12);
  ctx.fillRect(0, height * 0.88, width, height * 0.12);
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

function drawChrome(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  logo: HTMLImageElement | null,
) {
  const veil = ctx.createLinearGradient(0, height * 0.72, 0, height);
  veil.addColorStop(0, "rgba(6,20,51,0)");
  veil.addColorStop(1, "rgba(6,20,51,0.42)");
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, width, height);

  // Watermark — bottom left: logo + 2 ANOS + 🥳
  const pad = Math.floor(width * 0.045);
  const logoSize = Math.floor(width * 0.11);
  const barH = Math.floor(logoSize * 1.15);
  const textSize = Math.floor(width * 0.055);
  const emojiSize = Math.floor(width * 0.065);
  const gap = Math.floor(width * 0.022);
  const inset = Math.floor(barH * 0.08);

  ctx.font = `700 ${textSize}px Bebas Neue, Impact, sans-serif`;
  const textW = ctx.measureText("2 ANOS").width;
  ctx.font = `${emojiSize}px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif`;
  const emojiW = Math.max(emojiSize, ctx.measureText("🥳").width);
  const barW = inset + logoSize + gap + textW + gap + emojiW + inset;
  const barX = pad;
  const barY = height - pad - barH;

  ctx.save();
  ctx.globalAlpha = 0.92;

  ctx.fillStyle = "rgba(5,15,40,0.55)";
  const r = barH / 2;
  ctx.beginPath();
  ctx.moveTo(barX + r, barY);
  ctx.arcTo(barX + barW, barY, barX + barW, barY + barH, r);
  ctx.arcTo(barX + barW, barY + barH, barX, barY + barH, r);
  ctx.arcTo(barX, barY + barH, barX, barY, r);
  ctx.arcTo(barX, barY, barX + barW, barY, r);
  ctx.closePath();
  ctx.fill();

  const logoX = barX + inset;
  const logoY = barY + (barH - logoSize) / 2;
  if (logo) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(logoX + logoSize / 2, logoY + logoSize / 2, logoSize / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
    ctx.restore();
    ctx.strokeStyle = "rgba(240,180,41,0.7)";
    ctx.lineWidth = Math.max(2, width * 0.003);
    ctx.beginPath();
    ctx.arc(logoX + logoSize / 2, logoY + logoSize / 2, logoSize / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();
  }

  const textX = logoX + logoSize + gap;
  ctx.fillStyle = "#f7f4ee";
  ctx.font = `700 ${textSize}px Bebas Neue, Impact, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("2 ANOS", textX, barY + barH / 2 + textSize * 0.04);

  ctx.font = `${emojiSize}px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif`;
  ctx.fillText("🥳", textX + textW + gap, barY + barH / 2);

  ctx.restore();
}

function drawTitleCard(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  title: string,
  subtitle: string,
  logo: HTMLImageElement | null,
  t: number,
  beatPulse: number,
) {
  const g = ctx.createLinearGradient(0, 0, width, height);
  g.addColorStop(0, "#07183f");
  g.addColorStop(0.45, "#12306a");
  g.addColorStop(1, "#1a6b8a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
  drawLightSweep(ctx, width, height, (t * 0.8 + beatPulse * 0.15) % 1);

  const pop = 0.9 + easeOutCubic(Math.min(1, t * 2.2)) * 0.12 + beatPulse * 0.02;
  if (logo) {
    const size = Math.floor(width * 0.42 * pop);
    const x = (width - size) / 2;
    const y = height * 0.18;
    ctx.save();
    ctx.beginPath();
    ctx.arc(width / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(logo, x, y, size, size);
    ctx.restore();
  }

  ctx.save();
  ctx.translate(width / 2, height * 0.72);
  ctx.scale(pop, pop);
  ctx.fillStyle = "#f7f4ee";
  ctx.font = `700 ${Math.floor(width * 0.14)}px Bebas Neue, Impact, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(title, 0, 0);
  ctx.restore();

  if (subtitle) {
    ctx.fillStyle = "rgba(247,244,238,0.85)";
    ctx.font = `700 ${Math.floor(width * 0.065)}px Bebas Neue, Impact, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(subtitle, width / 2, height * 0.8);
  }
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

type PinSlot = {
  cx: number;
  cy: number;
  maxW: number;
  maxH: number;
  rot: number;
};

function collageSlots(count: number, variant: number): PinSlot[] {
  const presets: PinSlot[][][] = [
    [
      [{ cx: 0.5, cy: 0.48, maxW: 0.88, maxH: 0.64, rot: -1.5 }],
      [{ cx: 0.5, cy: 0.46, maxW: 0.8, maxH: 0.72, rot: 2 }],
    ],
    [
      [
        { cx: 0.28, cy: 0.42, maxW: 0.52, maxH: 0.56, rot: -3.5 },
        { cx: 0.72, cy: 0.56, maxW: 0.5, maxH: 0.5, rot: 2.8 },
      ],
      [
        { cx: 0.5, cy: 0.28, maxW: 0.78, maxH: 0.38, rot: -2 },
        { cx: 0.5, cy: 0.7, maxW: 0.78, maxH: 0.38, rot: 2 },
      ],
      [
        { cx: 0.34, cy: 0.48, maxW: 0.62, maxH: 0.64, rot: -3 },
        { cx: 0.74, cy: 0.5, maxW: 0.46, maxH: 0.46, rot: 3.5 },
      ],
    ],
    [
      [
        { cx: 0.5, cy: 0.26, maxW: 0.78, maxH: 0.36, rot: -2 },
        { cx: 0.28, cy: 0.68, maxW: 0.46, maxH: 0.38, rot: 2.2 },
        { cx: 0.72, cy: 0.68, maxW: 0.46, maxH: 0.38, rot: -2.2 },
      ],
      [
        { cx: 0.3, cy: 0.4, maxW: 0.52, maxH: 0.58, rot: -3 },
        { cx: 0.74, cy: 0.28, maxW: 0.42, maxH: 0.34, rot: 2.5 },
        { cx: 0.74, cy: 0.68, maxW: 0.42, maxH: 0.36, rot: -2 },
      ],
      [
        { cx: 0.26, cy: 0.32, maxW: 0.44, maxH: 0.4, rot: -3 },
        { cx: 0.7, cy: 0.36, maxW: 0.5, maxH: 0.42, rot: 2 },
        { cx: 0.5, cy: 0.72, maxW: 0.7, maxH: 0.34, rot: -1.5 },
      ],
    ],
    [
      [
        { cx: 0.27, cy: 0.3, maxW: 0.48, maxH: 0.38, rot: -3 },
        { cx: 0.73, cy: 0.28, maxW: 0.44, maxH: 0.34, rot: 2.5 },
        { cx: 0.3, cy: 0.7, maxW: 0.44, maxH: 0.34, rot: 2 },
        { cx: 0.72, cy: 0.68, maxW: 0.48, maxH: 0.38, rot: -2.2 },
      ],
      [
        { cx: 0.36, cy: 0.42, maxW: 0.64, maxH: 0.58, rot: -2 },
        { cx: 0.82, cy: 0.22, maxW: 0.3, maxH: 0.24, rot: 3 },
        { cx: 0.82, cy: 0.48, maxW: 0.3, maxH: 0.24, rot: -2 },
        { cx: 0.82, cy: 0.74, maxW: 0.3, maxH: 0.24, rot: 2.2 },
      ],
      [
        { cx: 0.3, cy: 0.26, maxW: 0.52, maxH: 0.34, rot: -3.5 },
        { cx: 0.7, cy: 0.38, maxW: 0.5, maxH: 0.34, rot: 2.8 },
        { cx: 0.28, cy: 0.62, maxW: 0.48, maxH: 0.34, rot: 2 },
        { cx: 0.7, cy: 0.74, maxW: 0.5, maxH: 0.32, rot: -2 },
      ],
    ],
  ];
  const forCount = presets[clamp(count, 1, 4) - 1];
  return forCount[variant % forCount.length];
}

function frameSizeForPhoto(
  img: HTMLImageElement,
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
  drawFramed(ctx, clip.image, x, y, w, h, clip.face, m.framing, 1, m.panX, m.panY);
  ctx.restore();
}

function createCourtLayer(width: number, height: number) {
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const lctx = layer.getContext("2d");
  if (lctx) drawVolleyCourt(lctx, width, height, 0.35);
  return layer;
}

function drawCollageMural(
  ctx: CanvasRenderingContext2D,
  shot: PlannedShot,
  width: number,
  height: number,
  t: number,
  courtLayer?: HTMLCanvasElement | null,
) {
  if (courtLayer) ctx.drawImage(courtLayer, 0, 0);
  else drawVolleyCourt(ctx, width, height, t);

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
    const { w, h, landscape } = frameSizeForPhoto(
      clip.image,
      slot.maxW * width,
      slot.maxH * height,
    );
    const x = slot.cx * width - w / 2;
    const y = slot.cy * height - h / 2;

    const enter = easeOutCubic(clamp((t / enterWindow - i * stagger) / appearDur, 0, 1));
    if (enter <= 0.01) continue;

    const dir = i % 2 === 0 ? 1 : -1;
    const fromX = (i % 2 === 0 ? -1 : 1) * width * 0.14;
    const fromY = (i < group.length / 2 ? -1 : 1) * height * 0.09;
    const slideIn = 1 - enter;
    const driftX = Math.sin((t * 1.2 + i * 0.45) * Math.PI) * width * 0.005;
    const driftY = Math.cos((t * 1.15 + i * 0.37) * Math.PI) * height * 0.004;

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

function drawShotContent(
  ctx: CanvasRenderingContext2D,
  shot: PlannedShot,
  t: number,
  width: number,
  height: number,
  courtLayer?: HTMLCanvasElement | null,
) {
  drawCollageMural(ctx, shot, width, height, t, courtLayer);
}

function uniqueClips(clips: VideoClip[]): VideoClip[] {
  const unique: VideoClip[] = [];
  const seen = new Set<string>();
  for (const clip of clips) {
    const key =
      clip.image.src ||
      `${clip.image.naturalWidth}x${clip.image.naturalHeight}:${unique.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
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

/**
 * Calcula quantas fotos por slide a partir de N fotos e do tempo de corpo,
 * pra caber em ≤58s com ~12–15 slides em álbuns ~40 fotos (não 4 estáticas sempre).
 */
export function planGroupSizes(photoCount: number, bodySec: number): number[] {
  const n = Math.max(1, photoCount);
  const minSlideSec = 2.15;
  const maxSlideSec = 5.2;
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
    let want = Math.min(groupSizes[s], remaining.length);
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
    // Peso ~ proporcional às fotos, com leve bônus pra solo (destaque)
    const weight = n === 1 ? 1.25 : n === 2 ? 1.1 : n === 3 ? 1.05 : 1;
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
        weight: extra.length,
      });
    } else {
      last.clips.push(remaining.shift()!);
      last.motions.push(MOTION_CYCLE[last.clips.length % MOTION_CYCLE.length]);
      last.weight = last.clips.length === 1 ? 1.25 : last.clips.length;
    }
  }

  return shots;
}

async function loadMusic(
  audioCtx: AudioContext,
  url: string,
): Promise<{
  dest: MediaStreamAudioDestinationNode;
  master: GainNode;
  stop: () => void;
}> {
  const dest = audioCtx.createMediaStreamDestination();
  const master = audioCtx.createGain();
  master.gain.value = 0.9;
  master.connect(dest);

  const res = await fetch(url);
  if (!res.ok) throw new Error("música");
  const raw = await res.arrayBuffer();
  const buffer = await audioCtx.decodeAudioData(raw.slice(0));
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.connect(master);
  src.start(0);

  return {
    dest,
    master,
    stop: () => {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    },
  };
}

export async function renderAnniversaryVideo({
  clips,
  title = "ARRETADOS",
  subtitle = "2 ANOS",
  width = 720,
  height = 1280,
  fps = 24,
  durationSec = 58,
  bpm = 128,
  musicUrl = "/music/party.mp3",
  onProgress,
}: RenderVideoOptions): Promise<Blob> {
  if (clips.length === 0) throw new Error("Nenhuma foto para animar");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas não disponível");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";

  const courtLayer = createCourtLayer(width, height);
  // Snapshot pra transição barata (evita desenhar 2 murais por frame)
  const snap = document.createElement("canvas");
  snap.width = width;
  snap.height = height;
  const snapCtx = snap.getContext("2d", { alpha: false });
  if (!snapCtx) throw new Error("Canvas não disponível");

  const audioCtx = new AudioContext();
  await audioCtx.resume();
  let music: Awaited<ReturnType<typeof loadMusic>>;
  try {
    music = await loadMusic(audioCtx, musicUrl);
  } catch {
    await audioCtx.close();
    throw new Error("Não deu pra carregar a música de fundo (/music/party.mp3).");
  }

  /**
   * captureStream(0) + requestFrame: cada frame gravado dura ~1/fps,
   * independente do custo do draw (sem acelerar slides leves / travar pesados).
   */
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
    ...music.dest.stream.getAudioTracks(),
  ]);

  const mimeType =
    ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(
      (type) => MediaRecorder.isTypeSupported(type),
    ) ?? "";
  if (!mimeType) {
    music.stop();
    await audioCtx.close();
    throw new Error("Seu navegador não grava vídeo via MediaRecorder");
  }

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(mixed, {
    mimeType,
    videoBitsPerSecond: 5_000_000,
    audioBitsPerSecond: 192_000,
  });
  const done = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = () => reject(new Error("Falha ao gravar vídeo"));
    recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
  });

  let logo: HTMLImageElement | null = null;
  try {
    logo = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("logo"));
      img.src = "/logo.jpg";
    });
  } catch {
    logo = null;
  }

  const beatSec = 60 / bpm;
  const introSec = 0.55;
  const outroSec = 0.55;
  // Hard cap 58s: calcula corpo e distribui slides pela qtd de fotos
  const cappedDuration = Math.min(durationSec, MAX_VIDEO_SEC);
  const bodySec = Math.max(4, cappedDuration - introSec - outroSec);

  const shots = planShots(clips, bodySec);
  if (shots.length === 0) throw new Error("Nenhuma foto para animar");

  const weightSum = shots.reduce((a, s) => a + s.weight, 0) || 1;
  const slideFrameCounts = shots.map((s) =>
    Math.max(12, Math.round(fps * bodySec * (s.weight / weightSum))),
  );
  // Garante soma exata de frames do corpo (= bodySec)
  let plannedBodyFrames = slideFrameCounts.reduce((a, b) => a + b, 0);
  const bodyTarget = Math.round(fps * bodySec);
  if (slideFrameCounts.length > 0 && plannedBodyFrames !== bodyTarget) {
    slideFrameCounts[slideFrameCounts.length - 1] += bodyTarget - plannedBodyFrames;
    plannedBodyFrames = bodyTarget;
  }

  const introFrames = Math.max(4, Math.round(fps * introSec));
  const outroFrames = Math.max(4, Math.round(fps * outroSec));
  const totalFrames = introFrames + plannedBodyFrames + outroFrames;
  // Segurança: nunca passar de MAX_VIDEO_SEC em frames
  const maxTotalFrames = Math.round(MAX_VIDEO_SEC * fps);
  if (totalFrames > maxTotalFrames && plannedBodyFrames > 0) {
    const scale = (maxTotalFrames - introFrames - outroFrames) / plannedBodyFrames;
    for (let i = 0; i < slideFrameCounts.length; i += 1) {
      slideFrameCounts[i] = Math.max(8, Math.round(slideFrameCounts[i] * scale));
    }
  }
  const bodyFramesFinal = slideFrameCounts.reduce((a, b) => a + b, 0);
  const totalFramesFinal = introFrames + bodyFramesFinal + outroFrames;
  const frameDuration = 1000 / fps;

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const renderStarted = performance.now();
  let frame = 0;
  /** Agenda cada frame em t = frame/fps — duração do vídeo fica uniforme. */
  const commitFrame = async () => {
    frame += 1;
    const target = renderStarted + frame * frameDuration;
    const delay = target - performance.now();
    if (delay > 1) await wait(delay);
    else await new Promise<void>((r) => requestAnimationFrame(() => r()));
    requestFrame?.();
    onProgress?.(Math.min(0.99, frame / totalFramesFinal));
  };

  recorder.start(100);

  for (let i = 0; i < introFrames; i += 1) {
    const t = i / (introFrames - 1 || 1);
    const beatPulse = Math.max(0, 1 - (((i / fps) % beatSec) / beatSec) * 5);
    drawTitleCard(ctx, width, height, title, subtitle, logo, t, beatPulse);
    if (t < 0.08) drawFlash(ctx, width, height, 0.22 * (1 - t / 0.08));
    await commitFrame();
  }

  for (let s = 0; s < shots.length; s += 1) {
    const shot = shots[s];
    const next = shots[s + 1];
    const slideFrames = slideFrameCounts[s];
    const transitionFrames = next
      ? Math.min(Math.round(fps * 0.55), Math.max(8, Math.floor(slideFrames * 0.2)))
      : 0;
    const bodyFramesShot = next ? slideFrames - transitionFrames : slideFrames;
    // Depois da transição o próximo slide já entrou — não reinicia enter (t≥0.4)
    const enteredT = 0.4;
    const tStart = s === 0 ? 0 : enteredT;

    for (let i = 0; i < bodyFramesShot; i += 1) {
      const u = i / (bodyFramesShot - 1 || 1);
      const t = tStart + (1 - tStart) * u;
      ctx.fillStyle = "#050f28";
      ctx.fillRect(0, 0, width, height);
      drawShotContent(ctx, shot, t, width, height, courtLayer);
      drawVignette(ctx, width, height);
      drawChrome(ctx, width, height, logo);
      await commitFrame();
    }

    if (next && transitionFrames > 0) {
      snapCtx.drawImage(canvas, 0, 0);

      for (let i = 0; i < transitionFrames; i += 1) {
        const tp = i / (transitionFrames - 1 || 1);
        const e = easeInOutCubic(tp);
        // Próximo mural já “cheio” — só revela via transição, sem re-entrar pins
        const nextT = enteredT;
        ctx.fillStyle = "#050f28";
        ctx.fillRect(0, 0, width, height);

        if (shot.transition === "whip" || shot.transition === "whipV") {
          const vertical = shot.transition === "whipV";
          const travel = vertical ? height : width;
          ctx.drawImage(snap, vertical ? 0 : -travel * e * 0.92, vertical ? -travel * e * 0.92 : 0);
          ctx.save();
          if (vertical) ctx.translate(0, travel * (1 - e));
          else ctx.translate(travel * (1 - e), 0);
          drawShotContent(ctx, next, nextT, width, height, courtLayer);
          drawVignette(ctx, width, height);
          drawChrome(ctx, width, height, logo);
          ctx.restore();
        } else if (shot.transition === "zoom" || shot.transition === "softZoom") {
          const outScale = shot.transition === "softZoom" ? 1 + e * 0.1 : 1 + e * 0.16;
          const inScale = shot.transition === "softZoom" ? 0.94 + e * 0.06 : 0.88 + e * 0.12;
          ctx.save();
          ctx.globalAlpha = 1 - e;
          ctx.translate(width / 2, height / 2);
          ctx.scale(outScale, outScale);
          ctx.translate(-width / 2, -height / 2);
          ctx.drawImage(snap, 0, 0);
          ctx.restore();
          ctx.save();
          ctx.globalAlpha = e;
          ctx.translate(width / 2, height / 2);
          ctx.scale(inScale, inScale);
          ctx.translate(-width / 2, -height / 2);
          drawShotContent(ctx, next, nextT, width, height, courtLayer);
          drawVignette(ctx, width, height);
          drawChrome(ctx, width, height, logo);
          ctx.restore();
        } else if (shot.transition === "crossBlur") {
          ctx.save();
          ctx.globalAlpha = 1 - e;
          ctx.drawImage(snap, 0, 0);
          const smear = Math.sin(e * Math.PI);
          ctx.globalAlpha = 0.22 * smear;
          for (let k = 1; k <= 3; k += 1) {
            ctx.drawImage(snap, k * 6 * smear, k * 3 * smear);
            ctx.drawImage(snap, -k * 6 * smear, -k * 2 * smear);
          }
          ctx.restore();
          ctx.save();
          ctx.globalAlpha = e;
          drawShotContent(ctx, next, nextT, width, height, courtLayer);
          drawVignette(ctx, width, height);
          drawChrome(ctx, width, height, logo);
          ctx.restore();
        } else {
          ctx.drawImage(snap, 0, 0);
          ctx.save();
          ctx.globalAlpha = easeInOut(tp);
          drawShotContent(ctx, next, nextT, width, height, courtLayer);
          drawVignette(ctx, width, height);
          drawChrome(ctx, width, height, logo);
          ctx.restore();
        }

        await commitFrame();
      }
    }
  }

  for (let i = 0; i < outroFrames; i += 1) {
    const t = i / (outroFrames - 1 || 1);
    const beatPulse = Math.max(0, 1 - (((i / fps) % beatSec) / beatSec) * 5);
    drawTitleCard(ctx, width, height, "OBRIGADO", "", logo, t, beatPulse);
    await commitFrame();
  }

  music.master.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.2);
  await wait(40);
  recorder.stop();
  music.stop();
  videoStream.getTracks().forEach((track) => track.stop());
  music.dest.stream.getTracks().forEach((track) => track.stop());
  const blob = await done;
  await audioCtx.close();
  onProgress?.(1);
  return blob;
}
