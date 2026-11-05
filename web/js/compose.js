/**
 * Frame composition shared by the live preview and the exporter.
 *
 * Everything is drawn in output pixels (1080×1920). The preview just scales
 * the canvas down, so what you see is exactly what gets exported.
 */

export const W = 1080;
export const H = 1920;
export const FPS = 30;

export const PLATFORMS = {
  tiktok: { label: 'TikTok', maxSeconds: 600 },
  reels: { label: 'Instagram Reels', maxSeconds: 180 },
  shorts: { label: 'YouTube Shorts', maxSeconds: 180 },
};

// Approximate areas covered by each app's buttons/captions (fractions of the frame).
export const SAFE_ZONES = {
  tiktok: { top: 0.08, bottom: 0.2, left: 0.05, right: 0.13 },
  reels: { top: 0.11, bottom: 0.22, left: 0.05, right: 0.11 },
  shorts: { top: 0.08, bottom: 0.2, left: 0.05, right: 0.14 },
};

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Where each piece goes in the frame.
 * scene: { layout, swap, splitRatio, arrangement, imageCount }
 */
export function layoutRects(scene) {
  const full = { x: 0, y: 0, w: W, h: H };
  if (scene.layout === 'video') return { clip: full, other: null, images: [] };

  const ratio = clamp(Number(scene.splitRatio) || 0.5, 0.2, 0.8);
  const clipH = even(H * ratio);
  const otherH = H - clipH;
  const clip = scene.swap ? { x: 0, y: otherH, w: W, h: clipH } : { x: 0, y: 0, w: W, h: clipH };
  const other = scene.swap ? { x: 0, y: 0, w: W, h: otherH } : { x: 0, y: clipH, w: W, h: otherH };

  let images = [];
  if (scene.layout === 'split-image') {
    if (scene.imageCount === 2 && scene.arrangement === 'side-by-side') {
      images = [
        { ...other, w: W / 2 },
        { ...other, x: W / 2, w: W / 2 },
      ];
    } else {
      images = [other, other];
    }
  }
  return { clip, other, images };
}

/**
 * Source crop for "cover" scaling with a focus point (0..1 on each axis).
 * Also returns how far the scaled media overflows the box (for drag-to-pan).
 */
export function coverCrop(sw, sh, rect, fx = 0.5, fy = 0.5) {
  const scale = Math.max(rect.w / sw, rect.h / sh);
  const cw = rect.w / scale;
  const ch = rect.h / scale;
  return {
    sx: (sw - cw) * clamp(fx, 0, 1),
    sy: (sh - ch) * clamp(fy, 0, 1),
    sw: cw,
    sh: ch,
    overX: sw * scale - rect.w,
    overY: sh * scale - rect.h,
  };
}

/** Largest rect with the source's aspect ratio that fits inside `rect`, centred. */
export function containRect(sw, sh, rect) {
  const scale = Math.min(rect.w / sw, rect.h / sh);
  const w = sw * scale;
  const h = sh * scale;
  return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
}

/** Overlay box in output pixels, positioned by its centre point. */
export function overlayRect(ov) {
  const w = ov.scale * W;
  const h = (w * ov.ih) / ov.iw;
  return { x: ov.cx * W - w / 2, y: ov.cy * H - h / 2, w, h };
}

function drawCover(ctx, m, rect) {
  const c = coverCrop(m.w, m.h, rect, m.fx, m.fy);
  ctx.drawImage(m.src, c.sx, c.sy, c.sw, c.sh, rect.x, rect.y, rect.w, rect.h);
}

function drawContain(ctx, m, rect) {
  const r = containRect(m.w, m.h, rect);
  ctx.drawImage(m.src, 0, 0, m.w, m.h, r.x, r.y, r.w, r.h);
}

