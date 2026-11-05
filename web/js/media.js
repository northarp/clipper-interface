/** Loading helpers shared by the preview and the exporter. */

export const ACCEPT = {
  video: ['mp4', 'mov', 'webm', 'mkv', 'm4v'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif'],
  overlay: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'],
};

export function extOf(name) {
  const m = /\.([^.]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function isKind(file, kind) {
  const ext = extOf(file.name);
  if (ACCEPT[kind].includes(ext)) return true;
  const type = file.type || '';
  return kind === 'video' ? type.startsWith('video/') : type.startsWith('image/');
}

/** Decode a still image (EXIF orientation applied). */
export async function loadBitmap(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  return { src: bmp, w: bmp.width, h: bmp.height };
}

/**
 * Decode every frame of an animated image (GIF/animated WebP) with ImageDecoder.
 * Returns null when unsupported or the image isn't animated.
 */
export async function decodeAnimation(file, maxFrames = 600) {
  if (typeof ImageDecoder === 'undefined' || !file.type) return null;
  try {
    if (!(await ImageDecoder.isTypeSupported(file.type))) return null;
    const decoder = new ImageDecoder({ data: file.stream(), type: file.type });
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (!track || !track.animated) {
      decoder.close();
      return null;
    }
    await decoder.completed;
    const count = Math.min(track.frameCount, maxFrames);
    const frames = [];
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      const bmp = await createImageBitmap(image);
      // GIF frames with a 0 delay are shown for ~100 ms by browsers.
      const dur = image.duration ? image.duration / 1e6 : 0.1;
      frames.push({ image: bmp, duration: dur < 0.02 ? 0.1 : dur });
      image.close();
    }
    decoder.close();
    return frames.length > 1 ? frames : null;
  } catch (_) {
    return null;
  }
}

/** Load an overlay: animated frames when possible, otherwise a still. */
export async function loadOverlay(file) {
  const frames = await decodeAnimation(file);
  if (frames) {
    return { frames, src: frames[0].image, iw: frames[0].image.width, ih: frames[0].image.height };
  }
  const { src, w, h } = await loadBitmap(file);
  return { frames: null, src, iw: w, ih: h };
}
