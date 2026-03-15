import { app, BrowserWindow, ipcMain, shell, utilityProcess } from "electron";
import { autoUpdater } from "electron-updater";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(app.getPath("userData"), "config.json");

const DEFAULT_CONFIG = {
  provider: "lmstudio-local",
  baseURL: "http://localhost:1234/v1",
  apiKey: "",
  model: "",
  port: 3000,
  updateServerURL: "http://192.168.1.91:3000/releases/",
};

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ── Server child process ──────────────────────────────────────────────────────

let serverProcess = null;
let mainWindow = null;

function buildEnv(config) {
  const env = {
    ...process.env,
    PORT: String(config.port || 3000),
    PROVIDER_TYPE: config.provider,
    SERVE_STATIC: "1",
    CONFIG_PATH,
    NODE_ENV: process.env.NODE_ENV || "production",
  };

  // Set LMSTUDIO_BASE_URL for lmstudio providers
  if (config.provider.startsWith("lmstudio") || config.provider === "openai-compatible" || config.provider === "openai") {
    env.LMSTUDIO_BASE_URL = config.baseURL || DEFAULT_CONFIG.baseURL;
  }

  if (config.apiKey) env.API_KEY = config.apiKey;
  if (config.model) env.MAIN_LLM = config.model;

  return env;
}

function startServer(config) {
  return new Promise((resolve) => {
    const env = buildEnv(config);
    const serverPath = join(ROOT, "server.js");

    // utilityProcess is Electron's built-in API for Node.js background processes.
    // It works correctly with ESM modules and in packaged apps (no separate node needed).
    serverProcess = utilityProcess.fork(serverPath, [], {
      cwd: ROOT,
      env,
      stdio: "pipe",
    });

    serverProcess.stdout?.on("data", (d) => process.stdout.write(d));
    serverProcess.stderr?.on("data", (d) => process.stderr.write(d));

    serverProcess.on("message", (msg) => {
      if (msg === "ready") resolve();
      if (msg === "restart-server") restartServer();
    });

    serverProcess.on("exit", (code) => {
      console.log(`[electron] Server exited with code ${code}`);
      serverProcess = null;
    });

    // Fallback: open window after 6 s if server never sends 'ready'
    setTimeout(resolve, 6000);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess) return resolve();
    serverProcess.once("exit", resolve);
    serverProcess.kill();
    setTimeout(resolve, 3000);
  });
}

async function restartServer() {
  await stopServer();
  const config = loadConfig();
  await startServer(config);
  if (mainWindow) mainWindow.reload();
}

// ── Auto-updater ──────────────────────────────────────────────────────────────

function setupUpdater(config) {
  if (!config.updateServerURL) return;

  // Silent update: download in background, install when app restarts.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    console.log(`[updater] Update available: ${info.version}`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[updater] Update downloaded: ${info.version} — will install on quit`);
  });

  autoUpdater.on("error", (err) => {
    console.warn("[updater] error:", err.message);
  });

  try {
    autoUpdater.setFeedURL({
      provider: "generic",
      url: config.updateServerURL,
      updaterCacheDirName: "localai-updater",
    });

    autoUpdater.checkForUpdates().catch((err) => {
      console.warn("[updater] check failed:", err.message);
    });
  } catch (err) {
    console.warn("[updater] setup failed:", err.message);
  }
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow(config) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "LocalAI",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // No preload needed — app talks to Express via HTTP, same as browser
    },
  });

  const port = config.port || 3000;
  mainWindow.loadURL(`http://localhost:${port}`);

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle("restart-server", async () => {
  await restartServer();
});

ipcMain.handle("install-update", () => {
  autoUpdater.quitAndInstall();
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const config = loadConfig();

  try {
    await startServer(config);
  } catch (err) {
    console.error("[electron] Failed to start server:", err);
  }

  createWindow(config);
  setupUpdater(config);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(config);
  });
});

app.on("window-all-closed", async () => {
  await stopServer();
  app.quit();
});
