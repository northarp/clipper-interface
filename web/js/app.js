import {
  W, H, PLATFORMS, SAFE_ZONES, clamp, drawFrame, layoutRects, coverCrop, overlayRect, frameAt, showSecondImageAt,
} from './compose.js';
import { isKind, loadBitmap, loadOverlay } from './media.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  platform: 'tiktok',
  layout: 'video',
  fit: 'fill',
  swap: false,
  splitRatio: 0.5,
  arrangement: 'side-by-side',
  quality: 'standard',
  showSafe: true,
  clip: null, // { file, name, url, duration, fx, fy, volume }
  background: null, // { file, name, url, fx, fy }
  bgVolume: 0,
  images: [null, null], // { file, name, src, w, h, fx, fy }
  overlay: null, // { file, name, src, frames, iw, ih, cx, cy, scale, opacity }
  trim: { start: 0, end: 0 },
  exporting: false,
};

const PREFS = ['platform', 'layout', 'fit', 'quality', 'showSafe'];
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (_) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      /* storage unavailable */
    }
  },
};
Object.assign(state, store.get('clipper.prefs', {}));
const savePrefs = () => store.set('clipper.prefs', Object.fromEntries(PREFS.map((k) => [k, state[k]])));

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');

// Hidden media elements that feed the preview canvas.
const pool = document.createElement('div');
pool.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;overflow:hidden';
document.body.append(pool);
const makeVideo = (muted) => {
  const v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'auto';
  v.muted = muted;
  pool.append(v);
  return v;
};
const vClip = makeVideo(false);
const vBg = makeVideo(true);
vBg.loop = true;

const fmt = (t) => {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
};

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 3200);
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#themeLabel').textContent = theme === 'green' ? 'Purple' : 'Green';
  $('#themeBtn').title = `Switch to the ${theme === 'green' ? 'purple' : 'green'} colourway`;
  try {
    localStorage.setItem('clipper.theme', theme);
  } catch (_) {
    /* ignore */
  }
}
$('#themeBtn').addEventListener('click', () =>
  applyTheme(document.documentElement.dataset.theme === 'purple' ? 'green' : 'purple')
);
applyTheme(document.documentElement.dataset.theme === 'purple' ? 'purple' : 'green');

// ---------------------------------------------------------------------------
// Loading files
// ---------------------------------------------------------------------------

const SLOT_KIND = { clip: 'video', background: 'video', image0: 'image', image1: 'image', overlay: 'overlay' };

async function loadSlot(slot, file) {
  const kind = SLOT_KIND[slot];
  if (!isKind(file, kind)) {
    toast(`"${file.name}" isn't ${kind === 'video' ? 'a video' : 'an image'}.`);
    return;
  }
  try {
    if (slot === 'clip') {
      pause();
      if (state.clip) URL.revokeObjectURL(state.clip.url);
      const url = URL.createObjectURL(file);
      state.clip = { file, name: file.name, url, duration: 0, fx: 0.5, fy: 0.5, volume: num('#clipVolume') / 100 };
      state.trim = { start: 0, end: 0 };
      setPreviewMsg('');
      vClip.src = url;
    } else if (slot === 'background') {
      if (state.background) URL.revokeObjectURL(state.background.url);
      const url = URL.createObjectURL(file);
      state.background = { file, name: file.name, url, fx: 0.5, fy: 0.5 };
      vBg.src = url;
      if (state.layout !== 'split-video') setLayout('split-video');
    } else if (slot === 'image0' || slot === 'image1') {
      let i = slot === 'image1' && state.images[0] ? 1 : 0;
      const bmp = await loadBitmap(file);
      state.images[i] = { file, name: file.name, ...bmp, fx: 0.5, fy: 0.5 };
      if (state.layout !== 'split-image') setLayout('split-image');
    } else if (slot === 'overlay') {
      const prev = state.overlay;
      const ov = await loadOverlay(file);
      state.overlay = {
        file, name: file.name, ...ov,
        cx: prev ? prev.cx : 0.5,
        cy: prev ? prev.cy : 0.5,
        scale: num('#ovScale') / 100,
        opacity: num('#ovOpacity') / 100,
      };
    }
  } catch (err) {
    toast(`Couldn't open "${file.name}".`);
    console.error(err);
  }
  render();
}

