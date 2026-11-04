'use strict';

/**
 * Pure functions that turn a project description into an ffmpeg argument list.
 * Kept free of Electron / fs so it can be unit tested with plain Node.
 *
 * All geometry in the project is normalised (0..1) so the preview in the
 * renderer and the rendered file use exactly the same maths:
 *   - "cover" scaling = CSS `object-fit: cover` + `object-position: fx fy`
 *   - overlay position = centre point (cx, cy) as a fraction of the frame,
 *     overlay width as a fraction of the frame width.
 */

const OUTPUT = Object.freeze({ width: 1080, height: 1920, fps: 30 });

const PLATFORMS = Object.freeze({
  tiktok: { label: 'TikTok', maxSeconds: 600 },
  reels: { label: 'Instagram Reels', maxSeconds: 180 },
  shorts: { label: 'YouTube Shorts', maxSeconds: 180 },
});

const LAYOUTS = Object.freeze(['video', 'split-video', 'split-image']);
const FIT_MODES = Object.freeze(['fill', 'blur', 'bars']);
const IMAGE_ARRANGEMENTS = Object.freeze(['side-by-side', 'switch']);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const num = (n, digits = 4) => Number(n.toFixed(digits)).toString();

/** Escape a value for use inside a single-quoted filtergraph option. */
function q(expr) {
  return `'${String(expr).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Scale to cover w×h, then crop with a focus point (0..1 on each axis). */
function cover(w, h, fx = 0.5, fy = 0.5) {
  const x = num(clamp(fx, 0, 1));
  const y = num(clamp(fy, 0, 1));
  return (
    `scale=${w}:${h}:force_original_aspect_ratio=increase,` +
    `crop=${w}:${h}:(iw-ow)*${x}:(ih-oh)*${y},setsar=1`
  );
}

/** Scale to fit inside w×h (letterbox maths, no padding). */
function contain(w, h) {
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,setsar=1`;
}

function validate(project) {
  const errors = [];
  const p = project || {};
  if (!LAYOUTS.includes(p.layout)) errors.push(`Unknown layout "${p.layout}".`);
  if (!p.clip || !p.clip.path) errors.push('Add a clip first.');
  if (!p.output || !p.output.path) errors.push('Choose where to save the export.');

  const dur = (p.trim && p.trim.end - p.trim.start) || 0;
  if (!(dur > 0)) errors.push('The trimmed clip must be longer than 0 seconds.');

  if (p.layout === 'split-video' && !(p.background && p.background.path)) {
    errors.push('Add a background video for the "clip over video" layout.');
  }
  if (p.layout === 'split-image') {
    const imgs = (p.images || []).filter((i) => i && i.path);
    if (imgs.length === 0) errors.push('Add at least one image for the "clip over image" layout.');
    if (imgs.length > 2) errors.push('A maximum of 2 images is allowed.');
  }
  if (p.overlay && p.overlay.path) {
    if (!(p.overlay.scale > 0)) errors.push('Overlay size must be greater than 0.');
  }
  return errors;
}

/**
 * Build the ffmpeg CLI arguments for a project.
 *
 * project = {
 *   layout: 'video' | 'split-video' | 'split-image',
 *   fit: 'fill' | 'blur' | 'bars',              // video-only layout
 *   swap: boolean,                              // split layouts: clip on bottom
 *   splitRatio: 0.5,                            // split layouts: clip share of height
 *   clip: { path, hasAudio, focusX, focusY },
 *   trim: { start, end },                       // seconds
 *   background: { path, focusX, focusY, volume },  // split-video
 *   images: [{ path, focusX, focusY }],         // split-image, max 2
 *   imageArrangement: 'side-by-side' | 'switch',
 *   overlay: { path, cx, cy, scale, opacity, isGif } | null,
 *   output: { path, crf, preset },
 * }
 */
