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
type ShotKind =
  | "kenBurns"
  | "pushIn"
  | "pullOut"
  | "driftH"
  | "driftDiag"
  | "camera"
  | "collage";
type TransitionKind = "fade" | "zoom" | "whip" | "motionBlur";

type PlannedShot = {
  kind: ShotKind;
  clip: VideoClip;
  clips?: VideoClip[];
  subject: SubjectKind;
  beats: number;
  transition: TransitionKind;
  dirX: number;
  dirY: number;
};

const SHOT_CYCLE: ShotKind[] = [
  "collage",
  "kenBurns",
  "pushIn",
  "driftH",
  "pullOut",
  "kenBurns",
  "collage",
  "driftDiag",
  "camera",
  "kenBurns",
];

const TRANSITIONS: TransitionKind[] = ["fade", "zoom", "whip", "motionBlur", "fade", "zoom", "whip"];

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
  if (t <= hold) return 0;
  return easeInOutCubic((t - hold) / (1 - hold)) * max;
}

function isLandscapeImage(img: HTMLImageElement) {
  return img.naturalWidth > img.naturalHeight * 1.08;
}

/** Soft blurred/dimmed cover fill behind letterboxed landscape shots. */
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
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.filter = "blur(24px) saturate(1.05)";
  ctx.drawImage(img, bx, by, bw, bh);
  ctx.filter = "none";
  ctx.fillStyle = "rgba(5,15,40,0.55)";
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
    drawBackdrop(ctx, img, dx, dy, dw, dh);
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
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, dx + x, dy + y, drawW, drawH);
  ctx.restore();
}

function drawFlash(ctx: CanvasRenderingContext2D, width: number, height: number, alpha: number) {
  if (alpha <= 0) return;
  ctx.fillStyle = `rgba(255,255,255,${clamp(alpha, 0, 1)})`;
  ctx.fillRect(0, 0, width, height);
}

