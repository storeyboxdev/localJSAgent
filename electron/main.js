import { app, BrowserWindow, ipcMain, shell, utilityProcess } from "electron";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, URL } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { autoUpdater } = require("electron-updater");

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── Logging ──────────────────────────────────────────────────────────────────

const LOG_PATH = join(app.getPath("userData"), "localai.log");

writeFileSync(LOG_PATH, `=== LocalAI ${app.getVersion()} — ${new Date().toISOString()} ===\n`);

function log(tag, ...args) {
  const ts = new Date().toISOString();
  const line = `${ts} [${tag}] ${args.join(" ")}\n`;
  process.stdout.write(line);
  appendFileSync(LOG_PATH, line);
}

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(app.getPath("userData"), "config.json");

const DEFAULT_CONFIG = {
  provider: "lmstudio-local",
  baseURL: "http://192.168.1.91:1234/v1",
  apiKey: "",
  model: "",
  port: 3001,
  updateServerURL: "http://192.168.1.91:3000/releases/",
  knowledgeBaseURL: "http://192.168.1.91:3000",
};

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    log("config", "created default config at:", CONFIG_PATH);
    return { ...DEFAULT_CONFIG };
  }
  try {
    const config = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };

    // Migrate stale config values from older installs
    let migrated = false;
    if (config.updateServerURL && config.updateServerURL.includes(":3001/")) {
      config.updateServerURL = config.updateServerURL.replace(":3001/", ":3000/");
      migrated = true;
    }
    if (config.baseURL === "http://localhost:1234/v1") {
      config.baseURL = DEFAULT_CONFIG.baseURL;
      migrated = true;
    }
    if (migrated) {
      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      log("config", "migrated stale config values");
    }

    log("config", "loaded from:", CONFIG_PATH);
    log("config", JSON.stringify(config));
    return config;
  } catch (err) {
    log("config", "parse error, using defaults:", err.message);
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
  if (config.knowledgeBaseURL) env.KNOWLEDGE_BASE_URL = config.knowledgeBaseURL;

  return env;
}

function startServer(config) {
  const env = buildEnv(config);
  const serverPath = join(ROOT, "server.js");

  log("electron", "starting server:", serverPath);
  log("electron", "env: PORT=" + env.PORT, "PROVIDER=" + env.PROVIDER_TYPE, "BASE_URL=" + (env.LMSTUDIO_BASE_URL || "n/a"));

  serverProcess = utilityProcess.fork(serverPath, [], {
    cwd: ROOT,
    env,
    stdio: "pipe",
  });

  serverProcess.stdout?.on("data", (d) => {
    process.stdout.write(d);
    appendFileSync(LOG_PATH, d.toString());
  });
  serverProcess.stderr?.on("data", (d) => {
    process.stderr.write(d);
    appendFileSync(LOG_PATH, d.toString());
  });

  serverProcess.on("message", (msg) => {
    log("ipc", "received:", JSON.stringify(msg));
    if (msg === "ready") log("ipc", "server signaled ready");
    if (msg === "restart-server") restartServer();
  });

  serverProcess.on("exit", (code) => {
    log("electron", "server exited with code", code);
    serverProcess = null;
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
  const port = config.port || 3000;
  const serverURL = `http://localhost:${port}`;

  // Show loading screen while new server boots
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`);
    startServerPolling(serverURL);
  }

  startServer(config);
}

// ── Auto-updater ──────────────────────────────────────────────────────────────

function setupUpdater(config) {
  if (!config.updateServerURL) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    log("updater", "update available:", info.version);
    clearTimeout(updaterTimeout);
    mainWindow?.webContents.send("update-status", { status: "available", version: info.version });
  });

  autoUpdater.on("update-not-available", () => {
    log("updater", "no update available");
    clearTimeout(updaterTimeout);
  });

  autoUpdater.on("update-downloaded", (info) => {
    log("updater", "downloaded:", info.version);
    mainWindow?.webContents.send("update-status", { status: "downloaded", version: info.version });
  });

  autoUpdater.on("error", (err) => {
    log("updater", "error:", err.message);
    clearTimeout(updaterTimeout);
  });

  let updaterTimeout;
  try {
    autoUpdater.setFeedURL({
      provider: "generic",
      url: config.updateServerURL,
      updaterCacheDirName: "localai-updater",
    });
    log("updater", "feed URL:", config.updateServerURL);

    autoUpdater.checkForUpdates().catch((err) => {
      log("updater", "check failed:", err.message);
    });

    updaterTimeout = setTimeout(() => {
      log("updater", "check timed out after 10s");
    }, 10000);
  } catch (err) {
    log("updater", "setup failed:", err.message);
  }
}

// ── Startup diagnostics ──────────────────────────────────────────────────────

async function runDiagnostics(config) {
  const port = config.port || 3000;
  const baseURL = config.baseURL || "http://localhost:1234/v1";
  const apiBase = baseURL.replace(/\/v1\/?$/, "");

  log("diag", "═══════════ STARTUP DIAGNOSTICS ═══════════");
  log("diag", `config.provider: ${config.provider}`);
  log("diag", `config.baseURL: ${config.baseURL}`);
  log("diag", `config.port: ${config.port}`);
  log("diag", `config.model: ${config.model || "(auto-detect)"}`);
  log("diag", `config.updateServerURL: ${config.updateServerURL}`);
  log("diag", `config.knowledgeBaseURL: ${config.knowledgeBaseURL}`);
  log("diag", `configPath: ${CONFIG_PATH}`);

  // 1. Local Express server
  log("diag", "── Local server (localhost:" + port + ") ──");
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: ctrl.signal });
    const health = await res.json();
    log("diag", `  ✓ REACHABLE — status: ${JSON.stringify(health)}`);
  } catch (e) {
    log("diag", `  ✗ UNREACHABLE — ${e.message}`);
    log("diag", `  ✗ Server process may have crashed. Check log above for errors.`);
  }

  // 2. LM Studio HTTP API (model listing)
  log("diag", "── LM Studio API (" + apiBase + ") ──");
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${apiBase}/v1/models`, { signal: ctrl.signal });
    const data = await res.json();
    const loaded = data.data || [];
    log("diag", `  ✓ REACHABLE — ${loaded.length} models: ${loaded.map(m => m.id).join(", ")}`);
  } catch (e) {
    log("diag", `  ✗ UNREACHABLE — ${e.message}`);
    log("diag", `  ✗ Is LM Studio running? Is the server started? Check baseURL in Settings.`);
  }

  // 3. LM Studio loaded models (v0 API for context length)
  log("diag", "── LM Studio v0 API (" + apiBase + "/api/v0/models) ──");
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${apiBase}/api/v0/models`, { signal: ctrl.signal });
    const data = await res.json();
    const loaded = (data.data || []).filter(m => m.state === "loaded");
    for (const m of loaded) {
      log("diag", `  ✓ ${m.id} — type:${m.type}, ctx:${m.loaded_context_length}, state:${m.state}`);
    }
    if (loaded.length === 0) log("diag", "  ⚠ No loaded models found — load a model in LM Studio");
  } catch (e) {
    log("diag", `  ✗ UNREACHABLE — ${e.message}`);
  }

  // 4. Knowledge base (if configured)
  if (config.knowledgeBaseURL) {
    log("diag", "── Knowledge Base (" + config.knowledgeBaseURL + ") ──");
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${config.knowledgeBaseURL}/api/health`, { signal: ctrl.signal });
      log("diag", `  ✓ REACHABLE — status: ${res.status}`);
    } catch (e) {
      log("diag", `  ✗ UNREACHABLE — ${e.message}`);
    }
  }

  log("diag", "═══════════ END DIAGNOSTICS ═══════════");
}