function buildArgs(project) {
  const errors = validate(project);
  if (errors.length) {
    const err = new Error(errors.join('\n'));
    err.validation = errors;
    throw err;
  }

  const { width: W, height: H, fps: FPS } = OUTPUT;
  const p = project;
  const start = Math.max(0, p.trim.start);
  const duration = p.trim.end - p.trim.start;
  const clip = p.clip;

  const args = ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats'];
  const filters = [];
  let idx = 0;

  // Input 0: the clip (trimmed on the input side for fast seeking).
  args.push('-ss', num(start, 3), '-t', num(duration, 3), '-i', clip.path);
  const clipIn = idx++;

  let base; // label of the composed 1080×1920 frame
  let bgIn = null; // background video input index (split-video only)

  if (p.layout === 'video') {
    const fit = FIT_MODES.includes(p.fit) ? p.fit : 'fill';
    if (fit === 'fill') {
      filters.push(`[${clipIn}:v]${cover(W, H, clip.focusX, clip.focusY)}[base]`);
    } else if (fit === 'bars') {
      filters.push(`[${clipIn}:v]${contain(W, H)},pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black[base]`);
    } else {
      filters.push(`[${clipIn}:v]split=2[bgsrc][fgsrc]`);
      filters.push(`[bgsrc]${cover(W, H)},boxblur=luma_radius=40:luma_power=2[bg]`);
      filters.push(`[fgsrc]${contain(W, H)}[fg]`);
      filters.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`);
    }
    base = 'base';
  } else {
    const ratio = clamp(Number(p.splitRatio) || 0.5, 0.2, 0.8);
    const clipH = even(H * ratio);
    const otherH = H - clipH;

    filters.push(`[${clipIn}:v]${cover(W, clipH, clip.focusX, clip.focusY)}[clipv]`);

    if (p.layout === 'split-video') {
      const bg = p.background;
      // Loop the background so it always covers the whole clip.
      args.push('-stream_loop', '-1', '-i', bg.path);
      bgIn = idx++;
      filters.push(`[${bgIn}:v]${cover(W, otherH, bg.focusX, bg.focusY)}[otherv]`);
    } else {
      const imgs = p.images.filter((i) => i && i.path).slice(0, 2);
      const imgIns = imgs.map((img) => {
        args.push('-loop', '1', '-framerate', String(FPS), '-t', num(duration, 3), '-i', img.path);
        return idx++;
      });
      if (imgs.length === 1) {
        filters.push(`[${imgIns[0]}:v]${cover(W, otherH, imgs[0].focusX, imgs[0].focusY)}[otherv]`);
      } else if (p.imageArrangement === 'switch') {
        filters.push(`[${imgIns[0]}:v]${cover(W, otherH, imgs[0].focusX, imgs[0].focusY)}[img0]`);
        filters.push(`[${imgIns[1]}:v]${cover(W, otherH, imgs[1].focusX, imgs[1].focusY)}[img1]`);
        filters.push(`[img0][img1]overlay=0:0:enable=${q(`gte(t,${num(duration / 2, 3)})`)}[otherv]`);
      } else {
        const halfW = W / 2;
        filters.push(`[${imgIns[0]}:v]${cover(halfW, otherH, imgs[0].focusX, imgs[0].focusY)}[img0]`);
        filters.push(`[${imgIns[1]}:v]${cover(halfW, otherH, imgs[1].focusX, imgs[1].focusY)}[img1]`);
        filters.push(`[img0][img1]hstack=inputs=2[otherv]`);
      }
    }

    const order = p.swap ? '[otherv][clipv]' : '[clipv][otherv]';
    filters.push(`${order}vstack=inputs=2[base]`);
    base = 'base';
  }

  // Optional overlay, positioned by its centre point.
  const ov = p.overlay;
  if (ov && ov.path) {
    if (ov.isGif) {
      args.push('-ignore_loop', '0', '-i', ov.path);
    } else {
      args.push('-loop', '1', '-framerate', String(FPS), '-i', ov.path);
    }
    const ovIn = idx++;
    const ovW = even(W * ov.scale);
    const opacity = clamp(ov.opacity == null ? 1 : Number(ov.opacity), 0, 1);
    let chain = `[${ovIn}:v]scale=${ovW}:-2,format=rgba`;
    if (opacity < 1) chain += `,colorchannelmixer=aa=${num(opacity, 3)}`;
    filters.push(`${chain}[ov]`);
    const cx = num(Number(ov.cx));
    const cy = num(Number(ov.cy));
    filters.push(
      `[${base}][ov]overlay=x=${q(`main_w*${cx}-overlay_w/2`)}:y=${q(`main_h*${cy}-overlay_h/2`)}` +
        `:shortest=0:eof_action=repeat[withov]`
    );
    base = 'withov';
  }

  filters.push(`[${base}]fps=${FPS},format=yuv420p[vout]`);

  // Audio: clip audio, optionally mixed with background-video audio.
  let audioMap = null;
  const bgVol = p.layout === 'split-video' ? clamp(Number(p.background.volume) || 0, 0, 1) : 0;
  const clipVol = clamp(clip.volume == null ? 1 : Number(clip.volume), 0, 2);
  const useBgAudio = bgVol > 0 && p.background.hasAudio;
  if (clip.hasAudio && useBgAudio) {
    filters.push(`[${clipIn}:a]volume=${num(clipVol, 3)}[a0]`);
    filters.push(`[${bgIn}:a]volume=${num(bgVol, 3)}[a1]`);
    filters.push(`[a0][a1]amix=inputs=2:duration=first:normalize=0[aout]`);
    audioMap = '[aout]';
  } else if (clip.hasAudio) {
    if (clipVol !== 1) {
      filters.push(`[${clipIn}:a]volume=${num(clipVol, 3)}[aout]`);
      audioMap = '[aout]';
    } else {
      audioMap = `${clipIn}:a:0`;
    }
  } else if (useBgAudio) {
    filters.push(`[${bgIn}:a]volume=${num(bgVol, 3)}[aout]`);
    audioMap = '[aout]';
  }

  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[vout]');
  if (audioMap) args.push('-map', audioMap);

  const crf = clamp(Number(p.output.crf) || 20, 14, 32);
  const preset = p.output.preset || 'medium';
  args.push(
    '-t', num(duration, 3),
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
    '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS)
  );
  if (audioMap) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  args.push('-movflags', '+faststart', p.output.path);

  return { args, duration };
}

module.exports = {
  OUTPUT,
  PLATFORMS,
  LAYOUTS,
  FIT_MODES,
  IMAGE_ARRANGEMENTS,
  buildArgs,
  validate,
  cover,
  contain,
};