function clearSlot(slot) {
  if (slot === 'clip' && state.clip) {
    pause();
    URL.revokeObjectURL(state.clip.url);
    state.clip = null;
    state.trim = { start: 0, end: 0 };
    vClip.removeAttribute('src');
    vClip.load();
    setPreviewMsg('');
  } else if (slot === 'background' && state.background) {
    URL.revokeObjectURL(state.background.url);
    state.background = null;
    vBg.removeAttribute('src');
    vBg.load();
  } else if (slot === 'image0') {
    state.images = [state.images[1], null];
  } else if (slot === 'image1') {
    state.images[1] = null;
  } else if (slot === 'overlay') {
    state.overlay = null;
  }
  render();
}

vClip.addEventListener('loadedmetadata', () => {
  if (!state.clip) return;
  state.clip.duration = vClip.duration;
  state.trim = { start: 0, end: vClip.duration };
  render();
});
vClip.addEventListener('error', () => {
  if (state.clip) {
    setPreviewMsg("Your browser can't play this file. Try converting it to MP4 (H.264).");
  }
});

function setPreviewMsg(msg) {
  $('#previewMsg').textContent = msg;
  $('#previewMsg').hidden = !msg;
}

// Drop zones: click to browse, or drag & drop.
for (const drop of $$('.drop')) {
  const slot = drop.dataset.slot;
  const input = $('input[type=file]', drop);
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    await loadSlot(slot, files[0]);
    if (slot === 'image0' && files[1]) await loadSlot('image1', files[1]);
  });
  $('.x', drop).addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearSlot(slot);
  });
  drop.addEventListener('click', (e) => {
    if (drop.classList.contains('has')) e.preventDefault(); // filled: don't reopen the picker
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    await loadSlot(slot, files[0]);
    if (slot === 'image0' && files[1]) await loadSlot('image1', files[1]);
  });
}
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// UI rendering
// ---------------------------------------------------------------------------

const num = (sel) => Number($(sel).value);

function setLayout(layout) {
  const wasPlaying = isPlaying();
  pause();
  state.layout = layout;
  savePrefs();
  render();
  if (wasPlaying) play();
}

