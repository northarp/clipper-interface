'use strict';

/* global clipper */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUT_W = 1080;
const OUT_H = 1920;

// Approximate areas covered by each app's UI (fractions of the 1080×1920 frame).
const SAFE_ZONES = {
  tiktok: { top: 0.08, bottom: 0.2, left: 0.05, right: 0.13, label: '(TikTok)' },
  reels: { top: 0.11, bottom: 0.22, left: 0.05, right: 0.11, label: '(Reels)' },
  shorts: { top: 0.08, bottom: 0.2, left: 0.05, right: 0.14, label: '(Shorts)' },
};
const MAX_SECONDS = { tiktok: 600, reels: 180, shorts: 180 };
const PLATFORM_LABEL = { tiktok: 'TikTok', reels: 'Instagram Reels', shorts: 'YouTube Shorts' };

const QUALITY = {
  draft: { crf: 26, preset: 'veryfast' },
  standard: { crf: 21, preset: 'medium' },
  high: { crf: 18, preset: 'slow' },
};

const EXT = {
  video: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'bmp'],
  overlay: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
};
const SLOT_KIND = { clip: 'video', background: 'video', image0: 'image', image1: 'image', overlay: 'overlay' };

const SNAP = 0.015;
const MIN_TRIM = 0.2;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  platform: 'tiktok',
  layout: 'video',
  fit: 'fill',
  swap: false,
  splitRatio: 0.5,
  clip: null, // { path, url, name, duration, hasAudio, focusX, focusY, volume }
  background: null, // { path, url, name, hasAudio, focusX, focusY }
  bgVolume: 0,
  images: [null, null], // { path, url, name, focusX, focusY }
  imageArrangement: 'side-by-side',
  overlay: null, // { path, url, name, isGif, aspect, cx, cy, scale, opacity }
  trim: { start: 0, end: 0 },
  quality: 'standard',
  showSafe: true,
  snap: true,
  exporting: false,
};

