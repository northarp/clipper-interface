'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { buildArgs, PLATFORMS, OUTPUT } = require('./build-args');
const ffmpeg = require('./ffmpeg');

const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp'];
const OVERLAY_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

let win = null;
let currentJob = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0f1115',
    title: 'Clipper',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Open external links in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function describeFile(filePath) {
  return { path: filePath, url: pathToFileURL(filePath).href, name: path.basename(filePath) };
}

const FILTERS = {
  video: [{ name: 'Videos', extensions: VIDEO_EXT }],
  image: [{ name: 'Images', extensions: IMAGE_EXT }],
  overlay: [{ name: 'Overlay images', extensions: OVERLAY_EXT }],
};

ipcMain.handle('app:info', () => ({
  platforms: PLATFORMS,
  output: OUTPUT,
  ffmpeg: ffmpeg.FFMPEG,
  extensions: { video: VIDEO_EXT, image: IMAGE_EXT, overlay: OVERLAY_EXT },
}));

ipcMain.handle('file:open', async (_e, kind, multi) => {
  const res = await dialog.showOpenDialog(win, {
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: FILTERS[kind] || [],
  });
  if (res.canceled) return [];
  return res.filePaths.map(describeFile);
});

ipcMain.handle('file:describe', (_e, filePath) => describeFile(filePath));

ipcMain.handle('file:probe', (_e, filePath) => ffmpeg.probe(filePath));

ipcMain.handle('file:save', async (_e, suggestedName) => {
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('videos'), suggestedName || 'clip.mp4'),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('file:reveal', (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
});

ipcMain.handle('export:start', async (event, project) => {
  if (currentJob) throw new Error('An export is already running.');
  const { args, duration } = buildArgs(project);
  const job = ffmpeg.render(args, duration, (p) => {
    if (!event.sender.isDestroyed()) event.sender.send('export:progress', p);
  });
  currentJob = job;
  try {
    await job.promise;
    return { ok: true, path: project.output.path };
  } catch (err) {
    if (err.cancelled) {
      fs.rm(project.output.path, { force: true }, () => {});
      return { ok: false, cancelled: true };
    }
    return { ok: false, error: err.message };
  } finally {
    currentJob = null;
  }
});

ipcMain.handle('export:cancel', () => {
  if (currentJob) currentJob.cancel();
});

app.whenReady().then(() => {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (currentJob) currentJob.cancel();
  if (process.platform !== 'darwin') app.quit();
});