function render() {
  const { layout } = state;
  const isSplit = layout !== 'video';
  const mark = (sel, attr, value) => $$(sel).forEach((b) => b.classList.toggle('on', b.dataset[attr] === value));
  mark('#platforms button', 'platform', state.platform);
  $$('#platforms button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.platform === state.platform)));
  mark('#layouts .tile', 'layout', layout);
  mark('#fit button', 'fit', state.fit);
  mark('#arrangement button', 'arr', state.arrangement);
  mark('#quality button', 'q', state.quality);

  $$('[data-show]').forEach((n) => (n.hidden = !n.dataset.show.split(' ').includes(layout)));

  const slots = {
    clip: state.clip, background: state.background,
    image0: state.images[0], image1: state.images[1], overlay: state.overlay,
  };
  for (const [slot, val] of Object.entries(slots)) {
    const drop = $(`.drop[data-slot="${slot}"]`);
    drop.classList.toggle('has', !!val);
    $('.name', drop).textContent = val ? val.name : '';
    $('.name', drop).title = val ? val.name : '';
  }
  $('.drop[data-slot="image1"]').classList.toggle('off', !state.images[0]);
  $('#arrangeRow').hidden = !(state.images[0] && state.images[1]);
  $('#panHint').hidden = !(state.clip && (isSplit || state.fit === 'fill'));

  $$('output[for]').forEach((o) => (o.textContent = `${$(`#${o.htmlFor}`).value}%`));

  const ov = state.overlay;
  $('#overlayControls').classList.toggle('off', !ov);
  if (ov) {
    $('#ovScale').value = Math.round(ov.scale * 100);
    $('#ovOpacity').value = Math.round(ov.opacity * 100);
    $('output[for="ovScale"]').textContent = `${Math.round(ov.scale * 100)}%`;
    $('output[for="ovOpacity"]').textContent = `${Math.round(ov.opacity * 100)}%`;
  }

  $('#showSafe').checked = state.showSafe;
  vClip.volume = state.clip ? clamp(state.clip.volume, 0, 1) : 1;
  vBg.volume = clamp(state.bgVolume, 0, 1);
  vBg.muted = state.bgVolume === 0;

  renderTimeline();
  const problem = exportProblem();
  $('#exportBtn').disabled = state.exporting || !!problem;
  $('#exportBtn').title = problem || '';
}

function renderTimeline() {
  const dur = state.clip ? state.clip.duration : 0;
  const { start, end } = state.trim;
  const pct = (t) => (dur ? (t / dur) * 100 : 0);
  $('#tlIn').style.left = `${pct(start)}%`;
  $('#tlOut').style.left = `${dur ? pct(end) : 100}%`;
  $('#tlRange').style.left = `${pct(start)}%`;
  $('#tlRange').style.width = `${pct(end - start)}%`;
  $('#timeTotal').textContent = fmt(dur);
  $('#trimInfo').textContent = `${fmt(start)} → ${fmt(end)} · ${fmt(end - start)} long`;

  const max = PLATFORMS[state.platform].maxSeconds;
  const len = end - start;
  const warn = $('#warn');
  warn.hidden = !(state.clip && len > max);
  if (!warn.hidden) {
    warn.textContent = `${PLATFORMS[state.platform].label} allows up to ${max / 60} min. This clip is ${fmt(len)}. Drag the timeline handles to trim it.`;
  }
}

// ---------------------------------------------------------------------------
// Preview canvas
// ---------------------------------------------------------------------------

let guides = { x: false, y: false };

function sizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.min(W, Math.round(r.width * dpr));
  const h = Math.round((w * H) / W);
  if (w > 0 && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w;
    canvas.height = h;
  }
}
new ResizeObserver(sizeCanvas).observe(canvas);

function previewTime() {
  return Math.max(0, (vClip.currentTime || 0) - state.trim.start);
}

function mediaOf(video, data) {
  if (!data || video.readyState < 2 || !video.videoWidth) return null;
  return { src: video, w: video.videoWidth, h: video.videoHeight, fx: data.fx, fy: data.fy };
}

function scene() {
  const t = previewTime();
  const ov = state.overlay;
  return {
    layout: state.layout,
    fit: state.fit,
    swap: state.swap,
    splitRatio: state.splitRatio,
    arrangement: state.arrangement,
    showSecondImage: showSecondImageAt(t, state.trim.end - state.trim.start),
    clip: mediaOf(vClip, state.clip),
    background: state.layout === 'split-video' ? mediaOf(vBg, state.background) : null,
    images: state.images.filter(Boolean),
    overlay: ov && { ...ov, src: ov.frames ? frameAt(ov.frames, t) : ov.src },
    placeholders: true,
  };
}

function draw() {
  const s = canvas.width / W;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  const sc = scene();
  drawFrame(ctx, sc);

  if (state.showSafe) {
    const z = SAFE_ZONES[state.platform];
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, W, H * z.top);
    ctx.fillRect(0, H * (1 - z.bottom), W, H * z.bottom);
    ctx.fillRect(0, H * z.top, W * z.left, H * (1 - z.top - z.bottom));
    ctx.fillRect(W * (1 - z.right), H * z.top, W * z.right, H * (1 - z.top - z.bottom));
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([14, 10]);
    ctx.lineWidth = 2 / s;
    ctx.strokeRect(W * z.left, H * z.top, W * (1 - z.left - z.right), H * (1 - z.top - z.bottom));
    ctx.restore();
  }

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--light').trim() || '#86efac';
  if (state.overlay && (overlayHover || overlayDragging)) {
    const r = overlayRect(state.overlay);
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3 / s;
    ctx.setLineDash([12, 8]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }
  if (guides.x || guides.y) {
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2 / s;
    if (guides.x) ctx.strokeRect(W / 2, 0, 0, H);
    if (guides.y) ctx.strokeRect(0, H / 2, W, 0);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

const isPlaying = () => !vClip.paused;

function syncBg(force) {
  if (state.layout !== 'split-video' || !state.background || !vBg.duration) return;
  const want = previewTime() % vBg.duration;
  if (force || Math.abs(vBg.currentTime - want) > 0.3) vBg.currentTime = want;
}

function loop() {
  if (isPlaying() && state.clip) {
    if (vClip.currentTime >= state.trim.end - 0.03) {
      vClip.currentTime = state.trim.start;
      syncBg(true);
    } else {
      syncBg(false);
    }
  }
  if (state.clip) {
    const d = state.clip.duration || 1;
    $('#tlHead').style.left = `${(vClip.currentTime / d) * 100}%`;
    $('#tlHead').hidden = false;
  } else {
    $('#tlHead').hidden = true;
  }
  $('#timeNow').textContent = fmt(vClip.currentTime);
  draw();
  requestAnimationFrame(loop);
}

function play() {
  if (!state.clip || state.exporting) return;
  const t = vClip.currentTime;
  if (t < state.trim.start || t >= state.trim.end - 0.05) vClip.currentTime = state.trim.start;
  syncBg(true);
  vClip.play().catch(() => {});
  if (state.layout === 'split-video' && state.background) vBg.play().catch(() => {});
  $('#playBtn').classList.add('playing');
}

function pause() {
  vClip.pause();
  vBg.pause();
  $('#playBtn').classList.remove('playing');
}

function seek(t) {
  if (!state.clip) return;
  vClip.currentTime = clamp(t, 0, state.clip.duration || 0);
  syncBg(true);
}

$('#playBtn').addEventListener('click', () => (isPlaying() ? pause() : play()));

// ---------------------------------------------------------------------------
// Timeline / trim
// ---------------------------------------------------------------------------

const MIN_TRIM = 0.2;
const timeline = $('#timeline');

function timeAt(e) {
  const r = timeline.getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 1) * (state.clip ? state.clip.duration : 0);
}
function setStart(t) {
  state.trim.start = clamp(t, 0, state.trim.end - MIN_TRIM);
  renderTimeline();
}
function setEnd(t) {
  state.trim.end = clamp(t, state.trim.start + MIN_TRIM, state.clip.duration);
  renderTimeline();
}

function dragger(el, onMove) {
  el.addEventListener('pointerdown', (e) => {
    if (!state.clip || !state.clip.duration) return;
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const move = (ev) => onMove(timeAt(ev));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    onMove(timeAt(e));
  });
}
dragger($('#tlIn'), (t) => {
  setStart(t);
  seek(state.trim.start);
});
dragger($('#tlOut'), (t) => {
  setEnd(t);
  seek(state.trim.end);
});
dragger(timeline, seek);
$('#setIn').addEventListener('click', () => state.clip && setStart(vClip.currentTime));
$('#setOut').addEventListener('click', () => state.clip && setEnd(vClip.currentTime));

// ---------------------------------------------------------------------------
// Canvas interaction: drag overlay, pan media, wheel to resize overlay
// ---------------------------------------------------------------------------

let overlayHover = false;
let overlayDragging = false;
const SNAP = 0.015;

function toOutput(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H, scale: W / r.width };
}
const inside = (p, r, pad = 0) => r && p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;

function overlayAt(p) {
  return state.overlay && inside(p, overlayRect(state.overlay), 12);
}

function panTargetAt(p) {
  const imgs = state.images.filter(Boolean);
  const rects = layoutRects({ ...state, imageCount: imgs.length });
  const isSplit = state.layout !== 'video';
  if (inside(p, rects.clip) && state.clip && vClip.videoWidth && (isSplit || state.fit === 'fill')) {
    return { data: state.clip, w: vClip.videoWidth, h: vClip.videoHeight, rect: rects.clip };
  }
  if (state.layout === 'split-video' && inside(p, rects.other) && state.background && vBg.videoWidth) {
    return { data: state.background, w: vBg.videoWidth, h: vBg.videoHeight, rect: rects.other };
  }
  if (state.layout === 'split-image' && inside(p, rects.other) && imgs.length) {
    let i = 0;
    if (imgs.length === 2 && state.arrangement === 'side-by-side') i = inside(p, rects.images[0]) ? 0 : 1;
    else if (imgs.length === 2) i = showSecondImageAt(previewTime(), state.trim.end - state.trim.start) ? 1 : 0;
    const rect = imgs.length === 2 && state.arrangement === 'side-by-side' ? rects.images[i] : rects.other;
    return { data: imgs[i], w: imgs[i].w, h: imgs[i].h, rect };
  }
  return null;
}

canvas.addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  const p = toOutput(e);
  overlayHover = !!overlayAt(p);
  canvas.style.cursor = overlayHover ? 'move' : panTargetAt(p) ? 'grab' : 'default';
});
canvas.addEventListener('pointerleave', () => (overlayHover = false));

