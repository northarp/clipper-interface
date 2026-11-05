/**
 * In-browser exporter: decodes the sources with WebCodecs (via Mediabunny),
 * draws every frame with the same drawFrame() the preview uses, and encodes
 * an MP4 (H.264 + AAC). Nothing is uploaded anywhere.
 */

import {
  Input,
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  AudioBufferSink,
  Output,
  Mp4OutputFormat,
  WebMOutputFormat,
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
  QUALITY_MEDIUM,
  QUALITY_HIGH,
  QUALITY_VERY_HIGH,
  getFirstEncodableVideoCodec,
  canEncodeAudio,
} from 'mediabunny';
import { W, H, FPS, drawFrame, frameAt, showSecondImageAt, clamp } from './compose.js';
import { loadBitmap } from './media.js';

const QUALITY = { draft: QUALITY_MEDIUM, standard: QUALITY_HIGH, high: QUALITY_VERY_HIGH };
const SAMPLE_RATE = 48000;

export function exportSupported() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
}

function openInput(file) {
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
}

/** Decode [start, end) of a file's audio into one AudioBuffer. */
async function decodeAudioRange(input, start, end) {
  const track = await input.getPrimaryAudioTrack();
  if (!track || !(await track.canDecode())) return null;
  const chunks = [];
  for await (const chunk of new AudioBufferSink(track).buffers(start, end)) chunks.push(chunk);
  if (!chunks.length) return null;

  const sr = chunks[0].buffer.sampleRate;
  const channels = Math.max(...chunks.map((c) => c.buffer.numberOfChannels));
  const first = chunks[0].timestamp;
  const last = chunks[chunks.length - 1];
  const length = Math.max(1, Math.ceil((last.timestamp + last.duration - first) * sr));
  const out = new AudioBuffer({ length, numberOfChannels: channels, sampleRate: sr });
  for (const { buffer, timestamp } of chunks) {
    const offset = Math.round((timestamp - first) * sr);
    if (offset >= length) continue;
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
      out.copyToChannel(data.subarray(0, length - offset), c, offset);
    }
  }
  return { buffer: out, offset: first - start };
}

/** Mix clip audio (trimmed) with optional looping background audio. */
async function mixAudio(job, inputs, duration) {
  const clip = job.clip.volume > 0 ? await decodeAudioRange(inputs.clip, job.trim.start, job.trim.end) : null;
  let bg = null;
  if (inputs.background && job.background.volume > 0) {
    const bgEnd = Math.min(job.background.duration || duration, duration) + 0.05;
    bg = await decodeAudioRange(inputs.background, 0, bgEnd);
  }
  if (!clip && !bg) return null;

  const ctx = new OfflineAudioContext(2, Math.ceil(duration * SAMPLE_RATE), SAMPLE_RATE);
  const play = (src, volume, loop) => {
    const node = ctx.createBufferSource();
    node.buffer = src.buffer;
    node.loop = loop;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    node.connect(gain).connect(ctx.destination);
    if (loop || src.offset >= 0) node.start(Math.max(0, src.offset));
    else node.start(0, -src.offset);
  };
  if (clip) play(clip, clamp(job.clip.volume, 0, 1), false);
  if (bg) play(bg, clamp(job.background.volume, 0, 1), duration > bg.buffer.duration);
  return ctx.startRendering();
}

/** Yield background frames for each output frame, looping the video. */
async function* loopingFrames(sink, firstTs, loopDur, count) {
  let run = [];
  let prev = -Infinity;
  for (let i = 0; i < count; i++) {
    const t = i / FPS;
    const local = firstTs + (loopDur > 0 ? t % loopDur : t);
    if (local < prev && run.length) {
      yield* sink.canvasesAtTimestamps(run);
      run = [];
    }
    run.push(local);
    prev = local;
  }
  if (run.length) yield* sink.canvasesAtTimestamps(run);
}

async function pickAudioCodec(container) {
  if (container === 'webm') return 'opus';
  if (await canEncodeAudio('aac')) return 'aac';
  try {
    const { registerAacEncoder } = await import('../vendor/mediabunny-aac-encoder.min.mjs');
    registerAacEncoder();
    return 'aac';
  } catch (_) {
    return 'opus';
  }
}

/**
 * job = {
 *   layout, fit, swap, splitRatio, arrangement, quality,
 *   trim: { start, end },
 *   clip: { file, fx, fy, volume },
 *   background: { file, fx, fy, volume, duration } | null,
 *   images: [{ file, fx, fy }],
 *   overlay: { src, frames, iw, ih, cx, cy, scale, opacity } | null,
 * }
 * Returns { blob, extension }.
 */