const PREF_KEYS = ['platform', 'quality', 'showSafe', 'snap', 'layout', 'fit'];

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem('clipper.prefs') || '{}');
    for (const k of PREF_KEYS) if (k in saved) state[k] = saved[k];
  } catch (_) {
    /* ignore */
  }
}
function savePrefs() {
  try {
    const out = {};
    for (const k of PREF_KEYS) out[k] = state[k];
    localStorage.setItem('clipper.prefs', JSON.stringify(out));
  } catch (_) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const el = {
  frame: $('#frame'),
  regionClip: $('#regionClip'),
  regionOther: $('#regionOther'),
  vClip: $('#vClip'),
  vClipBg: $('#vClipBg'),
  vBg: $('#vBg'),
  imgs: $('#imgs'),
  img0: $('#img0'),
  img1: $('#img1'),
  overlay: $('#overlay'),
  safe: $('#safe'),
  guideV: $('#guideV'),
  guideH: $('#guideH'),
  previewError: $('#previewError'),
  playBtn: $('#playBtn'),
  timeline: $('#timeline'),
  tlRange: $('#tlRange'),
  tlIn: $('#tlIn'),
  tlOut: $('#tlOut'),
  tlHead: $('#tlHead'),
  timeNow: $('#timeNow'),
  timeTotal: $('#timeTotal'),
  trimInfo: $('#trimInfo'),
  durationWarning: $('#durationWarning'),
  exportBtn: $('#exportBtn'),
  progress: $('#progress'),
  progressFill: $('#progressFill'),
  progressText: $('#progressText'),
  result: $('#result'),
  toast: $('#toast'),
};

function fmt(t) {
  if (!Number.isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('on'), 3200);
}

function extOf(name) {
  const m = /\.([^.]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

// ---------------------------------------------------------------------------
// Loading media
// ---------------------------------------------------------------------------

async function loadSlot(slot, file) {
  const kind = SLOT_KIND[slot];
  if (!EXT[kind].includes(extOf(file.name))) {
    toast(`"${file.name}" isn't a supported ${kind === 'video' ? 'video' : 'image'} file.`);
    return;
  }

  if (slot === 'clip') {
    pause();
    const info = await clipper.probe(file.path);
    state.clip = {
      ...file,
      duration: info.duration || 0,
      hasAudio: info.hasAudio,
      focusX: 0.5,
      focusY: 0.5,
      volume: Number($('#clipVolume').value) / 100,
    };
    state.trim = { start: 0, end: info.duration || 0 };
    hidePreviewError();
    el.vClip.src = file.url;
    el.vClipBg.src = file.url;
    el.vClip.load();
  } else if (slot === 'background') {
    const info = await clipper.probe(file.path);
    state.background = { ...file, hasAudio: info.hasAudio, focusX: 0.5, focusY: 0.5 };
    el.vBg.src = file.url;
    if (state.layout === 'video') setLayout('split-video');
  } else if (slot === 'image0' || slot === 'image1') {
    let i = slot === 'image0' ? 0 : 1;
    if (i === 1 && !state.images[0]) i = 0; // fill the first free slot
    state.images[i] = { ...file, focusX: 0.5, focusY: 0.5 };
    if (state.layout !== 'split-image') setLayout('split-image');
  } else if (slot === 'overlay') {
    const prev = state.overlay;
    state.overlay = {
      ...file,
      isGif: extOf(file.name) === 'gif',
      aspect: 1,
      cx: prev ? prev.cx : 0.5,
      cy: prev ? prev.cy : 0.5,
      scale: Number($('#ovScale').value) / 100,
      opacity: Number($('#ovOpacity').value) / 100,
    };
    el.overlay.src = file.url;
    el.overlay.classList.add('selected');
  }
  render();
}

function clearSlot(slot) {
  if (slot === 'clip') {
    pause();
    state.clip = null;
    state.trim = { start: 0, end: 0 };
    el.vClip.removeAttribute('src');
    el.vClipBg.removeAttribute('src');
    el.vClip.load();
    el.vClipBg.load();
    hidePreviewError();
  } else if (slot === 'background') {
    state.background = null;
    el.vBg.removeAttribute('src');
    el.vBg.load();
  } else if (slot === 'image0') {
    state.images = [state.images[1], null];
  } else if (slot === 'image1') {
    state.images[1] = null;
  } else if (slot === 'overlay') {
    state.overlay = null;
    el.overlay.removeAttribute('src');
  }
  render();
}

async function pick(slot) {
  const kind = SLOT_KIND[slot];
  const files = await clipper.openFile(kind, slot === 'image0');
  if (!files.length) return;
  await loadSlot(slot, files[0]);
  // Picking two images at once fills both slots.
  if (slot === 'image0' && files[1]) await loadSlot('image1', files[1]);
}

el.vClip.addEventListener('loadedmetadata', () => {
  if (!state.clip) return;
  if (!state.clip.duration && Number.isFinite(el.vClip.duration)) {
    state.clip.duration = el.vClip.duration;
    state.trim = { start: 0, end: el.vClip.duration };
  }
  el.vClip.currentTime = state.trim.start;
  render();
});
el.vClip.addEventListener('error', () => {
  if (state.clip) {
    showPreviewError(
      "This clip's format can't be previewed here, but it can still be exported. " +
        'Convert it to MP4 (H.264) for a live preview.'
    );
  }
});
el.overlay.addEventListener('load', () => {
  if (!state.overlay) return;
  const { naturalWidth: w, naturalHeight: h } = el.overlay;
  if (w && h) state.overlay.aspect = h / w;
  render();
});

function showPreviewError(msg) {
  el.previewError.textContent = msg;
  el.previewError.classList.add('on');
}
function hidePreviewError() {
  el.previewError.classList.remove('on');
}

// ---------------------------------------------------------------------------
// Rendering the UI from state
// ---------------------------------------------------------------------------

function setLayout(layout) {
  state.layout = layout;
  savePrefs();
  render();
}

function render() {
  const { layout } = state;
  const isSplit = layout !== 'video';

  // Toggle buttons
  $$('#platforms button').forEach((b) => b.classList.toggle('active', b.dataset.platform === state.platform));
  $$('#layouts .layout').forEach((b) => b.classList.toggle('active', b.dataset.layout === layout));
  $$('#fitMode button').forEach((b) => b.classList.toggle('active', b.dataset.fit === state.fit));
  $$('#arrangement button').forEach((b) => b.classList.toggle('active', b.dataset.arr === state.imageArrangement));

  // Sections shown per layout
  $$('[data-show]').forEach((node) => {
    node.hidden = !node.dataset.show.split(' ').includes(layout);
  });
  $('[data-show-fill]').hidden = !(state.clip && (isSplit || state.fit === 'fill'));

  // Drop zones
  const slots = {
    clip: state.clip,
    background: state.background,
    image0: state.images[0],
    image1: state.images[1],
    overlay: state.overlay,
  };
  for (const [slot, val] of Object.entries(slots)) {
    const drop = $(`.drop[data-slot="${slot}"]`);
    drop.classList.toggle('filled', !!val);
    $(`[data-name="${slot}"]`).textContent = val ? val.name : '';
    $(`[data-name="${slot}"]`).title = val ? val.path : '';
  }
  $('#dropImg1').classList.toggle('disabled', !state.images[0]);
  $('#arrangementField').hidden = !(state.images[0] && state.images[1]);

  // Range outputs
  $$('output[data-for]').forEach((o) => {
    const input = document.getElementById(o.dataset.for);
    o.textContent = `${input.value}%`;
  });

  renderPreview();
  renderTimeline();
  renderOverlayPanel();

  // Guides
  const zone = SAFE_ZONES[state.platform];
  el.safe.classList.toggle('on', state.showSafe);
  $('.safe-top', el.safe).style.height = `${zone.top * 100}%`;
  $('.safe-bottom', el.safe).style.height = `${zone.bottom * 100}%`;
  for (const side of ['left', 'right']) {
    const s = $(`.safe-${side}`, el.safe);
    s.style.width = `${zone[side] * 100}%`;
    s.style.top = `${zone.top * 100}%`;
    s.style.bottom = `${zone.bottom * 100}%`;
  }
  $('#safeLabel').textContent = zone.label;
  $('#showSafe').checked = state.showSafe;
  $('#snap').checked = state.snap;
  $('#quality').value = state.quality;

  // Export button
  el.exportBtn.disabled = state.exporting || !!exportProblem();
  el.exportBtn.title = exportProblem() || '';
}

function renderPreview() {
  const { layout } = state;
  const isSplit = layout !== 'video';
  const ratio = state.splitRatio;

  // Region geometry
  if (isSplit) {
    const clipTop = state.swap ? 1 - ratio : 0;
    const otherTop = state.swap ? 0 : ratio;
    Object.assign(el.regionClip.style, { top: `${clipTop * 100}%`, height: `${ratio * 100}%` });
    Object.assign(el.regionOther.style, { top: `${otherTop * 100}%`, height: `${(1 - ratio) * 100}%`, display: '' });
  } else {
    Object.assign(el.regionClip.style, { top: '0', height: '100%' });
    el.regionOther.style.display = 'none';
  }

  // Clip region
  const fit = isSplit ? 'fill' : state.fit;
  el.regionClip.classList.toggle('fit-blur', fit === 'blur');
  el.regionClip.classList.toggle('fit-bars', fit === 'bars');
  el.regionClip.classList.toggle('has-media', !!state.clip);
  el.regionClip.classList.toggle('pannable', !!state.clip && fit === 'fill');
  if (state.clip) {
    el.vClip.style.objectPosition = fit === 'fill' ? `${state.clip.focusX * 100}% ${state.clip.focusY * 100}%` : '50% 50%';
    el.vClip.volume = clamp(state.clip.volume, 0, 1);
  }

  // Other region
  const showBg = layout === 'split-video';
  el.vBg.style.display = showBg ? '' : 'none';
  el.imgs.style.display = layout === 'split-image' ? '' : 'none';
  let otherHasMedia = false;
  if (showBg && state.background) {
    otherHasMedia = true;
    el.vBg.style.objectPosition = `${state.background.focusX * 100}% ${state.background.focusY * 100}%`;
    el.vBg.volume = clamp(state.bgVolume, 0, 1);
    el.vBg.muted = state.bgVolume === 0;
  }
  if (layout === 'split-image') {
    const imgs = state.images;
    otherHasMedia = !!imgs[0];
    el.imgs.classList.toggle('switch', state.imageArrangement === 'switch');
    [el.img0, el.img1].forEach((img, i) => {
      const data = imgs[i];
      if (data) {
        if (img.dataset.src !== data.url) {
          img.src = data.url;
          img.dataset.src = data.url;
        }
        img.style.display = '';
        img.style.objectPosition = `${data.focusX * 100}% ${data.focusY * 100}%`;
      } else {
        img.removeAttribute('src');
        delete img.dataset.src;
        img.style.display = 'none';
      }
    });
    updateImageSwitch();
  }
  el.regionOther.classList.toggle('has-media', otherHasMedia);
  $('#otherPlaceholder').textContent = layout === 'split-image' ? 'Image' : 'Background video';

  // Overlay
  const ov = state.overlay;
  el.overlay.classList.toggle('on', !!ov);
  if (ov) {
    Object.assign(el.overlay.style, {
      left: `${ov.cx * 100}%`,
      top: `${ov.cy * 100}%`,
      width: `${ov.scale * 100}%`,
      opacity: String(ov.opacity),
    });
  }
}

function renderOverlayPanel() {
  const ov = state.overlay;
  $('#overlayControls').classList.toggle('disabled', !ov);
  if (!ov) return;
  if (document.activeElement !== $('#ovX')) $('#ovX').value = (ov.cx * 100).toFixed(1);
  if (document.activeElement !== $('#ovY')) $('#ovY').value = (ov.cy * 100).toFixed(1);
  $('#ovScale').value = Math.round(ov.scale * 100);
  $('#ovOpacity').value = Math.round(ov.opacity * 100);
  $('output[data-for="ovScale"]').textContent = `${Math.round(ov.scale * 100)}%`;
  $('output[data-for="ovOpacity"]').textContent = `${Math.round(ov.opacity * 100)}%`;
}

function renderTimeline() {
  const dur = state.clip ? state.clip.duration : 0;
  const { start, end } = state.trim;
  const pct = (t) => (dur ? (t / dur) * 100 : 0);
  el.tlIn.style.left = `${pct(start)}%`;
  el.tlOut.style.left = `${dur ? pct(end) : 100}%`;
  el.tlRange.style.left = `${pct(start)}%`;
  el.tlRange.style.width = `${dur ? pct(end - start) : 0}%`;
  el.timeTotal.textContent = fmt(dur);
  el.trimInfo.textContent = `Start ${fmt(start)} · End ${fmt(end)} · Length ${fmt(end - start)}`;
  updatePlayhead();

  const max = MAX_SECONDS[state.platform];
  const len = end - start;
  if (state.clip && len > max) {
    el.durationWarning.hidden = false;
    el.durationWarning.textContent =
      `Heads up: ${PLATFORM_LABEL[state.platform]} allows up to ${fmt(max).replace(/\.0$/, '')} per clip, ` +
      `and this one is ${fmt(len)}. Trim it with the handles above.`;
  } else {
    el.durationWarning.hidden = true;
  }
}

function updatePlayhead() {
  const dur = state.clip ? state.clip.duration : 0;
  const t = el.vClip.currentTime || 0;
  el.tlHead.style.left = `${dur ? (t / dur) * 100 : 0}%`;
  el.tlHead.style.display = dur ? '' : 'none';
  el.timeNow.textContent = fmt(t);
}

function updateImageSwitch() {
  if (state.layout !== 'split-image') return;
  const both = state.images[0] && state.images[1];
  const isSwitch = both && state.imageArrangement === 'switch';
  const t = (el.vClip.currentTime || 0) - state.trim.start;
  const half = (state.trim.end - state.trim.start) / 2;
  const showSecond = isSwitch && t >= half;
  el.img0.classList.toggle('hidden-switch', showSecond);
  el.img1.classList.toggle('hidden-switch', isSwitch && !showSecond);
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

let rafId = null;

function isPlaying() {
  return !el.vClip.paused;
}

function syncSecondary(force = false) {
  const t = el.vClip.currentTime || 0;
  if (state.layout === 'video' && state.fit === 'blur' && state.clip) {
    if (force || Math.abs(el.vClipBg.currentTime - t) > 0.25) el.vClipBg.currentTime = t;
  }
  if (state.layout === 'split-video' && state.background && el.vBg.duration) {
    const expected = Math.max(0, t - state.trim.start) % el.vBg.duration;
    if (force || Math.abs(el.vBg.currentTime - expected) > 0.3) el.vBg.currentTime = expected;
  }
  updateImageSwitch();
}

function tick() {
  const t = el.vClip.currentTime;
  if (t >= state.trim.end - 0.03) {
    el.vClip.currentTime = state.trim.start; // loop inside the trim
    syncSecondary(true);
  } else {
    syncSecondary(false);
  }
  updatePlayhead();
  rafId = requestAnimationFrame(tick);
}

function play() {
  if (!state.clip || state.exporting) return;
  const t = el.vClip.currentTime;
  if (t < state.trim.start || t >= state.trim.end - 0.05) el.vClip.currentTime = state.trim.start;
  syncSecondary(true);
  el.vClip.play().catch(() => {});
  if (state.layout === 'video' && state.fit === 'blur') el.vClipBg.play().catch(() => {});
  if (state.layout === 'split-video' && state.background) el.vBg.play().catch(() => {});
  el.playBtn.classList.add('playing');
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}

function pause() {
  el.vClip.pause();
  el.vClipBg.pause();
  el.vBg.pause();
  el.playBtn.classList.remove('playing');
  cancelAnimationFrame(rafId);
}

function seek(t) {
  if (!state.clip) return;
  el.vClip.currentTime = clamp(t, 0, state.clip.duration);
  syncSecondary(true);
  updatePlayhead();
}

el.playBtn.addEventListener('click', () => (isPlaying() ? pause() : play()));

// ---------------------------------------------------------------------------
// Timeline: scrubbing + trim handles
// ---------------------------------------------------------------------------

function timeFromEvent(e) {
  const rect = el.timeline.getBoundingClientRect();
  const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  return x * (state.clip ? state.clip.duration : 0);
}

function setTrimStart(t) {
  state.trim.start = clamp(t, 0, state.trim.end - MIN_TRIM);
  renderTimeline();
  updateImageSwitch();
}
function setTrimEnd(t) {
  state.trim.end = clamp(t, state.trim.start + MIN_TRIM, state.clip.duration);
  renderTimeline();
  updateImageSwitch();
}

function dragOnTimeline(target, onMove) {
  return (e) => {
    if (!state.clip) return;
    e.preventDefault();
    e.stopPropagation();
    target.setPointerCapture(e.pointerId);
    const move = (ev) => onMove(timeFromEvent(ev));
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      render();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    onMove(timeFromEvent(e));
  };
}

el.tlIn.addEventListener('pointerdown', dragOnTimeline(el.tlIn, (t) => {
  setTrimStart(t);
  seek(state.trim.start);
}));
el.tlOut.addEventListener('pointerdown', dragOnTimeline(el.tlOut, (t) => {
  setTrimEnd(t);
  seek(state.trim.end);
}));
el.timeline.addEventListener('pointerdown', dragOnTimeline(el.timeline, (t) => seek(t)));

$('#setIn').addEventListener('click', () => state.clip && (setTrimStart(el.vClip.currentTime), render()));
$('#setOut').addEventListener('click', () => state.clip && (setTrimEnd(el.vClip.currentTime), render()));

// ---------------------------------------------------------------------------
// Panning media inside its region (changes the crop focus point)
// ---------------------------------------------------------------------------

function panTargetInfo(key) {
  switch (key) {
    case 'clip':
      if (!state.clip || (state.layout === 'video' && state.fit !== 'fill')) return null;
      return { data: state.clip, media: el.vClip, box: el.regionClip };
    case 'background':
      return state.background ? { data: state.background, media: el.vBg, box: el.vBg } : null;
    case 'image0':
      return state.images[0] ? { data: state.images[0], media: el.img0, box: el.img0 } : null;
    case 'image1':
      return state.images[1] ? { data: state.images[1], media: el.img1, box: el.img1 } : null;
    default:
      return null;
  }
}

function naturalSize(media) {
  if (media.tagName === 'VIDEO') return { w: media.videoWidth, h: media.videoHeight };
  return { w: media.naturalWidth, h: media.naturalHeight };
}

el.frame.addEventListener('pointerdown', (e) => {
  if (e.target === el.overlay) return;
  el.overlay.classList.remove('selected');
  const holder = e.target.closest('[data-pan]');
  if (!holder) return;
  const info = panTargetInfo(holder.dataset.pan);
  if (!info) return;
  const { w, h } = naturalSize(info.media);
  const rect = info.box.getBoundingClientRect();
  if (!w || !h || !rect.width) return;

  // Rendered size under object-fit: cover, and how much spills over each axis.
  const scale = Math.max(rect.width / w, rect.height / h);
  const overX = w * scale - rect.width;
  const overY = h * scale - rect.height;
  if (overX < 1 && overY < 1) return;

  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  const fx0 = info.data.focusX;
  const fy0 = info.data.focusY;
  document.body.classList.add('panning');
  el.frame.setPointerCapture(e.pointerId);

  const move = (ev) => {
    // Dragging right reveals more of the left side → focus moves left.
    if (overX >= 1) info.data.focusX = clamp(fx0 - (ev.clientX - startX) / overX, 0, 1);
    if (overY >= 1) info.data.focusY = clamp(fy0 - (ev.clientY - startY) / overY, 0, 1);
    renderPreview();
  };
  const up = () => {
    document.body.classList.remove('panning');
    el.frame.removeEventListener('pointermove', move);
    el.frame.removeEventListener('pointerup', up);
  };
  el.frame.addEventListener('pointermove', move);
  el.frame.addEventListener('pointerup', up);
});

// Double-click media to re-centre it.
el.frame.addEventListener('dblclick', (e) => {
  if (e.target === el.overlay) return;
  const holder = e.target.closest('[data-pan]');
  const info = holder && panTargetInfo(holder.dataset.pan);
  if (!info) return;
  info.data.focusX = 0.5;
  info.data.focusY = 0.5;
  renderPreview();
});

// ---------------------------------------------------------------------------
// Overlay: drag, presets, size, opacity, nudge
// ---------------------------------------------------------------------------

/** Overlay size as fractions of the frame. */
function overlayBox() {
  const ov = state.overlay;
  const w = ov.scale;
  const h = (ov.scale * ov.aspect * OUT_W) / OUT_H;
  return { w, h };
}

function placeOverlay(pos) {
  const ov = state.overlay;
  if (!ov) return;
  const { w, h } = overlayBox();
  const zone = state.showSafe ? SAFE_ZONES[state.platform] : { top: 0.03, bottom: 0.03, left: 0.03, right: 0.03 };
  const [v, hz] = pos.split('');
  const xs = { l: zone.left + w / 2, c: 0.5, r: 1 - zone.right - w / 2 };
  const ys = { t: zone.top + h / 2, m: 0.5, b: 1 - zone.bottom - h / 2 };
  ov.cx = xs[hz];
  ov.cy = ys[v];
  render();
}

el.overlay.addEventListener('pointerdown', (e) => {
  if (!state.overlay) return;
  e.preventDefault();
  e.stopPropagation();
  el.overlay.classList.add('selected');
  el.overlay.setPointerCapture(e.pointerId);
  const rect = el.frame.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  const cx0 = state.overlay.cx;
  const cy0 = state.overlay.cy;

  const move = (ev) => {
    let cx = cx0 + (ev.clientX - startX) / rect.width;
    let cy = cy0 + (ev.clientY - startY) / rect.height;
    let snapX = false;
    let snapY = false;
    if (state.snap && !ev.altKey) {
      if (Math.abs(cx - 0.5) < SNAP) (cx = 0.5), (snapX = true);
      if (Math.abs(cy - 0.5) < SNAP) (cy = 0.5), (snapY = true);
    }
    state.overlay.cx = clamp(cx, -0.5, 1.5);
    state.overlay.cy = clamp(cy, -0.5, 1.5);
    el.guideV.classList.toggle('on', snapX);
    el.guideH.classList.toggle('on', snapY);
    renderPreview();
    renderOverlayPanel();
  };
  const up = () => {
    el.guideV.classList.remove('on');
    el.guideH.classList.remove('on');
    el.overlay.removeEventListener('pointermove', move);
    el.overlay.removeEventListener('pointerup', up);
  };
  el.overlay.addEventListener('pointermove', move);
  el.overlay.addEventListener('pointerup', up);
});

// Scroll on the overlay to resize it.
el.overlay.addEventListener(
  'wheel',
  (e) => {
    if (!state.overlay) return;
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.02 : -0.02;
    state.overlay.scale = clamp(state.overlay.scale + step, 0.05, 1);
    renderPreview();
    renderOverlayPanel();
  },
  { passive: false }
);

$$('#posGrid button').forEach((b) => b.addEventListener('click', () => placeOverlay(b.dataset.pos)));

$('#ovScale').addEventListener('input', (e) => {
  if (state.overlay) state.overlay.scale = Number(e.target.value) / 100;
  render();
});
$('#ovOpacity').addEventListener('input', (e) => {
  if (state.overlay) state.overlay.opacity = Number(e.target.value) / 100;
  render();
});
$('#ovX').addEventListener('change', (e) => {
  if (state.overlay && e.target.value !== '') state.overlay.cx = clamp(Number(e.target.value) / 100, -0.5, 1.5);
  render();
});
$('#ovY').addEventListener('change', (e) => {
  if (state.overlay && e.target.value !== '') state.overlay.cy = clamp(Number(e.target.value) / 100, -0.5, 1.5);
  render();
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

$('#platforms').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-platform]');
  if (!b) return;
  state.platform = b.dataset.platform;
  savePrefs();
  render();
});

$('#layouts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-layout]');
  if (!b) return;
  const wasPlaying = isPlaying();
  pause();
  setLayout(b.dataset.layout);
  if (wasPlaying) play();
});

$('#fitMode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-fit]');
  if (!b) return;
  const wasPlaying = isPlaying();
  pause();
  state.fit = b.dataset.fit;
  savePrefs();
  render();
  if (wasPlaying) play();
});