canvas.addEventListener('pointerdown', (e) => {
  const p0 = toOutput(e);
  const startX = e.clientX;
  const startY = e.clientY;
  let move;

  if (overlayAt(p0)) {
    const ov = state.overlay;
    const cx0 = ov.cx;
    const cy0 = ov.cy;
    overlayDragging = true;
    move = (ev) => {
      let cx = cx0 + ((ev.clientX - startX) * p0.scale) / W;
      let cy = cy0 + ((ev.clientY - startY) * p0.scale) / H;
      guides = { x: false, y: false };
      if (!ev.altKey) {
        if (Math.abs(cx - 0.5) < SNAP) (cx = 0.5), (guides.x = true);
        if (Math.abs(cy - 0.5) < SNAP) (cy = 0.5), (guides.y = true);
      }
      ov.cx = clamp(cx, -0.5, 1.5);
      ov.cy = clamp(cy, -0.5, 1.5);
    };
  } else {
    const target = panTargetAt(p0);
    if (!target) return;
    const c = coverCrop(target.w, target.h, target.rect);
    if (c.overX < 1 && c.overY < 1) return;
    const fx0 = target.data.fx;
    const fy0 = target.data.fy;
    canvas.style.cursor = 'grabbing';
    move = (ev) => {
      // Dragging right reveals more of the left side, so the focus moves left.
      if (c.overX >= 1) target.data.fx = clamp(fx0 - ((ev.clientX - startX) * p0.scale) / c.overX, 0, 1);
      if (c.overY >= 1) target.data.fy = clamp(fy0 - ((ev.clientY - startY) * p0.scale) / c.overY, 0, 1);
    };
  }

  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  const up = () => {
    overlayDragging = false;
    guides = { x: false, y: false };
    canvas.style.cursor = 'default';
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
  };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
});

