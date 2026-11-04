# Clipper

A Windows desktop app for formatting clips into vertical **9:16 (1080×1920)** videos for
**TikTok**, **Instagram Reels** and **YouTube Shorts**.

## Features

- **Three formats**
  - **Video only**: the clip fills the frame. Choose *Fill* (crop), *Blur fit* (the whole clip over a blurred copy of itself) or *Bars* (black bars).
  - **Clip + Video (half/half)**: your clip on one half, a background video (e.g. gameplay) on the other. The background loops if it's shorter than the clip, and its audio can be mixed in.
  - **Clip + Image (half/half)**: your clip over one or **two images (max 2)**. Two images can sit *side by side* or *switch halfway* through the clip.
- **Overlay**: attach a PNG, JPG, WebP or animated GIF, then:
  - drag it anywhere in the preview (it snaps to the center lines; hold Alt to skip snapping)
  - use the 3×3 position grid (top, center, bottom, corners…). Positions respect the platform's safe zones when they're shown.
  - set its size (slider or mouse wheel), opacity, or exact X/Y position
  - nudge it with the arrow keys (Shift = bigger steps), or press Delete to remove it
- **Crop / reframe**: drag any clip, video or image in the preview to choose which part stays in frame. Double-click to re-center.
- **Trim**: drag the handles on the timeline, or press **I** / **O** to set the start and end at the playhead.
- **Platform presets**: show each platform's approximate UI safe zones and warn when a clip is longer than the platform allows (TikTok 10 min, Reels 3 min, Shorts 3 min).
- **Split controls**: change the clip's share of the height (20–80%) or move the clip to the bottom.
- **Export**: H.264/AAC MP4 at 30 fps, with a progress bar and cancel button. ffmpeg is bundled, so there's nothing else to install.

What you see in the preview is what gets exported: the preview and the ffmpeg filter graph use the same crop and position maths.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play / pause |
| I / O | Set trim start / end at playhead |
| ← / → | Seek 1 s (Shift: 5 s), or nudge the selected overlay |
| ↑ / ↓ | Nudge the selected overlay |
| Delete | Remove the selected overlay |

## Development

Requires Node.js 18+.

```bash
npm install
npm start      # run the app
npm test       # unit tests + end-to-end renders of every layout with real ffmpeg
```

## Building the Windows installer

Run these **on Windows**. `ffmpeg-static` downloads the ffmpeg binary for the OS you install on,
so building on Linux or macOS would bundle the wrong ffmpeg.

```bash
npm install
npm run dist
```

This writes an NSIS installer and a portable `.exe` to `dist/`.

To use a different ffmpeg build, set `CLIPPER_FFMPEG` to the path of an `ffmpeg.exe`.

## Project layout

```
src/main/main.js        Electron main process: windows, dialogs, IPC
src/main/preload.js     Safe bridge exposed to the UI as window.clipper
src/main/build-args.js  Turns a project into ffmpeg arguments (pure and unit tested)
src/main/ffmpeg.js      Finds ffmpeg, probes media, renders with progress and cancel
src/renderer/           The UI (plain HTML/CSS/JS, no build step)
test/                   node:test suites
```
