export type PhotoItem = {
  id: string;
  src: string;
  name: string;
};

/** Normalized face box (0–1 relative to image size). */
export type FaceBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
};

export type MatchResult = {
  photo: PhotoItem;
  distance: number;
  score: number;
  face: FaceBox;
};

export type AppStep =
  | "hero"
  | "capture"
  | "scanning"
  | "results"
  | "rendering"
  | "video";