let blurCanvas = null;
function drawBlurred(ctx, m, rect) {
  // Downscale hard, then let bilinear upscaling smear it into a soft blur.
  // Works the same in every browser (unlike ctx.filter).
  const bw = 45;
  const bh = Math.round((bw * rect.h) / rect.w);
  if (!blurCanvas) {
    blurCanvas =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bw, bh) : document.createElement('canvas');
  }
  blurCanvas.width = bw;
  blurCanvas.height = bh;
  const b = blurCanvas.getContext('2d');
  b.imageSmoothingQuality = 'high';
  const c = coverCrop(m.w, m.h, rect, 0.5, 0.5);
  b.drawImage(m.src, c.sx, c.sy, c.sw, c.sh, 0, 0, bw, bh);
  ctx.save();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(blurCanvas, 0, 0, bw, bh, rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function drawPlaceholder(ctx, rect, label) {
  ctx.save();
  ctx.fillStyle = '#0b0b0b';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = '#1d1d1d';
  ctx.lineWidth = 4;
  ctx.setLineDash([24, 18]);
  ctx.strokeRect(rect.x + 30, rect.y + 30, rect.w - 60, rect.h - 60);
  ctx.fillStyle = '#3a3a3a';
  ctx.font = '600 56px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2);
  ctx.restore();
}

/**
 * Draw one output frame.
 *
 * scene = {
 *   layout: 'video' | 'split-video' | 'split-image',
 *   fit: 'fill' | 'blur' | 'bars',
 *   swap, splitRatio, arrangement: 'side-by-side' | 'switch',
 *   showSecondImage: boolean,          // for 'switch', decided by the caller from time
 *   clip:       { src, w, h, fx, fy } | null,
 *   background: { src, w, h, fx, fy } | null,
 *   images:     [{ src, w, h, fx, fy }],          // 0..2
 *   overlay:    { src, iw, ih, cx, cy, scale, opacity } | null,
 *   placeholders: boolean,             // preview only
 * }
 */
export function drawFrame(ctx, scene) {
  const images = (scene.images || []).filter(Boolean);
  const rects = layoutRects({ ...scene, imageCount: images.length });

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  // Clip
  const fit = scene.layout === 'video' ? scene.fit : 'fill';
  if (scene.clip) {
    if (fit === 'fill') {
      drawCover(ctx, scene.clip, rects.clip);
    } else {
      if (fit === 'blur') drawBlurred(ctx, scene.clip, rects.clip);
      drawContain(ctx, scene.clip, rects.clip);
    }
  } else if (scene.placeholders) {
    drawPlaceholder(ctx, rects.clip, 'CLIP');
  }

  // Other half
  if (scene.layout === 'split-video') {
    if (scene.background) drawCover(ctx, scene.background, rects.other);
    else if (scene.placeholders) drawPlaceholder(ctx, rects.other, 'BACKGROUND VIDEO');
  } else if (scene.layout === 'split-image') {
    if (images.length === 2 && scene.arrangement === 'side-by-side') {
      drawCover(ctx, images[0], rects.images[0]);
      drawCover(ctx, images[1], rects.images[1]);
    } else if (images.length === 2) {
      drawCover(ctx, scene.showSecondImage ? images[1] : images[0], rects.other);
    } else if (images.length === 1) {
      drawCover(ctx, images[0], rects.other);
    } else if (scene.placeholders) {
      drawPlaceholder(ctx, rects.other, 'IMAGE');
    }
  }

  // Overlay
  const ov = scene.overlay;
  if (ov && ov.src) {
    const r = overlayRect(ov);
    ctx.globalAlpha = clamp(ov.opacity ?? 1, 0, 1);
    ctx.drawImage(ov.src, r.x, r.y, r.w, r.h);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  return rects;
}

/** Which of two "switch" images is visible at time t (seconds into the trimmed clip). */
export function showSecondImageAt(t, duration) {
  return t >= duration / 2;
}

/** Pick the animated-overlay frame for a time (frames: [{ image, duration }], durations in s). */
export function frameAt(frames, t) {
  if (!frames || frames.length === 0) return null;
  const total = frames.reduce((s, f) => s + f.duration, 0);
  if (!(total > 0)) return frames[0].image;
  let local = ((t % total) + total) % total;
  for (const f of frames) {
    if (local < f.duration) return f.image;
    local -= f.duration;
  }
  return frames[frames.length - 1].image;
}