function drawVignette(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const g = ctx.createRadialGradient(
    width / 2,
    height * 0.42,
    width * 0.14,
    width / 2,
    height * 0.48,
    width * 0.95,
  );
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(4,12,32,0.36)");
  ctx.fillStyle = g;
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

  const pop = 0.86 + easeOutBack(Math.min(1, t * 1.25)) * 0.16 + beatPulse * 0.02;
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

function motionForShot(shot: PlannedShot, t: number) {
  const landscape = isLandscapeImage(shot.clip.image);
  let max = maxFraming(shot.subject, shot.clip.face);
  if (landscape) max *= 0.72;
  const panMul = landscape ? 0.4 : 0.65;
  const { kind, subject, dirX, dirY } = shot;
  const ease = easeInOutCubic(t);

  if (subject === "group" || (landscape && subject !== "portrait")) {
    const framing = softApproach(t, 0.2, Math.min(landscape ? 0.32 : 0.26, max));
    const panAmt = (landscape ? 0.16 : 0.2) * panMul;
    if (kind === "pullOut") {
      return {
        framing: max * (1 - ease) * 0.6,
        zoom: 1,
        panX: dirX * ease * panAmt,
        panY: dirY * ease * panAmt * 0.4,
      };
    }
    return {
      framing,
      zoom: 1,
      panX: dirX * ease * panAmt,
      panY: dirY * ease * (kind === "driftDiag" ? panAmt : panAmt * 0.25),
    };
  }

  if (kind === "pushIn") {
    const hold = landscape ? 0.32 : 0.25;
    const framing = softApproach(t, hold, max);
    return {
      framing,
      zoom: 1,
      panX: dirX * framing * 0.06 * panMul,
      panY: dirY * framing * 0.04 * panMul,
    };
  }

  if (kind === "pullOut") {
    const start = max * (landscape ? 0.65 : 0.8);
    const framing = start * (1 - ease) + softApproach(t, 0.6, max * 0.2);
    return {
      framing: clamp(framing, 0, max),
      zoom: 1,
      panX: dirX * (1 - t) * 0.1 * panMul,
      panY: dirY * (1 - t) * 0.06 * panMul,
    };
  }

  if (kind === "driftH") {
    const framing = softApproach(t, 0.22, max * 0.8);
    return {
      framing,
      zoom: 1,
      panX: dirX * (-0.28 + ease * 0.56) * panMul,
      panY: dirY * 0.03 * Math.sin(t * Math.PI) * panMul,
    };
  }

  if (kind === "driftDiag") {
    const framing = softApproach(t, 0.22, max * 0.82);
    return {
      framing,
      zoom: 1,
      panX: dirX * ease * 0.28 * panMul,
      panY: dirY * ease * 0.18 * panMul,
    };
  }

  if (kind === "camera") {
    const framing = softApproach(t, 0.28, max * 0.65);
    return {
      framing,
      zoom: 1,
      panX: dirX * ease * 0.12 * panMul,
      panY: dirY * ease * 0.08 * panMul,
    };
  }

  const framing = softApproach(t, landscape ? 0.3 : 0.24, max * 0.85);
  return {
    framing,
    zoom: 1,
    panX: dirX * ease * 0.2 * panMul,
    panY: dirY * ease * 0.12 * panMul,
  };
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

type PinLayout = { x: number; y: number; w: number; h: number; rot: number };

function collageLayouts(count: number): PinLayout[] {
  const presets: PinLayout[][] = [
    [{ x: 0.18, y: 0.28, w: 0.64, h: 0.42, rot: -2 }],
    [
      { x: 0.08, y: 0.22, w: 0.42, h: 0.38, rot: -4 },
      { x: 0.5, y: 0.34, w: 0.42, h: 0.38, rot: 3 },
    ],
    [
      { x: 0.08, y: 0.2, w: 0.4, h: 0.34, rot: -3 },
      { x: 0.52, y: 0.18, w: 0.4, h: 0.34, rot: 2.5 },
      { x: 0.28, y: 0.48, w: 0.44, h: 0.32, rot: -1.5 },
    ],
    [
      { x: 0.06, y: 0.18, w: 0.42, h: 0.3, rot: -3.5 },
      { x: 0.52, y: 0.16, w: 0.42, h: 0.3, rot: 2.8 },
      { x: 0.1, y: 0.48, w: 0.38, h: 0.3, rot: 2 },
      { x: 0.52, y: 0.5, w: 0.38, h: 0.3, rot: -2.2 },
    ],
    [
      { x: 0.05, y: 0.16, w: 0.36, h: 0.28, rot: -4 },
      { x: 0.42, y: 0.14, w: 0.28, h: 0.26, rot: 2 },
      { x: 0.68, y: 0.2, w: 0.28, h: 0.3, rot: 3.5 },
      { x: 0.1, y: 0.46, w: 0.4, h: 0.32, rot: -1.8 },
      { x: 0.54, y: 0.5, w: 0.38, h: 0.3, rot: 2.4 },
    ],
    [
      { x: 0.05, y: 0.15, w: 0.3, h: 0.26, rot: -3 },
      { x: 0.36, y: 0.13, w: 0.3, h: 0.26, rot: 2.2 },
      { x: 0.67, y: 0.17, w: 0.28, h: 0.28, rot: -2 },
      { x: 0.08, y: 0.44, w: 0.32, h: 0.3, rot: 2.8 },
      { x: 0.4, y: 0.46, w: 0.28, h: 0.28, rot: -1.5 },
      { x: 0.68, y: 0.48, w: 0.28, h: 0.28, rot: 3 },
    ],
  ];
  const n = clamp(count, 1, 6);
  return presets[n - 1];
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
) {
  const a = clamp(appear, 0, 1);
  if (a <= 0) return;
  const pop = 0.86 + easeOutBack(a) * 0.14;

  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate((rotDeg * Math.PI) / 180);
  ctx.scale(pop, pop);
  ctx.translate(-(x + w / 2), -(y + h / 2));

  // polaroid plate
  const pad = Math.min(w, h) * 0.045;
  ctx.fillStyle = "#f7f4ee";
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 10;
  ctx.fillRect(x - pad, y - pad, w + pad * 2, h + pad * 2.8);
  ctx.shadowColor = "transparent";

  // tape
  ctx.fillStyle = "rgba(240,196,25,0.55)";
  ctx.save();
  ctx.translate(x + w * 0.18, y - pad * 0.2);
  ctx.rotate(-0.15);
  ctx.fillRect(-w * 0.12, -pad * 0.6, w * 0.24, pad * 1.1);
  ctx.restore();
  ctx.save();
  ctx.translate(x + w * 0.82, y - pad * 0.1);
  ctx.rotate(0.12);
  ctx.fillRect(-w * 0.12, -pad * 0.6, w * 0.24, pad * 1.1);
  ctx.restore();

  const face = clip.face;
  const cx = face?.cx ?? 0.5;
  const cy = face?.cy ?? 0.42;
  drawFramed(ctx, clip.image, x, y, w, h, face, 0.15, 1, (cx - 0.5) * 0.2, (cy - 0.5) * 0.15);

  ctx.restore();
}

function drawCollageMural(
  ctx: CanvasRenderingContext2D,
  clips: VideoClip[],
  width: number,
  height: number,
  t: number,
) {
  drawVolleyCourt(ctx, width, height, t);
  const group = clips.slice(0, 6);
  const layout = collageLayouts(group.length);
  // Entrada lenta: fotos entram ao longo de ~70% do shot, depois seguram
  const enterT = clamp(t / 0.7, 0, 1);
  const stagger = 0.11;
  const appearDur = 0.32;

  for (let i = 0; i < group.length; i += 1) {
    const pin = layout[i];
    const appear = easeOutCubic(clamp((enterT - i * stagger) / appearDur, 0, 1));
    const hold = clamp((t - 0.55) / 0.45, 0, 1);
    const driftX = Math.sin((t * 0.7 + i * 0.37) * Math.PI) * width * 0.003;
    const driftY = Math.cos((t * 0.7 + i * 0.29) * Math.PI) * height * 0.0025;
    drawPinnedPhoto(
      ctx,
      group[i],
      pin.x * width + driftX,
      pin.y * height + driftY,
      pin.w * width,
      pin.h * height,
      pin.rot + hold * (i % 2 === 0 ? -0.6 : 0.6),
      appear,
    );
  }
}

function drawShotContent(
  ctx: CanvasRenderingContext2D,
  shot: PlannedShot,
  t: number,
  width: number,
  height: number,
) {
  if (shot.kind === "collage") {
    drawCollageMural(ctx, shot.clips ?? [shot.clip], width, height, t);
    return;
  }

  const m = motionForShot(shot, t);
  drawFramed(
    ctx,
    shot.clip.image,
    0,
    0,
    width,
    height,
    shot.clip.face,
    m.framing,
    m.zoom,
    m.panX,
    m.panY,
  );
}

function applyTransition(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  kind: TransitionKind,
  progress: number,
  drawCurrent: () => void,
  drawNext: () => void,
) {
  const p = clamp(progress, 0, 1);

  if (kind === "fade") {
    const e = easeInOut(p);
    drawCurrent();
    ctx.save();
    ctx.globalAlpha = e;
    drawNext();
    ctx.restore();
    return;
  }

  if (kind === "zoom") {
    const e = easeInOutCubic(p);
    ctx.save();
    ctx.globalAlpha = 1 - e;
    ctx.translate(width / 2, height / 2);
    ctx.scale(1 + e * 0.18, 1 + e * 0.18);
    ctx.translate(-width / 2, -height / 2);
    drawCurrent();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = e;
    ctx.translate(width / 2, height / 2);
    ctx.scale(0.9 + e * 0.1, 0.9 + e * 0.1);
    ctx.translate(-width / 2, -height / 2);
    drawNext();
    ctx.restore();
    return;
  }

  if (kind === "whip") {
    const e = easeOutCubic(p);
    const dir = p < 0.5 ? 1 : -1;
    ctx.save();
    ctx.translate(-width * e * 1.05, 0);
    drawCurrent();
    ctx.restore();
    ctx.save();
    ctx.translate(width * (1 - e), 0);
    drawNext();
    ctx.restore();
    // soft streak at peak
    if (e > 0.2 && e < 0.85) {
      ctx.fillStyle = `rgba(247,244,238,${0.12 * Math.sin((e - 0.2) * Math.PI)})`;
      for (let i = 0; i < 5; i += 1) {
        ctx.fillRect(width * e + dir * i * 10, 0, 3, height);
      }
    }
    return;
  }

  // motionBlur — short directional smear between shots
  const e = easeInOutCubic(p);
  const smear = Math.sin(e * Math.PI);
  drawCurrent();
  ctx.save();
  ctx.globalAlpha = 0.35 * smear;
  for (let i = 1; i <= 4; i += 1) {
    ctx.setTransform(1, 0, 0, 1, i * 14 * smear, i * 4 * smear);
    drawCurrent();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = e;
  drawNext();
  ctx.restore();
  if (smear > 0.35) drawFlash(ctx, width, height, 0.1 * smear);
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

function planShots(clips: VideoClip[], bodyBeats: number): PlannedShot[] {
  const remaining = uniqueClips(clips);
  if (remaining.length === 0) return [];

  const shots: PlannedShot[] = [];
  let style = 0;
  let lastKind: ShotKind | null = null;

  const dirs = [
    { x: 1, y: 0.35 },
    { x: -1, y: 0.25 },
    { x: 0.7, y: -0.45 },
    { x: -0.65, y: 0.5 },
    { x: 1, y: -0.2 },
    { x: -0.8, y: -0.35 },
  ];

  while (remaining.length > 0) {
    let kind = SHOT_CYCLE[style % SHOT_CYCLE.length];
    style += 1;
    if (kind === lastKind) {
      kind = SHOT_CYCLE[style % SHOT_CYCLE.length];
      style += 1;
    }

    const dir = dirs[shots.length % dirs.length];

    // Collage only with unused photos; never wrap/repeat
    if (kind === "collage" && remaining.length >= 2) {
      const count = Math.min(6, remaining.length);
      const group = remaining.splice(0, count);
      lastKind = "collage";
      shots.push({
        kind: "collage",
        clip: group[0],
        clips: group,
        subject: "scene",
        beats: 14,
        transition: "fade",
        dirX: dir.x,
        dirY: dir.y,
      });
      continue;
    }

    if (kind === "collage") kind = "kenBurns";

    const clip = remaining.shift();
    if (!clip) break;

    const subject = classifySubject(clip.face);
    if (subject === "group" && (kind === "pushIn" || kind === "pullOut")) {
      kind = style % 2 === 0 ? "driftH" : "kenBurns";
    }
    lastKind = kind;

    shots.push({
      kind,
      clip,
      subject,
      beats: kind === "camera" ? 5 : 6,
      transition: TRANSITIONS[shots.length % TRANSITIONS.length],
      dirX: dir.x,
      dirY: dir.y,
    });
  }

  // Tempo proporcional à qtd de fotos em cada shot (sem jogar o resto tudo no último)
  const photoWeights = shots.map((s) => s.clips?.length ?? 1);
  const totalPhotos = photoWeights.reduce((a, b) => a + b, 0);
  if (shots.length > 0 && totalPhotos > 0 && bodyBeats > 0) {
    const ideal = bodyBeats / totalPhotos;
    // ~2–3s/foto a 128bpm; evita clip único absurdo
    const minBeats = 3;
    const maxBeatsPerPhoto = 8;

    let assigned = 0;
    for (let i = 0; i < shots.length; i += 1) {
      const n = photoWeights[i];
      const raw = Math.round(ideal * n);
      const capped = Math.min(n * maxBeatsPerPhoto, Math.max(minBeats, raw));
      shots[i].beats = capped;
      assigned += capped;
    }

    // Ajuste fino: espalha a diferença em +1/−1 beats
    let diff = bodyBeats - assigned;
    let i = 0;
    while (diff !== 0 && shots.length > 0 && i < shots.length * 4) {
      const idx = i % shots.length;
      const n = photoWeights[idx];
      if (diff > 0) {
        if (shots[idx].beats < n * maxBeatsPerPhoto) {
          shots[idx].beats += 1;
          diff -= 1;
        }
      } else if (shots[idx].beats > minBeats) {
        shots[idx].beats -= 1;
        diff += 1;
      }
      i += 1;
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
  width = 1080,
  height = 1920,
  fps = 30,
  durationSec = 58,
  bpm = 128,
  musicUrl = "/music/party.mp3",
  onProgress,
}: RenderVideoOptions): Promise<Blob> {
  if (clips.length === 0) throw new Error("Nenhuma foto para animar");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas não disponível");

  const audioCtx = new AudioContext();
  await audioCtx.resume();
  let music: Awaited<ReturnType<typeof loadMusic>>;
  try {
    music = await loadMusic(audioCtx, musicUrl);
  } catch {
    await audioCtx.close();
    throw new Error("Não deu pra carregar a música de fundo (/music/party.mp3).");
  }

  const videoStream = canvas.captureStream(fps);
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
    videoBitsPerSecond: 8_000_000,
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
  const introSec = 2.0;
  const outroSec = 2.0;
  const bodySec = Math.max(4, durationSec - introSec - outroSec);
  const bodyBeats = Math.max(8, Math.round(bodySec / beatSec));

  const shots = planShots(clips, bodyBeats);
  const shotSecs = shots.map((s) => s.beats * beatSec);
  const plannedBody = shotSecs.reduce((a, b) => a + b, 0);
  const scale = plannedBody > 0 ? bodySec / plannedBody : 1;
  const shotFrameCounts = shotSecs.map((sec) => Math.max(1, Math.round(fps * sec * scale)));

  const frameDuration = 1000 / fps;
  const introFrames = Math.round(fps * introSec);
  const outroFrames = Math.round(fps * outroSec);
  let bodyFrames = shotFrameCounts.reduce((a, b) => a + b, 0);
  const bodyTarget = Math.round(fps * bodySec);
  if (shotFrameCounts.length > 0 && bodyFrames !== bodyTarget) {
    shotFrameCounts[shotFrameCounts.length - 1] += bodyTarget - bodyFrames;
    bodyFrames = bodyTarget;
  }
  const totalFrames = introFrames + bodyFrames + outroFrames;

  // Transitions ~1.75 beats — calmer, less abrupt
  const transitionFramesTarget = Math.max(10, Math.round(fps * beatSec * 1.75));

  let frame = 0;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const startedAt = performance.now();

  recorder.start(100);

  for (let i = 0; i < introFrames; i += 1) {
    const t = i / introFrames;
    const elapsed = (performance.now() - startedAt) / 1000;
    const beatPulse = Math.max(0, 1 - ((elapsed % beatSec) / beatSec) * 5);
    drawTitleCard(ctx, width, height, title, subtitle, logo, t, beatPulse);
    if (t < 0.08) drawFlash(ctx, width, height, 0.22 * (1 - t / 0.08));
    onProgress?.(frame / totalFrames);
    frame += 1;
    await wait(frameDuration);
  }

  for (let s = 0; s < shots.length; s += 1) {
    const shot = shots[s];
    const next = shots[s + 1];
    const shotFrames = shotFrameCounts[s];
    const transitionFrames = next
      ? Math.min(
          transitionFramesTarget * (shot.kind === "collage" || next.kind === "collage" ? 1.35 : 1),
          Math.floor(shotFrames * (shot.kind === "collage" ? 0.28 : 0.42)),
        )
      : 0;
    const transitionStart = shotFrames - transitionFrames;

    for (let i = 0; i < shotFrames; i += 1) {
      const t = i / (shotFrames - 1 || 1);

      ctx.fillStyle = "#050f28";
      ctx.fillRect(0, 0, width, height);

      if (next && i >= transitionStart) {
        const tp = (i - transitionStart) / (transitionFrames || 1);
        applyTransition(
          ctx,
          width,
          height,
          shot.transition,
          tp,
          () => drawShotContent(ctx, shot, t, width, height),
          () => drawShotContent(ctx, next, 0.02, width, height),
        );
      } else {
        drawShotContent(ctx, shot, t, width, height);
      }

      drawVignette(ctx, width, height);
      drawChrome(ctx, width, height, logo);

      onProgress?.(frame / totalFrames);
      frame += 1;
      await wait(frameDuration);
    }
  }

  for (let i = 0; i < outroFrames; i += 1) {
    const t = i / outroFrames;
    const elapsed = (performance.now() - startedAt) / 1000;
    const beatPulse = Math.max(0, 1 - ((elapsed % beatSec) / beatSec) * 5);
    drawTitleCard(ctx, width, height, "OBRIGADO", "", logo, t, beatPulse);
    onProgress?.(frame / totalFrames);
    frame += 1;
    await wait(frameDuration);
  }

  music.master.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
  await wait(100);
  recorder.stop();
  music.stop();
  videoStream.getTracks().forEach((track) => track.stop());
  music.dest.stream.getTracks().forEach((track) => track.stop());
  const blob = await done;
  await audioCtx.close();
  onProgress?.(1);
  return blob;
}