export async function exportClip(job, { onProgress = () => {}, signal } = {}) {
  if (!exportSupported()) {
    throw new Error('This browser cannot encode video. Please use a recent Chrome, Edge or Firefox on a computer.');
  }
  const duration = job.trim.end - job.trim.start;
  const count = Math.max(1, Math.round(duration * FPS));
  const quality = QUALITY[job.quality] || QUALITY_HIGH;
  const aborted = () => signal && signal.aborted;
  const toDispose = [];

  try {
    // Pick codecs: H.264 in MP4 when possible (what the platforms want).
    const videoCodec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], {
      width: W, height: H, quality, frameRate: FPS,
    });
    if (!videoCodec) throw new Error("This browser can't encode 1080×1920 video. Try Chrome or Edge.");
    const container = videoCodec === 'avc' ? 'mp4' : 'webm';

    // Inputs
    const inputs = { clip: openInput(job.clip.file), background: null };
    toDispose.push(inputs.clip);
    const clipTrack = await inputs.clip.getPrimaryVideoTrack();
    if (!clipTrack) throw new Error("Couldn't find a video track in the clip.");
    if (!(await clipTrack.canDecode())) throw new Error("This browser can't decode the clip's video format.");
    const clipSink = new CanvasSink(clipTrack, { poolSize: 3 });

    let bgFrames = null;
    if (job.layout === 'split-video' && job.background) {
      inputs.background = openInput(job.background.file);
      toDispose.push(inputs.background);
      const bgTrack = await inputs.background.getPrimaryVideoTrack();
      if (!bgTrack || !(await bgTrack.canDecode())) {
        throw new Error("This browser can't decode the background video's format.");
      }
      const firstTs = await bgTrack.getFirstTimestamp();
      const loopDur = (await bgTrack.computeDuration()) - firstTs;
      job.background.duration = loopDur;
      bgFrames = loopingFrames(new CanvasSink(bgTrack, { poolSize: 3 }), firstTs, loopDur, count);
    }

    const images = [];
    if (job.layout === 'split-image') {
      for (const img of job.images.slice(0, 2)) {
        const bmp = await loadBitmap(img.file);
        images.push({ ...bmp, fx: img.fx, fy: img.fy });
      }
    }

    // Audio first (it decides whether the output has an audio track).
    onProgress(0, 'Mixing audio…');
    const audio = await mixAudio(job, inputs, duration);
    if (aborted()) throw new DOMException('Export cancelled.', 'AbortError');

    // Output
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });
    const output = new Output({
      format: container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
      target: new BufferTarget(),
    });
    const videoSource = new CanvasSource(canvas, { codec: videoCodec, quality, keyFrameInterval: 2 });
    output.addVideoTrack(videoSource, { frameRate: FPS });
    let audioSource = null;
    if (audio) {
      audioSource = new AudioBufferSource({ codec: await pickAudioCodec(container), quality: QUALITY_HIGH });
      output.addAudioTrack(audioSource);
    }
    await output.start();

    try {
      if (audioSource) {
        await audioSource.add(audio);
        audioSource.close();
      }

      const timestamps = Array.from({ length: count }, (_, i) => job.trim.start + i / FPS);
      const clipFrames = clipSink.canvasesAtTimestamps(timestamps);
      let lastClip = null;
      let lastBg = null;

      for (let i = 0; i < count; i++) {
        if (aborted()) throw new DOMException('Export cancelled.', 'AbortError');
        const t = i / FPS;
        const c = await clipFrames.next();
        if (c.value) lastClip = c.value.canvas;
        if (bgFrames) {
          const b = await bgFrames.next();
          if (b.value) lastBg = b.value.canvas;
        }

        const ov = job.overlay;
        drawFrame(ctx, {
          layout: job.layout,
          fit: job.fit,
          swap: job.swap,
          splitRatio: job.splitRatio,
          arrangement: job.arrangement,
          showSecondImage: showSecondImageAt(t, duration),
          clip: lastClip && { src: lastClip, w: lastClip.width, h: lastClip.height, fx: job.clip.fx, fy: job.clip.fy },
          background:
            lastBg && { src: lastBg, w: lastBg.width, h: lastBg.height, fx: job.background.fx, fy: job.background.fy },
          images,
          overlay: ov && { ...ov, src: ov.frames ? frameAt(ov.frames, t) : ov.src },
        });

        await videoSource.add(t, 1 / FPS);
        if (i % 5 === 0) onProgress(i / count, 'Rendering…');
      }
      await clipFrames.return();
      if (bgFrames) await bgFrames.return();
      videoSource.close();

      onProgress(1, 'Finishing…');
      await output.finalize();
    } catch (err) {
      await output.cancel().catch(() => {});
      throw err;
    }

    const mime = container === 'mp4' ? 'video/mp4' : 'video/webm';
    return { blob: new Blob([output.target.buffer], { type: mime }), extension: container };
  } finally {
    for (const input of toDispose) {
      try {
        input.dispose();
      } catch (_) {
        /* ignore */
      }
    }
  }
}