// Double-click media to re-centre it.
canvas.addEventListener('dblclick', (e) => {
  const p = toOutput(e);
  if (overlayAt(p)) return;
  const target = panTargetAt(p);
  if (target) target.data.fx = target.data.fy = 0.5;
});

canvas.addEventListener(
  'wheel',
  (e) => {
    if (!overlayAt(toOutput(e))) return;
    e.preventDefault();
    state.overlay.scale = clamp(state.overlay.scale + (e.deltaY < 0 ? 0.02 : -0.02), 0.05, 1);
    render();
  },
  { passive: false }
);

function placeOverlay(pos) {
  const ov = state.overlay;
  if (!ov) return;
  const w = ov.scale;
  const h = (ov.scale * W * ov.ih) / ov.iw / H;
  const z = state.showSafe ? SAFE_ZONES[state.platform] : { top: 0.03, bottom: 0.03, left: 0.03, right: 0.03 };
  const xs = { l: z.left + w / 2, c: 0.5, r: 1 - z.right - w / 2 };
  const ys = { t: z.top + h / 2, m: 0.5, b: 1 - z.bottom - h / 2 };
  ov.cx = xs[pos[1]];
  ov.cy = ys[pos[0]];
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

const onClick = (sel, attr, fn) =>
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest(`[data-${attr}]`);
    if (b) fn(b.dataset[attr]);
  });

onClick('#platforms', 'platform', (v) => {
  state.platform = v;
  savePrefs();
  render();
});
onClick('#layouts', 'layout', setLayout);
onClick('#fit', 'fit', (v) => {
  state.fit = v;
  savePrefs();
  render();
});
onClick('#arrangement', 'arr', (v) => {
  state.arrangement = v;
  render();
});
onClick('#quality', 'q', (v) => {
  state.quality = v;
  savePrefs();
  render();
});
onClick('#pos', 'pos', placeOverlay);

