'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildArgs, validate, cover } = require('../src/main/build-args');

const base = () => ({
  layout: 'video',
  fit: 'fill',
  clip: { path: 'clip.mp4', hasAudio: true, focusX: 0.5, focusY: 0.5, volume: 1 },
  trim: { start: 2, end: 12 },
  output: { path: 'out.mp4', crf: 20, preset: 'medium' },
});

const graph = (args) => args[args.indexOf('-filter_complex') + 1];
const inputs = (args) => args.filter((_, i) => args[i - 1] === '-i');

test('cover() crops using the focus point', () => {
  assert.equal(
    cover(1080, 960, 0.25, 1),
    'scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960:(iw-ow)*0.25:(ih-oh)*1,setsar=1'
  );
});

test('validate() reports missing pieces', () => {
  assert.match(validate({ layout: 'video' }).join(' '), /Add a clip/);
  const p = { ...base(), layout: 'split-video' };
  assert.match(validate(p).join(' '), /background video/);
  const q = { ...base(), layout: 'split-image', images: [] };
  assert.match(validate(q).join(' '), /at least one image/);
  const r = { ...base(), layout: 'split-image', images: [{ path: 'a' }, { path: 'b' }, { path: 'c' }] };
  assert.match(validate(r).join(' '), /maximum of 2/);
});

test('buildArgs throws on invalid projects', () => {
  assert.throws(() => buildArgs({ layout: 'video' }), /Add a clip/);
});

test('video only / fill trims the input and maps clip audio', () => {
  const { args, duration } = buildArgs(base());
  assert.equal(duration, 10);
  assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 6), ['-ss', '2', '-t', '10', '-i', 'clip.mp4']);
  assert.match(graph(args), /\[0:v\]scale=1080:1920:force_original_aspect_ratio=increase/);
  assert.ok(args.includes('0:a:0'));
  assert.equal(args.at(-1), 'out.mp4');
});

test('video only / blur and bars', () => {
  assert.match(graph(buildArgs({ ...base(), fit: 'blur' }).args), /boxblur.*overlay=\(W-w\)\/2:\(H-h\)\/2/);
  assert.match(graph(buildArgs({ ...base(), fit: 'bars' }).args), /pad=1080:1920/);
});

test('clip without audio produces no audio stream', () => {
  const p = base();
  p.clip.hasAudio = false;
  const { args } = buildArgs(p);
  assert.ok(!args.includes('-c:a'));
  assert.equal(args.filter((a) => a === '-map').length, 1);
});

test('split-video loops the background and stacks halves', () => {
  const p = { ...base(), layout: 'split-video', background: { path: 'bg.mp4', focusX: 0.5, focusY: 0.5 } };
  const { args } = buildArgs(p);
  assert.deepEqual(inputs(args), ['clip.mp4', 'bg.mp4']);
  assert.ok(args.includes('-stream_loop'));
  assert.match(graph(args), /\[clipv\]\[otherv\]vstack/);
  assert.match(graph(args), /crop=1080:960/);
});

test('split ratio and swap', () => {
  const p = { ...base(), layout: 'split-video', splitRatio: 0.6, swap: true, background: { path: 'bg.mp4' } };
  const g = graph(buildArgs(p).args);
  assert.match(g, /crop=1080:1152/);
  assert.match(g, /crop=1080:768/);
  assert.match(g, /\[otherv\]\[clipv\]vstack/);
});

test('background audio is mixed only when volume > 0', () => {
  const p = { ...base(), layout: 'split-video', background: { path: 'bg.mp4', hasAudio: true, volume: 0.3 } };
  assert.match(graph(buildArgs(p).args), /\[1:a\]volume=0.3\[a1\];\[a0\]\[a1\]amix/);
  p.background.volume = 0;
  assert.doesNotMatch(graph(buildArgs(p).args), /amix/);
});

test('split-image with one, two side-by-side, and two switching images', () => {
  const one = { ...base(), layout: 'split-image', images: [{ path: 'a.png' }] };
  assert.match(graph(buildArgs(one).args), /\[1:v\]scale=1080:960/);

  const two = { ...one, images: [{ path: 'a.png' }, { path: 'b.png' }], imageArrangement: 'side-by-side' };
  const g2 = graph(buildArgs(two).args);
  assert.match(g2, /crop=540:960/);
  assert.match(g2, /hstack=inputs=2/);

  const sw = { ...two, imageArrangement: 'switch' };
  assert.match(graph(buildArgs(sw).args), /enable='gte\(t,5\)'/);
});

test('overlay is scaled and positioned by its centre point', () => {
  const p = { ...base(), overlay: { path: 'logo.png', cx: 0.5, cy: 0.1, scale: 0.4, opacity: 0.5 } };
  const { args } = buildArgs(p);
  const g = graph(args);
  assert.match(g, /\[1:v\]scale=432:-2,format=rgba,colorchannelmixer=aa=0.5\[ov\]/);
  assert.match(g, /overlay=x='main_w\*0.5-overlay_w\/2':y='main_h\*0.1-overlay_h\/2'/);
  assert.match(g, /\[withov\]fps=30/);
});

test('gif overlays loop with -ignore_loop', () => {
  const p = { ...base(), overlay: { path: 'a.gif', isGif: true, cx: 0.5, cy: 0.5, scale: 0.3, opacity: 1 } };
  const { args } = buildArgs(p);
  assert.ok(args.includes('-ignore_loop'));
  assert.doesNotMatch(graph(args), /colorchannelmixer/);
});
