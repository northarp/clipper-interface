# Clipper

Format clips into vertical **9:16 (1080×1920)** videos for **TikTok**, **Instagram Reels** and
**YouTube Shorts**, right in your browser. Videos are processed on your own device and never uploaded.

## Using the website

Open the site, then follow the four steps on the left:

1. **Format**: pick one of:
   - **Video**: just the clip. *Fill* crops it, *Blur* fits it over a blurred copy, *Bars* adds black bars.
   - **Clip + video**: your clip on one half, a background video (e.g. gameplay) on the other. The background loops if it's shorter, and you can mix in its sound.
   - **Clip + image**: your clip over one or **two images (max 2)**, shown *side by side* or *switching halfway*.
2. **Media**: add your files (drop them or click). Drag inside the preview to choose which part of each video or image stays in frame. Double-click to re-center.
3. **Overlay (optional)**: add a PNG, JPG, WebP or animated GIF. Drag it anywhere in the preview (it snaps to the center lines), use the quick-position grid, or change its size (slider or mouse wheel) and opacity. Arrow keys nudge it.
4. **Export**: pick a quality and click **Export video**. You get an MP4 (H.264 video and AAC audio, 30 fps).

Trim with the handles on the timeline, or press **I** and **O** to set the start and end at the playhead.
The **TikTok / Reels / Shorts** switch shows that app's safe zones (where its buttons cover your video)
and warns if the clip is too long for it. The **Purple / Green** button switches the colourway.

**Browser support:** exporting needs a browser with WebCodecs: a recent **Chrome or Edge** (recommended),
or Firefox 130+, on a computer. Other browsers can still preview.

## Publishing the site (GitHub Pages)

The site is static files in `web/`, so no server or build step is needed.

1. On GitHub, open **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Push any change to `web/` on the default branch, or run the **Deploy website** workflow from the **Actions** tab.

The site then appears at `https://<owner>.github.io/<repo>/`. GitHub Pages for a private repository needs a paid GitHub plan.
Any other static host (Netlify, Cloudflare Pages, Vercel…) works too: point it at the `web/` folder.

## Running it locally

The page uses JavaScript modules, so it has to be served over `http://`. Double-clicking `index.html` won't work.

```bash
npm run web
```

Then open http://localhost:8080. Any static file server pointed at `web/` works, for example
`python -m http.server 8080 --directory web`.

## How it works

- `web/js/compose.js`: draws one frame (layout, crop, blur, overlay). Both the live preview and the exporter use it, so the preview matches the export exactly.
- `web/js/export.js`: decodes the inputs and encodes the MP4 in the browser with [Mediabunny](https://mediabunny.dev) (WebCodecs). If the browser has no built-in AAC encoder, it loads Mediabunny's WebAssembly AAC encoder.
- `web/js/app.js`: the UI, playback, dragging, timeline and theme.
- `web/vendor/`: bundled copies of Mediabunny (MPL-2.0) and its AAC encoder (based on FFmpeg, LGPL-2.1). Licenses are in `web/vendor/licenses/`.

## Desktop app (optional)

The original Electron desktop app is still in `src/`. It uses a bundled ffmpeg and has the same features.

```bash
npm install
npm start
```

## Tests

```bash
npm test
```

This runs unit tests for the website's frame maths, plus the desktop app's ffmpeg tests (including real renders of every layout).
