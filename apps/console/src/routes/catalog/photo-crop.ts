/**
 * The arithmetic of cropping a product photo to the shop's shape (M38a, D-601). Pure, so the
 * unit test reaches it without a canvas.
 *
 * The shop shows product photos 3 wide by 4 tall (the old website's cards and gallery are
 * `aspect-[3/4]`), so that is the shape a photo is cropped to here: ASSUMED in D-601, one
 * constant to change if the website's shape changes.
 */

/** Width over height of the shop's product photos. */
export const SHOP_PHOTO_ASPECT = 3 / 4;

/** The longest side a cropped photo is saved at, in pixels. */
export const MAX_CROP_WIDTH = 1600;

export interface CropView {
  /** The frame on screen, in CSS pixels. */
  readonly frameWidth: number;
  readonly frameHeight: number;
  /** The photo's own size, in pixels. */
  readonly imageWidth: number;
  readonly imageHeight: number;
  /** 1 = the photo just covers the frame; up to 4. */
  readonly zoom: number;
  /** The photo's top-left corner relative to the frame's, in CSS pixels (≤ 0). */
  readonly offsetX: number;
  readonly offsetY: number;
}

/** The scale that makes the photo exactly cover the frame, times the zoom. */
export function cropScale(view: CropView): number {
  const cover = Math.max(view.frameWidth / view.imageWidth, view.frameHeight / view.imageHeight);
  return cover * Math.min(4, Math.max(1, view.zoom));
}

/** Keep the frame inside the photo: the offset can never show an empty edge. */
export function clampOffset(view: CropView): {
  readonly offsetX: number;
  readonly offsetY: number;
} {
  const scale = cropScale(view);
  const minX = view.frameWidth - view.imageWidth * scale;
  const minY = view.frameHeight - view.imageHeight * scale;
  return {
    offsetX: Math.min(0, Math.max(minX, view.offsetX)),
    offsetY: Math.min(0, Math.max(minY, view.offsetY)),
  };
}

/** A zoom about the frame's centre: the point under the centre stays under it. */
export function zoomAboutCentre(view: CropView, zoom: number): CropView {
  const before = cropScale(view);
  const next = { ...view, zoom: Math.min(4, Math.max(1, zoom)) };
  const after = cropScale(next);
  const cx = view.frameWidth / 2;
  const cy = view.frameHeight / 2;
  const offsetX = cx - ((cx - view.offsetX) * after) / before;
  const offsetY = cy - ((cy - view.offsetY) * after) / before;
  return { ...next, ...clampOffset({ ...next, offsetX, offsetY }) };
}

/** The photo centred in the frame at the given zoom. */
export function centredView(
  frameWidth: number,
  frameHeight: number,
  imageWidth: number,
  imageHeight: number,
): CropView {
  const view: CropView = {
    frameWidth,
    frameHeight,
    imageWidth,
    imageHeight,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  };
  const scale = cropScale(view);
  return {
    ...view,
    offsetX: (frameWidth - imageWidth * scale) / 2,
    offsetY: (frameHeight - imageHeight * scale) / 2,
  };
}

/**
 * What to cut from the photo, in its own pixels, and the size to save it at: the frame's
 * shape, never wider than `MAX_CROP_WIDTH`, never enlarged past the photo's own pixels.
 */
export function cropRect(view: CropView): {
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
  readonly width: number;
  readonly height: number;
} {
  const scale = cropScale(view);
  const { offsetX, offsetY } = clampOffset(view);
  const sw = Math.min(view.imageWidth, view.frameWidth / scale);
  const sh = Math.min(view.imageHeight, view.frameHeight / scale);
  const sx = Math.min(view.imageWidth - sw, Math.max(0, -offsetX / scale));
  const sy = Math.min(view.imageHeight - sh, Math.max(0, -offsetY / scale));
  const width = Math.max(1, Math.round(Math.min(MAX_CROP_WIDTH, sw)));
  const height = Math.max(1, Math.round((width * view.frameHeight) / view.frameWidth));
  return { sx, sy, sw, sh, width, height };
}
