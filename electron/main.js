/**
 * Desktop shell for the Next.js app.
 *
 * The app is a normal Next.js server that reads and rewrites the user's local
 * Copilot configuration, so it needs a real Node runtime rather than a static
 * bundle. Electron supplies that runtime, starts the production server on
 * loopback, and renders it in a window.
 *
 * The splash and the app deliberately live in two separate windows. Reusing a
 * single window meant navigating from a draggable splash document to the app,
 * and on macOS the native draggable region survived that navigation: the whole
 * window kept consuming mouse input as window drags, so the app rendered but
 * nothing was clickable.
 */
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  nativeTheme,
  shell,
} = require("electron");
const path = require("node:path");

const { applyShellPath } = require("./shell-path");
const { startNextServer, stopNextServer } = require("./next-server");

/**
 * Where the shipped payload lives. `extraResources` in electron-builder puts
 * it beside the asar archive; a development run reads the same layout from
 * the staging directory that `npm run desktop:build` fills.
 */
const RESOURCES_DIR = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, "..", "build", "resources");
const MIN_SPLASH_DURATION_MS = 3000;
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 860;

let splashWindow = null;
let mainWindow = null;
let serverChild = null;
let serverUrl = null;

function recordServerLog(chunk) {
  process.stdout.write(chunk);
}

function isAlive(window) {
  return Boolean(window) && !window.isDestroyed();
}

function backgroundColor() {
  return nativeTheme.shouldUseDarkColors ? "#16181c" : "#ffffff";
}

/**
 * Resolves with the time the splash became visible, or `null` if it was closed
 * before that happened, which means the user quit during startup.
 */
function createSplashWindow() {
  const window = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    center: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: backgroundColor(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splashWindow = window;

  window.on("closed", () => {
    if (splashWindow === window) splashWindow = null;
  });

  const visible = new Promise((resolve) => {
    const onClosed = () => resolve(null);
    window.once("closed", onClosed);
    window.once("ready-to-show", () => {
      window.removeListener("closed", onClosed);
      window.show();
      resolve(Date.now());
    });
  });

  return window
    .loadFile(path.join(__dirname, "loading.html"))
    .then(() => visible);
}

function closeSplashWindow() {
  if (!isAlive(splashWindow)) return;
  splashWindow.destroy();
  splashWindow = null;
}

/**
 * Created only once the server is listening, so it loads the app directly and
 * never hosts any document other than the app itself.
 */
function createMainWindow(url) {
  const window = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: 920,
    minHeight: 600,
    show: false,
    // Without this the click that activates the window is swallowed instead of
    // being delivered to the page.
    acceptFirstMouse: true,
    backgroundColor: backgroundColor(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  // Anything that is not the local app opens in the user's real browser,
  // so the window can never become a general-purpose web view.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, target) => {
    if (serverUrl && target.startsWith(serverUrl)) return;
    event.preventDefault();
    shell.openExternal(target);
  });

  const visible = new Promise((resolve) => {
    const onClosed = () => resolve(null);
    window.once("closed", onClosed);
    window.once("ready-to-show", () => {
      window.removeListener("closed", onClosed);
      window.show();
      window.focus();
      closeSplashWindow();
      resolve(window);
    });
  });

  return window.loadURL(url).then(() => visible);
}

function waitForMinimumSplashDuration(splashStartedAt) {
  const remaining = Math.max(
    0,
    splashStartedAt + MIN_SPLASH_DURATION_MS - Date.now(),
  );

  if (remaining === 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, remaining));
}

function showStartupError(error) {
  console.error(error);
  closeSplashWindow();
  dialog.showErrorBox(
    "Plugin Manager could not start",
    "Close the app, then try again.",
  );
  app.quit();
}

function buildMenu() {
  const isMac = process.platform === "darwin";

  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open in Browser",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => {
            if (serverUrl) shell.openExternal(serverUrl);
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow?.webContents.reload(),
        },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function start() {
  buildMenu();
  const splashStartedAt = await createSplashWindow();
  if (!splashStartedAt) return;

  // Child processes inherit this, so it has to be widened before the server
  // starts rather than lazily on first use.
  await applyShellPath();

  try {
    let startupFailed = false;
    const started = await startNextServer({
      resourcesDir: RESOURCES_DIR,
      onLog: recordServerLog,
      onExit: (code, signal) => {
        serverChild = null;
        // A clean exit during shutdown is expected; a crash while a window is
        // still open is not, and would otherwise leave a dead window.
        if (app.isQuitting) return;
        if (!isAlive(splashWindow) && !isAlive(mainWindow)) return;
        startupFailed = true;
        showStartupError(
          new Error(
            `The local server stopped unexpectedly (code ${code ?? signal}).`,
          ),
        );
      },
    });

    serverChild = started.child;
    serverUrl = started.url;
    await waitForMinimumSplashDuration(splashStartedAt);
    if (startupFailed || !isAlive(splashWindow)) return;

    await createMainWindow(started.url);
  } catch (error) {
    showStartupError(error);
  }
}

// A second launch focuses the running window instead of starting a second
// server that would fight over the same config files.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = isAlive(mainWindow) ? mainWindow : splashWindow;
    if (!isAlive(window)) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(start);
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverUrl) {
    createMainWindow(serverUrl);
  }
});

// Closing the window quits on every platform, including macOS, so no orphaned
// server keeps running in the background.
app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => {
  app.isQuitting = true;
  stopNextServer(serverChild);
});