$('#clipVolume').addEventListener('input', (e) => {
  if (state.clip) state.clip.volume = e.target.value / 100;
  render();
});
$('#bgVolume').addEventListener('input', (e) => {
  state.bgVolume = e.target.value / 100;
  render();
});
$('#splitRatio').addEventListener('input', (e) => {
  state.splitRatio = e.target.value / 100;
  render();
});
$('#swap').addEventListener('change', (e) => {
  state.swap = e.target.checked;
  render();
});
$('#ovScale').addEventListener('input', (e) => {
  if (state.overlay) state.overlay.scale = e.target.value / 100;
  render();
});
$('#ovOpacity').addEventListener('input', (e) => {
  if (state.overlay) state.overlay.opacity = e.target.value / 100;
  render();
});
$('#showSafe').addEventListener('change', (e) => {
  state.showSafe = e.target.checked;
  savePrefs();
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    isPlaying() ? pause() : play();
  } else if (e.key === 'i' || e.key === 'I') {
    if (state.clip) setStart(vClip.currentTime);
  } else if (e.key === 'o' || e.key === 'O') {
    if (state.clip) setEnd(vClip.currentTime);
  } else if (e.key.startsWith('Arrow') && state.overlay) {
    e.preventDefault();
    const step = e.shiftKey ? 0.02 : 0.004;
    if (e.key === 'ArrowLeft') state.overlay.cx -= step;
    if (e.key === 'ArrowRight') state.overlay.cx += step;
    if (e.key === 'ArrowUp') state.overlay.cy -= step;
    if (e.key === 'ArrowDown') state.overlay.cy += step;
  } else if (state.clip && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    seek(vClip.currentTime + (e.key === 'ArrowLeft' ? -1 : 1));
  }
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportProblem() {
  if (!state.clip) return 'Add a clip first.';
  if (!(state.trim.end - state.trim.start > 0)) return 'The clip is still loading.';
  if (state.layout === 'split-video' && !state.background) return 'Add a background video.';
  if (state.layout === 'split-image' && !state.images[0]) return 'Add at least one image.';
  return null;
}

let abort = null;
let lastDownloadUrl = null;

$('#exportBtn').addEventListener('click', async () => {
  const problem = exportProblem();
  if (problem) return toast(problem);
  pause();

  state.exporting = true;
  abort = new AbortController();
  $('#result').hidden = true;
  $('#progress').hidden = false;
  setProgress(0, 'Loading encoder…');
  render();

  const job = {
    layout: state.layout,
    fit: state.fit,
    swap: state.swap,
    splitRatio: state.splitRatio,
    arrangement: state.arrangement,
    quality: state.quality,
    trim: { ...state.trim },
    clip: { file: state.clip.file, fx: state.clip.fx, fy: state.clip.fy, volume: state.clip.volume },
    background: state.background && {
      file: state.background.file, fx: state.background.fx, fy: state.background.fy,
      volume: state.bgVolume, duration: vBg.duration || 0,
    },
    images: state.images.filter(Boolean).map((i) => ({ file: i.file, fx: i.fx, fy: i.fy })),
    overlay: state.overlay && {
      src: state.overlay.src, frames: state.overlay.frames, iw: state.overlay.iw, ih: state.overlay.ih,
      cx: state.overlay.cx, cy: state.overlay.cy, scale: state.overlay.scale, opacity: state.overlay.opacity,
    },
  };

  const started = performance.now();
  try {
    const { exportClip } = await import('./export.js');
    const { blob, extension } = await exportClip(job, { onProgress: setProgress, signal: abort.signal });
    const base = state.clip.name.replace(/\.[^.]+$/, '');
    showDownload(blob, `${base}_${state.platform}.${extension}`, (performance.now() - started) / 1000);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      showResult('Export cancelled.', false);
    } else {
      console.error(err);
      showResult(`Export failed: ${err && err.message ? err.message : err}`, true);
    }
  } finally {
    state.exporting = false;
    abort = null;
    $('#progress').hidden = true;
    render();
  }
});

$('#cancelBtn').addEventListener('click', () => abort && abort.abort());

function setProgress(p, label) {
  const pct = Math.round(p * 100);
  $('#progressFill').style.width = `${pct}%`;
  $('#progressText').textContent = `${label || 'Rendering…'} ${pct}%`;
}

function showResult(text, isError) {
  const el = $('#result');
  el.hidden = false;
  el.className = isError ? 'result error' : 'result';
  el.textContent = text;
}

function showDownload(blob, filename, seconds) {
  if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl);
  lastDownloadUrl = URL.createObjectURL(blob);
  const el = $('#result');
  el.hidden = false;
  el.className = 'result';
  el.replaceChildren();
  const info = document.createElement('span');
  info.textContent = `Ready · ${(blob.size / 1048576).toFixed(1)} MB · ${seconds.toFixed(0)}s`;
  const a = document.createElement('a');
  a.href = lastDownloadUrl;
  a.download = filename;
  a.textContent = 'Download';
  a.id = 'downloadLink';
  el.append(info, a);
  a.click();
  toast('Your video is ready.');
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

if (typeof VideoEncoder === 'undefined') {
  const n = $('#notice');
  n.hidden = false;
  n.textContent =
    "You can preview here, but this browser can't export video. Use a recent Chrome, Edge or Firefox on a computer.";
}

render();
sizeCanvas();
requestAnimationFrame(loop);

// Exposed for automated tests.
window.__clipper = { state, loadSlot, seek };
