'use strict';

/**
 * End-to-end: generate synthetic media, render every layout with the real
 * ffmpeg binary, and check the output is a 1080×1920 video of the right length.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildArgs } = require('../src/main/build-args');
const { FFMPEG, probe, render } = require('../src/main/ffmpeg');

let tmp;
const f = (name) => path.join(tmp, name);

function ffmpegAvailable() {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

const skip = !ffmpegAvailable() && 'ffmpeg not available';

test.before(() => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-test-'));
  const run = (args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  // 16:9 clip with audio, 6 s
  run(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('clip.mp4')]);
  // Short background video with audio (2 s, so it must loop)
  run(['-f', 'lavfi', '-i', 'mandelbrot=size=640x480:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=220',
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f('bg.mp4')]);
  run(['-f', 'lavfi', '-i', 'color=c=red:size=800x600', '-frames:v', '1', f('a.png')]);
  run(['-f', 'lavfi', '-i', 'color=c=blue:size=600x900', '-frames:v', '1', f('b.jpg')]);
  // Transparent PNG overlay
  run(['-f', 'lavfi', '-i', 'color=c=white@0.5:size=400x200,format=rgba', '-frames:v', '1', f('logo.png')]);
  run(['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=1', f('anim.gif')]);
});

test.after(() => tmp && fs.rmSync(tmp, { recursive: true, force: true }));

const cases = {
  'video fill': { layout: 'video', fit: 'fill' },
  'video blur': { layout: 'video', fit: 'blur' },
  'video bars + overlay': {
    layout: 'video', fit: 'bars',
    overlay: { path: 'logo.png', cx: 0.5, cy: 0.15, scale: 0.4, opacity: 0.8 },
  },
  'clip over video (looping bg, mixed audio)': {
    layout: 'split-video',
    background: { path: 'bg.mp4', hasAudio: true, volume: 0.3, focusX: 0.5, focusY: 0.5 },
  },
  'clip over 1 image, swapped': { layout: 'split-image', swap: true, splitRatio: 0.6, images: [{ path: 'a.png' }] },
  'clip over 2 images side by side + gif overlay': {
    layout: 'split-image', images: [{ path: 'a.png' }, { path: 'b.jpg' }], imageArrangement: 'side-by-side',
    overlay: { path: 'anim.gif', isGif: true, cx: 0.8, cy: 0.9, scale: 0.25, opacity: 1 },
  },
  'clip over 2 images switching': {
    layout: 'split-image', images: [{ path: 'a.png' }, { path: 'b.jpg' }], imageArrangement: 'switch',
  },
};

for (const [name, extra] of Object.entries(cases)) {
  test(`renders: ${name}`, { skip, timeout: 120000 }, async () => {
    const out = f(`${name.replace(/\W+/g, '_')}.mp4`);
    const resolve = (o) => (o && o.path ? { ...o, path: f(o.path) } : o);
    const project = {
      clip: { path: f('clip.mp4'), hasAudio: true, focusX: 0.3, focusY: 0.5, volume: 1 },
      trim: { start: 1, end: 4.5 },
      output: { path: out, crf: 30, preset: 'ultrafast' },
      ...extra,
      background: resolve(extra.background),
      overlay: resolve(extra.overlay),
      images: (extra.images || []).map(resolve),
    };
    const { args, duration } = buildArgs(project);
    let last = 0;
    await render(args, duration, (p) => (last = p)).promise;
    assert.equal(last, 1, 'progress should reach 100%');

    const info = await probe(out);
    assert.equal(info.width, 1080);
    assert.equal(info.height, 1920);
    assert.ok(info.hasAudio);
    assert.ok(Math.abs(info.duration - 3.5) < 0.15, `duration ${info.duration}`);
  });
}
