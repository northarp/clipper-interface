'use strict';

const { spawn } = require('child_process');
const fs = require('fs');

/**
 * Resolve the ffmpeg binary.
 * Order: CLIPPER_FFMPEG env var → bundled ffmpeg-static → "ffmpeg" on PATH.
 * When packaged, ffmpeg-static lives in app.asar.unpacked (see package.json asarUnpack).
 */
function resolveFfmpeg() {
  if (process.env.CLIPPER_FFMPEG && fs.existsSync(process.env.CLIPPER_FFMPEG)) {
    return process.env.CLIPPER_FFMPEG;
  }
  try {
    let p = require('ffmpeg-static');
    if (p) {
      p = p.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {
    /* not installed */
  }
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

const FFMPEG = resolveFfmpeg();

/** Parse "HH:MM:SS.xx" into seconds. */
function parseTimestamp(ts) {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(ts || '');
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Probe a media file using `ffmpeg -i` (avoids shipping ffprobe too).
 * Resolves { duration, hasAudio, hasVideo, width, height }.
 */
function probe(filePath) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-i', filePath], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', () => resolve({ duration: null, hasAudio: false, hasVideo: false }));
    proc.on('close', () => {
      const dur = /Duration:\s*([\d:.]+)/.exec(err);
      const video = /Stream #[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})/.exec(err);
      resolve({
        duration: dur ? parseTimestamp(dur[1]) : null,
        hasAudio: /Stream #[^\n]*Audio:/.test(err),
        hasVideo: !!video,
        width: video ? Number(video[1]) : null,
        height: video ? Number(video[2]) : null,
      });
    });
  });
}

/**
 * Run ffmpeg with `-progress pipe:1` and report progress (0..1).
 * Returns { promise, cancel }.
 */
function render(args, duration, onProgress) {
  const proc = spawn(FFMPEG, args, { windowsHide: true });
  let cancelled = false;
  let stderrTail = '';

  const promise = new Promise((resolve, reject) => {
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const [key, value] = line.split('=');
        if (key === 'out_time_us' || key === 'out_time_ms') {
          // Both are reported in microseconds by ffmpeg.
          const secs = Number(value) / 1e6;
          if (Number.isFinite(secs) && duration > 0) {
            onProgress(Math.min(1, Math.max(0, secs / duration)));
          }
        } else if (key === 'progress' && value === 'end') {
          onProgress(1);
        }
      }
    });
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    proc.on('error', (e) => {
      reject(
        new Error(
          e.code === 'ENOENT'
            ? 'ffmpeg was not found. Reinstall the app or set CLIPPER_FFMPEG to an ffmpeg executable.'
            : e.message
        )
      );
    });
    proc.on('close', (code) => {
      if (cancelled) return reject(Object.assign(new Error('Export cancelled.'), { cancelled: true }));
      if (code === 0) return resolve();
      const lastLines = stderrTail.trim().split(/\r?\n/).slice(-6).join('\n');
      reject(new Error(`ffmpeg exited with code ${code}.\n${lastLines}`));
    });
  });

  const cancel = () => {
    if (proc.exitCode !== null) return;
    cancelled = true;
    try {
      proc.stdin.write('q');
    } catch (_) {
      /* ignore */
    }
    setTimeout(() => proc.exitCode === null && proc.kill(), 1500);
  };

  return { promise, cancel };
}

module.exports = { FFMPEG, probe, render, parseTimestamp };
