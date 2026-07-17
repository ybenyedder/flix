// Flix desktop shell (Electron).
//
// The desktop app is a thin native window around the very same self-hosted Flix
// server that powers the web build. It spawns the Next.js standalone server
// (SQLite library, streaming, images, recommendations) on a private loopback
// port, waits for it to come up, then loads it in a normal window.
//
// Unlike Auralis, Flix has no "connect to a remote server" mode: it is strictly
// local-first, so the desktop shell always spawns its own server. The only
// first-run choice is which folder holds the video library.
//
// Model: /home/pc/Documents/auralis_enterprise_grade/desktop/main.js, with the
// remote-server flow and electron-updater removed entirely (zero network calls,
// zero auto-update — see SECURITY.md) and an ffmpeg/ffprobe presence check added
// (Flix cannot scan or play anything without them, and never downloads a binary
// on the user's behalf).

const { app, BrowserWindow, ipcMain, shell, Menu, dialog, session } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");
const { fork, spawn } = require("child_process");

const isDev = !app.isPackaged || process.env.FLIX_DESKTOP_DEV === "1";
const DEV_URL = process.env.FLIX_DEV_URL || "http://localhost:4247";

let serverProcess = null;
let mainWindow = null;
let resolvedPort = 0;
// The origin the main window is actually showing — used to re-create the
// window on macOS activate without falling back to the wrong URL.
let currentUrl = null;

// ---------------------------------------------------------------------------
// First-run library folder configuration.
//
// On the very first launch the user picks the folder that holds their movies
// and shows (or keeps the server's own default, ~/Videos). The choice is
// persisted in the per-user data dir so it is only asked once; it can be
// changed later from the "Fichier" menu, which relaunches into this same
// chooser.
// ---------------------------------------------------------------------------

function setupConfigPath() {
  return path.join(app.getPath("userData"), "desktop-setup.json");
}

function readSetup() {
  try {
    const cfg = JSON.parse(fs.readFileSync(setupConfigPath(), "utf8"));
    return normalizeSetup(cfg);
  } catch {
    return null;
  }
}

function writeSetup(cfg) {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(setupConfigPath(), JSON.stringify(cfg, null, 2));
    return true;
  } catch (error) {
    console.error("Failed to persist desktop setup:", error);
    return false;
  }
}

// Validate + normalise a raw setup choice into { mediaDir: string|null, serverUrl: string|null }.
function normalizeSetup(raw) {
  if (!raw || typeof raw !== "object") return null;
  const dir = typeof raw.mediaDir === "string" && raw.mediaDir.trim() ? path.resolve(raw.mediaDir.trim()) : null;
  const url = typeof raw.serverUrl === "string" && raw.serverUrl.trim() ? raw.serverUrl.trim() : null;
  return { mediaDir: dir, serverUrl: url };
}

let setupWindow = null;
let setupResolver = null;