$('#arrangement').addEventListener('click', (e) => {
  const b = e.target.closest('[data-arr]');
  if (!b) return;
  state.imageArrangement = b.dataset.arr;
  render();
});

$('#clipVolume').addEventListener('input', (e) => {
  if (state.clip) state.clip.volume = Number(e.target.value) / 100;
  render();
});
$('#bgVolume').addEventListener('input', (e) => {
  state.bgVolume = Number(e.target.value) / 100;
  render();
});
$('#splitRatio').addEventListener('input', (e) => {
  state.splitRatio = Number(e.target.value) / 100;
  render();
});
$('#swap').addEventListener('change', (e) => {
  state.swap = e.target.checked;
  render();
});
$('#showSafe').addEventListener('change', (e) => {
  state.showSafe = e.target.checked;
  savePrefs();
  render();
});
$('#snap').addEventListener('change', (e) => {
  state.snap = e.target.checked;
  savePrefs();
});
$('#quality').addEventListener('change', (e) => {
  state.quality = e.target.value;
  savePrefs();
});

// Browse / clear buttons
document.addEventListener('click', (e) => {
  const pickBtn = e.target.closest('[data-pick]');
  if (pickBtn) return void pick(pickBtn.dataset.pick);
  const clearBtn = e.target.closest('[data-clear]');
  if (clearBtn) return void clearSlot(clearBtn.dataset.clear);
});

