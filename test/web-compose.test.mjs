import test from 'node:test';
import assert from 'node:assert/strict';
import { W, H, layoutRects, coverCrop, containRect, overlayRect, frameAt, showSecondImageAt } from '../web/js/compose.js';

test('video layout uses the whole frame', () => {
  assert.deepEqual(layoutRects({ layout: 'video' }).clip, { x: 0, y: 0, w: W, h: H });
});

test('split layouts stack clip and other half, with swap and ratio', () => {
  const r = layoutRects({ layout: 'split-video', splitRatio: 0.5 });
  assert.deepEqual(r.clip, { x: 0, y: 0, w: 1080, h: 960 });
  assert.deepEqual(r.other, { x: 0, y: 960, w: 1080, h: 960 });
  const s = layoutRects({ layout: 'split-video', splitRatio: 0.6, swap: true });
  assert.deepEqual(s.clip, { x: 0, y: 768, w: 1080, h: 1152 });
  assert.deepEqual(s.other, { x: 0, y: 0, w: 1080, h: 768 });
});

test('two images side by side split the other half', () => {
  const r = layoutRects({ layout: 'split-image', imageCount: 2, arrangement: 'side-by-side' });
  assert.deepEqual(r.images[0], { x: 0, y: 960, w: 540, h: 960 });
  assert.deepEqual(r.images[1], { x: 540, y: 960, w: 540, h: 960 });
});

test('coverCrop matches object-fit: cover with a focus point', () => {
  // 1920×1080 into 1080×960: scale = 960/1080, visible source width = 1215
  const c = coverCrop(1920, 1080, { x: 0, y: 0, w: 1080, h: 960 }, 0, 0.5);
  assert.equal(c.sx, 0);
  assert.ok(Math.abs(c.sw - 1215) < 1e-9);
  assert.equal(c.sh, 1080);
  const right = coverCrop(1920, 1080, { x: 0, y: 0, w: 1080, h: 960 }, 1, 0.5);
  assert.ok(Math.abs(right.sx - (1920 - 1215)) < 1e-9);
  assert.ok(right.overX > 0 && right.overY === 0);
});

test('containRect letterboxes and centres', () => {
  assert.deepEqual(containRect(1920, 1080, { x: 0, y: 0, w: 1080, h: 1920 }), { x: 0, y: 656.25, w: 1080, h: 607.5 });
});

test('overlayRect is positioned by its centre', () => {
  const r = overlayRect({ iw: 600, ih: 200, cx: 0.5, cy: 0.1, scale: 0.4 });
  assert.deepEqual(r, { x: 324, y: 192 - 72, w: 432, h: 144 });
});

test('animated overlay frames loop over time', () => {
  const frames = [{ image: 'a', duration: 0.1 }, { image: 'b', duration: 0.2 }];
  assert.equal(frameAt(frames, 0), 'a');
  assert.equal(frameAt(frames, 0.15), 'b');
  assert.equal(frameAt(frames, 0.31), 'a');
  assert.equal(frameAt(null, 1), null);
});

test('switch arrangement flips at the halfway point', () => {
  assert.equal(showSecondImageAt(4.9, 10), false);
  assert.equal(showSecondImageAt(5, 10), true);
});
