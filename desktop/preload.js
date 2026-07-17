// Preload bridge: exposes a minimal, safe desktop API to the renderer. No Node
// APIs are leaked to the page — only these explicit, narrow methods, each
// backed by a validated main-process handler (see desktop/main.js).

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flixDesktop", {
  platform: process.platform,
  // Native folder picker (returns the chosen absolute path, or null if cancelled).
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  // First-run library folder chooser (setup.html): submit { mediaDir } or abort.
  submitSetup: (cfg) => ipcRenderer.invoke("setup:submit", cfg),
  cancelSetup: () => ipcRenderer.send("setup:cancel"),
  // Forget the saved folder choice and relaunch into the chooser.
  reconfigure: () => ipcRenderer.invoke("desktop:reconfigure"),
  // ffmpeg-missing.html: re-run the ffmpeg/ffprobe presence check after the
  // user has (supposedly) installed them.
  recheckFfmpeg: () => ipcRenderer.invoke("ffmpeg:recheck"),
});