// Drag & drop files onto drop zones
for (const drop of $$('.drop')) {
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    const describe = async (f) => clipper.describeFile(clipper.pathForFile(f));
    const slot = drop.dataset.slot;
    await loadSlot(slot, await describe(files[0]));
    if (slot === 'image0' && files[1]) await loadSlot('image1', await describe(files[1]));
  });
}
// Never let a stray drop navigate the window away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

  if (e.code === 'Space') {
    e.preventDefault();
    isPlaying() ? pause() : play();
  } else if (e.key === 'i' || e.key === 'I') {
    if (state.clip) setTrimStart(el.vClip.currentTime), render();
  } else if (e.key === 'o' || e.key === 'O') {
    if (state.clip) setTrimEnd(el.vClip.currentTime), render();
  } else if (e.key.startsWith('Arrow')) {
    const ovSelected = state.overlay && el.overlay.classList.contains('selected');
    if (ovSelected) {
      e.preventDefault();
      const step = e.shiftKey ? 0.02 : 0.002;
      if (e.key === 'ArrowLeft') state.overlay.cx -= step;
      if (e.key === 'ArrowRight') state.overlay.cx += step;
      if (e.key === 'ArrowUp') state.overlay.cy -= step;
      if (e.key === 'ArrowDown') state.overlay.cy += step;
      render();
    } else if (state.clip && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      seek(el.vClip.currentTime + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1));
    }
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && el.overlay.classList.contains('selected')) {
    clearSlot('overlay');
  }
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportProblem() {
  if (!state.clip) return 'Add a clip first.';
  if (state.trim.end - state.trim.start <= 0) return 'The trimmed clip is empty.';
  if (state.layout === 'split-video' && !state.background) return 'Add a background video.';
  if (state.layout === 'split-image' && !state.images[0]) return 'Add at least one image.';
  return null;
}