function runSetup() {
  return new Promise((resolve) => {
    setupResolver = resolve;
    setupWindow = new BrowserWindow({
      width: 560,
      height: 460,
      resizable: false,
      backgroundColor: "#141414",
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    setupWindow.once("ready-to-show", () => setupWindow.show());
    setupWindow.loadFile(path.join(__dirname, "setup.html"));
    // Closing the window without choosing aborts the launch.
    setupWindow.on("closed", () => {
      setupWindow = null;
      if (setupResolver) { setupResolver = null; app.quit(); }
    });
  });
}

// Resolve the setup promise and tear down the chooser window.
function completeSetup(cfg) {
  const persisted = writeSetup(cfg);
  const resolve = setupResolver;
  setupResolver = null;
  if (setupWindow) {
    setupWindow.removeAllListeners("closed");
    setupWindow.close();
    setupWindow = null;
  }
  if (resolve) resolve(cfg);
  return persisted;
}

// Only the first-run chooser window (setup.html, loaded from a file:// URL) may
// drive these. Without this guard, content loaded in the MAIN window (the local
// server's own UI — trusted here, but this mirrors Auralis's defense in depth)
// could call submitSetup()/cancelSetup() to tamper with the desktop shell state.
function fromSetupWindow(event) {
  return setupWindow !== null && !setupWindow.isDestroyed() && event.sender === setupWindow.webContents;
}

// Renderer (setup.html) submits the chosen folder here.
ipcMain.handle("setup:submit", async (event, raw) => {
  if (!fromSetupWindow(event)) return { ok: false, error: "Not allowed." };
  const cfg = normalizeSetup(raw);
  if (!cfg) return { ok: false, error: "Configuration invalide." };
  const persisted = completeSetup(cfg);
  return { ok: true, persisted };
});
ipcMain.on("setup:cancel", (event) => { if (fromSetupWindow(event)) app.quit(); });

// Forget the saved folder choice and relaunch into the chooser (used by the
// preload bridge; kept for a future in-app "Settings" entry point).
ipcMain.handle("desktop:reconfigure", (event) => {
  // Same sender guard as setup:submit — only the trusted first-run chooser may
  // wipe the saved folder and relaunch. Without it a compromised/XSS'd MAIN
  // window (the local server UI, which shares this preload bridge) could spin
  // the app in an endless relaunch/re-setup loop.
  if (!fromSetupWindow(event)) return { ok: false, error: "Not allowed." };
  try { fs.unlinkSync(setupConfigPath()); } catch { /* already absent */ }
  app.relaunch();
  app.exit(0);
});

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe presence check.
//
// Flix cannot probe or play anything without both binaries (see
// src/server/library/ffprobe.ts, src/server/library/frameExtract.ts,
// src/server/playback/*). Rather than silently produce an empty, broken
// library, the shell checks for them at boot and — if missing — shows local,
// static installation instructions. It NEVER downloads a binary on the user's
// behalf: that would be an unaudited executable fetched and run with the
// user's privileges, exactly the kind of network dependency Flix forbids.
// ---------------------------------------------------------------------------

function checkBinary(bin, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    let proc;
    try {
      proc = spawn(bin, ["-version"], { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      resolve(false);
    }, timeoutMs);
    proc.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function checkFfmpeg() {
  const ffmpegPath = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
  const ffprobePath = process.env.FFPROBE_PATH?.trim() || "ffprobe";
  const [hasFfmpeg, hasFfprobe] = await Promise.all([checkBinary(ffmpegPath), checkBinary(ffprobePath)]);
  return hasFfmpeg && hasFfprobe;
}

// The ffmpeg-missing window is tracked separately (mirrors setupWindow) so the
// recheck handler can verify its sender: only that trusted window may re-run the
// presence check and relaunch. Otherwise a compromised/XSS'd MAIN window — which,
// once ffmpeg IS present, would see checkFfmpeg() succeed — could force an
// endless relaunch loop.
let ffmpegWindow = null;
function fromFfmpegWindow(event) {
  return ffmpegWindow !== null && !ffmpegWindow.isDestroyed() && event.sender === ffmpegWindow.webContents;
}

ipcMain.handle("ffmpeg:recheck", async (event) => {
  if (!fromFfmpegWindow(event)) return { ok: false };
  const ok = await checkFfmpeg();
  if (ok) {
    // Clean restart into the normal boot flow rather than trying to splice the
    // server startup into an already-open "missing" window.
    app.relaunch();
    app.exit(0);
  }
  return { ok };
});

function showFfmpegMissing() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 640,
      height: 620,
      backgroundColor: "#141414",
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    mainWindow = win;
    ffmpegWindow = win; // sender reference for the ffmpeg:recheck guard (see fromFfmpegWindow)
    win.once("ready-to-show", () => win.show());
    win.loadFile(path.join(__dirname, "ffmpeg-missing.html"));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.on("closed", () => {
      if (mainWindow === win) mainWindow = null;
      if (ffmpegWindow === win) ffmpegWindow = null;
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle.
// ---------------------------------------------------------------------------

function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function waitForServer(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      });
      req.on("error", retry);
      req.on("timeout", () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error("Flix server did not start in time"));
      else setTimeout(attempt, 300);
    };
    attempt();
  });
}

async function startServer(mediaDir) {
  resolvedPort = await pickPort();
  // The standalone server is shipped as an unpacked resource (see electron-builder.yml).
  const serverDir = path.join(process.resourcesPath, "app", "server");
  const serverEntry = path.join(serverDir, "server.js");

  const env = {
    ...process.env,
    // Run the bundled server with Electron's Node runtime (matches the rebuilt
    // native better-sqlite3 binding — see scripts/prepare-desktop.mjs).
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    PORT: String(resolvedPort),
    // Hard-pinned to loopback. The desktop shell's spawned server must never be
    // reachable from the LAN on the user's behalf — LAN exposure is only ever an
    // explicit choice an operator makes by running the standalone server
    // directly (`npm run serve` / a systemd unit) with its own HOSTNAME, never
    // something this shell opts into silently.
    HOSTNAME: "127.0.0.1",
    // Persist the library DB + image cache in the per-user app data directory.
    FLIX_DATA_DIR: path.join(app.getPath("userData"), "data"),
  };
  // The folder chosen at first run seeds the library root. A later in-app change
  // (admin "Repointer le dossier" via /api/library/source) is persisted to
  // host-settings.json and outranks this on every subsequent boot.
  if (mediaDir) env.FLIX_MEDIA_DIR = mediaDir;

  serverProcess = fork(serverEntry, [], {
    cwd: serverDir,
    env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  serverProcess.on("exit", (code) => {
    if (code && code !== 0 && !app.isQuitting) {
      // Surface a hard failure rather than a blank window.
      if (mainWindow) mainWindow.loadURL(`data:text/html,<body style="background:%23141414;color:%23fff;font-family:sans-serif;padding:2rem"><h2>Le serveur Flix s'est arrêté (code ${code})</h2></body>`);
    }
  });

  await waitForServer(resolvedPort);
  return `http://127.0.0.1:${resolvedPort}`;
}

async function boot(cfg) {
  if (cfg.serverUrl) return cfg.serverUrl;
  if (isDev) return DEV_URL;
  return startServer(cfg.mediaDir);
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#141414",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer only ever loads our own local server's UI; sandbox it.
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.loadURL(url);

  // The window must only ever show OUR server's origin. Any other navigation
  // (a poisoned link, a redirect) would otherwise run untrusted remote code in
  // the trusted app context next to the preload bridge.
  const expectedOrigin = (() => { try { return new URL(url).origin; } catch { return null; } })();
  mainWindow.webContents.on("will-navigate", async (event, target) => {
    let sameOrigin = false;
    try { sameOrigin = expectedOrigin !== null && new URL(target).origin === expectedOrigin; } catch { sameOrigin = false; }
    if (!sameOrigin) {
      event.preventDefault();
      if (/^https?:/.test(target)) shell.openExternal(target);
    }
  });

  // window.open()/target=_blank never creates a new Electron window; external
  // links open in the user's own browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

// Native folder picker. Only the first-run chooser (setup.html) drives this over
// IPC — the "Fichier" menu path opens the dialog directly (changeMediaDirFlow),
// not through here. Same sender guard as setup:submit so a compromised/XSS'd MAIN
// window can't pop a native folder dialog on the user.
ipcMain.handle("dialog:pickFolder", async (event) => {
  if (!fromSetupWindow(event)) return null;
  try {
    const parent = BrowserWindow.getFocusedWindow() ?? mainWindow ?? setupWindow ?? undefined;
    const res = await dialog.showOpenDialog(parent, {
      title: "Choisir le dossier vidéos",
      properties: ["openDirectory"],
    });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  } catch (error) {
    console.error("Folder picker failed:", error);
    return null;
  }
});

// "Fichier > Changer le dossier vidéos…" — Flix has no in-app titlebar/settings
// chrome (unlike Auralis), so this native menu item is the reachable path to
// repoint the library from the desktop shell without touching env vars.
async function changeMediaDirFlow() {
  const parent = mainWindow ?? undefined;
  const res = await dialog.showOpenDialog(parent, {
    title: "Choisir le dossier vidéos",
    properties: ["openDirectory"],
  });
  if (res.canceled || !res.filePaths.length) return;
  writeSetup({ mediaDir: res.filePaths[0] });
  app.relaunch();
  app.exit(0);
}

function buildMenu() {
  const template = [
    {
      label: "Fichier",
      submenu: [
        { label: "Changer le dossier vidéos…", click: () => { void changeMediaDirFlow(); } },
        { type: "separator" },
        { label: "Quitter", role: "quit" },
      ],
    },
    {
      label: "Affichage",
      submenu: [
        { role: "reload" },
        { role: "togglefullscreen" },
        ...(isDev ? [{ role: "toggleDevTools" }] : []),
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// Defense in depth: clamp EVERY web contents the app creates — deny popups
// (external links go to the system browser) and forbid <webview> embedding, so
// no path can spawn an untrusted frame inside the trusted app.
app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(buildMenu());

    // Flix needs no device permissions (it only plays video it serves itself
    // over local HTTP). Deny every permission request/check so nothing loaded
    // in the window can prompt for or silently obtain camera, microphone,
    // geolocation, notifications, etc. The server's own Permissions-Policy
    // header covers the same ground for the web build.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    try {
      const ffmpegOk = await checkFfmpeg();
      if (!ffmpegOk) {
        await showFfmpegMissing();
        app.quit();
        return;
      }

      // First launch (or after "Changer le dossier vidéos…") asks for the
      // library folder; the saved choice is reused silently on every later
      // launch. Dev always runs against the local dev server (already started
      // separately via `npm run dev`).
      let cfg = isDev ? { mediaDir: null } : readSetup();
      if (!cfg) cfg = await runSetup();
      currentUrl = await boot(cfg);
      createWindow(currentUrl);
    } catch (error) {
      console.error("Failed to start Flix:", error);
      app.quit();
      return;
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && currentUrl) {
        createWindow(currentUrl);
      }
    });
  });
}

app.on("before-quit", () => { app.isQuitting = true; });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