// ── Loading screen ───────────────────────────────────────────────────────────

const LOADING_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex; align-items: center; justify-content: center; height: 100vh;
    -webkit-app-region: drag;
  }
  .container { text-align: center; }
  h1 { font-size: 28px; font-weight: 600; margin-bottom: 24px; color: #fff; }
  .spinner {
    width: 40px; height: 40px; margin: 0 auto 20px;
    border: 3px solid #2a2a4a; border-top-color: #6c63ff; border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status { font-size: 14px; color: #888; }
</style></head><body>
<div class="container">
  <h1>LocalAI</h1>
  <div class="spinner"></div>
  <div class="status">Starting server\u2026</div>
</div>
</body></html>`;

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
      preload: join(__dirname, "preload.js"),
    },
  });

  const port = config.port || 3000;
  const serverURL = `http://localhost:${port}`;

  // Show loading page immediately — no white screen
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`);
  log("electron", "loading screen shown, polling for server at", serverURL);

  // Poll until server is ready, then navigate
  startServerPolling(serverURL);

  // Log renderer crashes and console errors
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    log("renderer", "CRASHED:", JSON.stringify(details));
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    log("renderer", `LOAD FAILED: ${code} ${desc} — ${url}`);
    // If the server URL failed to load, restart polling
    if (url.startsWith(serverURL)) {
      log("electron", "server URL failed to load, restarting health poll");
      mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`);
      startServerPolling(serverURL);
    }
  });
  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    const tag = ["verbose", "info", "warn", "error"][level] || "log";
    log(`renderer:${tag}`, `${message} (${sourceId}:${line})`);
  });

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    clearInterval(healthPollTimer);
  });
}

let healthPollTimer = null;

function startServerPolling(serverURL) {
  clearInterval(healthPollTimer);
  healthPollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${serverURL}/api/health`);
      if (res.ok) {
        clearInterval(healthPollTimer);
        healthPollTimer = null;
        log("electron", "server ready, navigating to", serverURL);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(serverURL);
        }
      }
    } catch { /* server not ready yet */ }
  }, 1000);
}

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle("restart-server", async () => {
  await restartServer();
});

ipcMain.handle("install-update", () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle("download-update", () => {
  log("updater", "user requested download");
  autoUpdater.downloadUpdate();
});

ipcMain.handle("get-log-path", () => LOG_PATH);

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  log("electron", "app ready, userData:", app.getPath("userData"));
  const config = loadConfig();

  startServer(config);            // fire and forget — window polls for readiness
  createWindow(config);           // shows loading screen immediately
  runDiagnostics(config);         // fire and forget — just logs
  setupUpdater(config);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(config);
  });
});

app.on("window-all-closed", async () => {
  await stopServer();
  app.quit();
});