function buildProject(outputPath) {
  const q = QUALITY[state.quality] || QUALITY.standard;
  const pick = (o, keys) => (o ? Object.fromEntries(keys.map((k) => [k, o[k]])) : null);
  return {
    layout: state.layout,
    fit: state.fit,
    swap: state.swap,
    splitRatio: state.splitRatio,
    clip: pick(state.clip, ['path', 'hasAudio', 'focusX', 'focusY', 'volume']),
    trim: { start: state.trim.start, end: state.trim.end },
    background: state.background
      ? { ...pick(state.background, ['path', 'hasAudio', 'focusX', 'focusY']), volume: state.bgVolume }
      : null,
    images: state.images.filter(Boolean).map((i) => pick(i, ['path', 'focusX', 'focusY'])),
    imageArrangement: state.imageArrangement,
    overlay: pick(state.overlay, ['path', 'isGif', 'cx', 'cy', 'scale', 'opacity']),
    output: { path: outputPath, crf: q.crf, preset: q.preset },
  };
}

el.exportBtn.addEventListener('click', async () => {
  const problem = exportProblem();
  if (problem) return toast(problem);
  pause();

  const base = state.clip.name.replace(/\.[^.]+$/, '');
  const outputPath = await clipper.saveDialog(`${base}_${state.platform}.mp4`);
  if (!outputPath) return;

  state.exporting = true;
  el.result.hidden = true;
  el.progress.hidden = false;
  setProgress(0);
  render();

  const off = clipper.onProgress(setProgress);
  let res;
  try {
    res = await clipper.startExport(buildProject(outputPath));
  } catch (err) {
    res = { ok: false, error: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  }
  off();
  state.exporting = false;
  el.progress.hidden = true;
  showResult(res);
  render();
});

$('#cancelBtn').addEventListener('click', () => clipper.cancelExport());

function setProgress(p) {
  const pct = Math.round(p * 100);
  el.progressFill.style.width = `${pct}%`;
  el.progressText.textContent = `Rendering… ${pct}%`;
}

function showResult(res) {
  el.result.hidden = false;
  el.result.className = 'result';
  el.result.replaceChildren();
  if (res.ok) {
    el.result.classList.add('ok');
    const msg = document.createElement('div');
    msg.textContent = `Saved for ${PLATFORM_LABEL[state.platform]}.`;
    const btn = document.createElement('button');
    btn.className = 'ghost small';
    btn.textContent = 'Show in folder';
    btn.addEventListener('click', () => clipper.reveal(res.path));
    el.result.append(msg, btn);
    toast('Export finished.');
  } else if (res.cancelled) {
    el.result.textContent = 'Export cancelled.';
  } else {
    el.result.classList.add('error');
    el.result.textContent = res.error || 'Export failed.';
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

loadPrefs();
render();
