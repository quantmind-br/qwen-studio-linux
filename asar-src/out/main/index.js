"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const electron = require("electron");
const path = require("path");
const utils = require("@electron-toolkit/utils");
const fs = require("fs/promises");
const AESPluginEvent = require("@ali/aes-tracker-plugin-event/index-node");
const AES = require("@ali/aes-tracker/index-node");
const electronUpdater = require("electron-updater");
const log = require("electron-log");
const i18next = require("i18next");
const Backend = require("i18next-fs-backend");
const os = require("os");
const settings = require("electron-settings");
const windowStateKeeper = require("electron-window-state");
const sparkMcp = require("@ali/spark-mcp");
const icon = path.join(__dirname, "../../resources/assets/icon.png");
const aes = new AES({
  pid: "RfGbWG"
});
const _sendLog = aes.use(AESPluginEvent);
const sendLog = (type, payload) => {
  const time = Date();
  const timeStamp = Date.now();
  _sendLog(type, {
    ...payload,
    c6: {
      time,
      timeStamp
    }
  });
};
function getPlatformDir(platform = os.platform(), arch = os.arch()) {
  if (platform === "darwin") {
    return arch === "arm64" ? "mac-arm64" : "mac-x64";
  }
  if (platform === "win32") {
    return "win-x64";
  }
  throw new Error(`Unsupported platform: ${platform}, arch: ${arch}`);
}
const resourcesPath = () => utils.is.dev ? `${electron.app.getAppPath()}/resources` : process.resourcesPath;
function getResourcePath(type, binName) {
  const dir = getPlatformDir();
  const base = utils.is.dev ? `${electron.app.getAppPath()}/resources/${type}/${dir}` : path.join(process.resourcesPath, type);
  return path.join(base, binName);
}
function getBunPath() {
  const binName = os.platform() === "win32" ? "bun.exe" : "bun";
  return getResourcePath("bun", binName);
}
function getUvxPath() {
  const binName = os.platform() === "win32" ? "uvx.exe" : "uvx";
  return getResourcePath("python", binName);
}
function adaptConfig(configs) {
  for (const key in configs) {
    const config = configs[key];
    let cmd = config.command;
    if (cmd === "npx" || cmd === "bun") {
      cmd = getBunPath();
      if (config.command === "npx") {
        config.args ||= [];
        if (!config.args.includes("-y")) config.args.unshift("-y");
        if (!config.args.includes("x")) config.args.unshift("x");
      }
    }
    if (cmd === "uvx") {
      cmd = getUvxPath();
    }
    config.command = cmd;
    if (!Object.keys(config.env || {}).length) {
      delete config["env"];
    }
    const pathToMyBin = path.join(electron.app.getAppPath(), "resources", "bin");
    const PATH = [
      pathToMyBin,
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin"
    ].join(":");
    config.env = {
      PATH,
      ...process.env,
      ...config.env
    };
  }
  return configs;
}
const autoUpdateConfig = {
  notAvailableTip: false
};
const autoUpdate = () => {
  electronUpdater.autoUpdater.autoDownload = false;
  electronUpdater.autoUpdater.autoInstallOnAppQuit = true;
  electronUpdater.autoUpdater.updateConfigPath = null;
  const BASE_URL = "https://download.qwen.ai/";
  let platformSpecificPath = "";
  if (process.platform === "darwin") {
    platformSpecificPath = `macos/${process.arch}/`;
  } else if (process.platform === "win32") {
    platformSpecificPath = `windows/${process.arch}/`;
  }
  console.log("autoUpdate url", BASE_URL + platformSpecificPath);
  electronUpdater.autoUpdater.setFeedURL({
    provider: "generic",
    url: BASE_URL + platformSpecificPath
  });
  electronUpdater.autoUpdater.logger = {
    info: () => {
    },
    warn: () => {
    },
    error: () => {
    }
  };
  electronUpdater.autoUpdater.checkForUpdates();
  electronUpdater.autoUpdater.on("checking-for-update", () => {
    sendLog("update-status", "checking");
  });
  electronUpdater.autoUpdater.on("update-available", (info) => {
    sendLog("autoUpdater", { c1: "available", c2: info });
    electron.dialog.showMessageBox({
      type: "info",
      icon,
      title: i18next.t("update.new_version_found"),
      message: i18next.t("update.new_version_message", { version: info.version }),
      buttons: [i18next.t("update.download_now"), i18next.t("update.later")]
    }).then(({ response }) => {
      if (response === 0) {
        electronUpdater.autoUpdater.downloadUpdate();
      }
    });
  });
  electronUpdater.autoUpdater.on("update-not-available", (info) => {
    if (autoUpdateConfig.notAvailableTip) {
      console.log("update-not-available version", info.version);
      electron.dialog.showMessageBox({
        type: "info",
        icon,
        message: i18next.t("update.latest_version", { version: info.version })
      });
    }
  });
  electronUpdater.autoUpdater.on("download-progress", (progress) => {
    const progressInfo = {
      percent: Math.floor(progress.percent),
      speed: (progress.bytesPerSecond / 1024 / 1024).toFixed(1) + "MB/s",
      transferred: (progress.transferred / 1024 / 1024).toFixed(1) + "MB",
      total: (progress.total / 1024 / 1024).toFixed(1) + "MB",
      status: "download-progress"
    };
    log.info(`%cGreen [download-progress]`, JSON.stringify(progressInfo));
    if (!exports.mainWindow?.isDestroyed()) {
      exports.mainWindow?.setProgressBar(progressInfo.percent);
      electron.app.dock?.setBadge(progressInfo.speed);
    }
  });
  electronUpdater.autoUpdater.on("update-downloaded", () => {
    sendLog("autoUpdater", { c1: "downloaded" });
    sendEvent("appUpdate-status", { status: "update-downloaded" });
    electron.app.dock?.setBadge("");
    exports.mainWindow?.setProgressBar(-1);
    electron.dialog.showMessageBox({
      type: "question",
      title: i18next.t("update.install_update"),
      icon,
      message: i18next.t("update.download_complete"),
      detail: i18next.t("update.install_detail"),
      buttons: [i18next.t("update.install_now"), i18next.t("update.install_later")]
    }).then(({ response }) => {
      if (response === 0) {
        electronUpdater.autoUpdater.quitAndInstall();
      }
    });
  });
  electronUpdater.autoUpdater.on("error", (err) => {
    sendLog("autoUpdater", { c1: "error", c2: err });
    sendEvent("appUpdate-status", { status: "error", msg: err.message });
  });
};
const buildAppMenu = () => {
  const appName = electron.app.getName();
  const checkUpdateItem = {
    label: i18next.t("menu.check_update"),
    click() {
      autoUpdateConfig.notAvailableTip = true;
      electronUpdater.autoUpdater.checkForUpdates();
    }
  };
  const topMenuTemplate = [
    {
      label: appName,
      submenu: [
        { role: "about", label: i18next.t("menu.about") },
        { type: "separator" },
        checkUpdateItem,
        { type: "separator" },
        { role: "quit", label: i18next.t("menu.quit") }
      ]
    },
    {
      label: i18next.t("menu.edit"),
      submenu: [
        { role: "undo", label: i18next.t("menu.undo") },
        { role: "redo", label: i18next.t("menu.redo") },
        { type: "separator" },
        { role: "cut", label: i18next.t("menu.cut") },
        { role: "copy", label: i18next.t("menu.copy") },
        { role: "paste", label: i18next.t("menu.paste") },
        { role: "selectAll", label: i18next.t("menu.select_all") }
      ]
    }
  ];
  const appMenu = electron.Menu.buildFromTemplate(topMenuTemplate);
  electron.Menu.setApplicationMenu(appMenu);
};
const basePath = path.join(resourcesPath(), "i18n");
log.info("i18n_config_path", basePath);
const SUPPORTED_LANGUAGES = [
  "zh-CN",
  "en-US",
  "zh-TW",
  "ja-JP",
  "ko-KR",
  "ru-RU",
  "de-DE",
  "fr-FR",
  "es-ES",
  "it-IT",
  "pt-PT",
  "ar-BH"
];
const SYSTEM_LANGUAGE_MAP = {
  "zh": "zh-CN",
  "zh-CN": "zh-CN",
  "zh-TW": "zh-TW",
  "zh-HK": "zh-TW",
  "en": "en-US",
  "en-US": "en-US",
  "en-GB": "en-US",
  "ja": "ja-JP",
  "ja-JP": "ja-JP",
  "ko": "ko-KR",
  "ko-KR": "ko-KR",
  "ru": "ru-RU",
  "ru-RU": "ru-RU",
  "de": "de-DE",
  "de-DE": "de-DE",
  "fr": "fr-FR",
  "fr-FR": "fr-FR",
  "es": "es-ES",
  "es-ES": "es-ES",
  "it": "it-IT",
  "it-IT": "it-IT",
  "pt": "pt-PT",
  "pt-PT": "pt-PT",
  "ar": "ar-BH",
  "ar-BH": "ar-BH"
};
function getSystemLanguage() {
  const systemLocale = electron.app.getLocale();
  log.info("System locale:", systemLocale);
  if (SYSTEM_LANGUAGE_MAP[systemLocale]) {
    return SYSTEM_LANGUAGE_MAP[systemLocale];
  }
  const languageCode = systemLocale.split("-")[0];
  if (SYSTEM_LANGUAGE_MAP[languageCode]) {
    return SYSTEM_LANGUAGE_MAP[languageCode];
  }
  return "en-US";
}
async function initI18n() {
  let initialLanguage = "en-US";
  try {
    const savedLanguage = await settings.get("app_language");
    if (savedLanguage && typeof savedLanguage === "string" && SUPPORTED_LANGUAGES.includes(savedLanguage)) {
      log.info("Using saved language:", savedLanguage);
      initialLanguage = savedLanguage;
    } else {
      const systemLanguage = getSystemLanguage();
      log.info("Using system language:", systemLanguage);
      initialLanguage = systemLanguage;
    }
  } catch (error) {
    log.warn("Failed to get saved language:", error);
    initialLanguage = getSystemLanguage();
  }
  log.info("Initial language:", initialLanguage);
  await i18next.use(Backend).init({
    backend: {
      loadPath: path.join(basePath, "{{lng}}.json")
    },
    lng: initialLanguage,
    fallbackLng: "en-US",
    interpolation: {
      escapeValue: false
    }
  });
  log.info("i18next initialized with language:", i18next.language);
  buildAppMenu();
}
i18next.on("languageChanged", async (lng) => {
  if (i18next.isInitialized) {
    log.info("Language changed to:", lng);
    try {
      await settings.set("app_language", lng);
      log.info("Language setting saved:", lng);
    } catch (error) {
      log.error("Failed to save language setting:", error);
    }
    buildAppMenu();
  }
});
const mcpServer = new sparkMcp.Proxy();
const getAppVersion = () => {
  sendLog("getAppVersion", { c1: electron.app.getVersion() });
  return Promise.resolve(electron.app.getVersion());
};
const getPlatformInfo = () => Promise.resolve({ os: process.platform });
const openExternalLink = async (_, url) => {
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  await electron.shell.openExternal(url);
  return true;
};
const showNativeDialog = async (_, { title, message }) => {
  const result = await electron.dialog.showMessageBox({
    type: "question",
    buttons: ["确认", "取消"],
    title,
    message
  });
  return result.response === 0 ? "ok" : "cancel";
};
const requestFileAccess = async (_, purpose, returnFile) => {
  const { filePaths } = await electron.dialog.showOpenDialog({
    properties: ["openFile"],
    title: purpose
  });
  if (!returnFile) return { filePath: filePaths[0] };
  const file = await fs.readFile(filePaths[0], "utf-8");
  return { filePath: filePaths[0], file };
};
const sendEvent = (type, payload) => {
  const wbs = electron.webContents.getAllWebContents();
  if (wbs.length) {
    for (let web of wbs) {
      web.send("event_from_main", { type, payload });
    }
  }
};
const onEvent = (callback) => {
  electron.ipcMain.on("event_to_main", (_, data) => callback(data));
};
const mcpClientToolList = async (_, serverName) => {
  try {
    const list = await mcpServer.listTools({ serverName });
    return list;
  } catch (e) {
    console.log("mcpClientToolList err", e);
    throw e;
  }
};
const mcpClientGetConfig = async () => mcpServer.getMCPServers();
const mcpClientToolCall = async (_, params) => mcpServer.callTool(params);
const mcpClientUpdateConfig = async (_, config) => {
  try {
    console.log("config", config);
    mcpServer.setMCPServers(adaptConfig(config));
    settings.set("mcp_config", config);
    return mcpClientGetConfig();
  } catch (err) {
    console.log("err", err);
    throw err;
  }
};
const OpenDevTool = () => {
  exports.mainWindow?.webContents.openDevTools();
};
const toggleHiddenDevTools = () => {
  if (!exports.mainWindow || exports.mainWindow.isDestroyed()) return false;
  if (exports.mainWindow.webContents.isDevToolsOpened()) {
    exports.mainWindow.webContents.closeDevTools();
    console.log("🎉 隐藏开发者工具已关闭");
    return false;
  } else {
    exports.mainWindow.webContents.openDevTools();
    console.log("🎉 隐藏开发者工具已打开");
    return true;
  }
};
const webviewLoaded = (_, id) => {
  sendLog("webviewLoaded", { id });
  console.log("webviewLoaded", id);
  electron.webContents.fromId(id);
};
const switchTheme = (_, theme) => {
  sendLog("switchTheme", { theme });
  console.log("switchTheme", theme);
  exports.mainWindow?.webContents.send("switch_theme", theme);
  if (process.platform === "darwin") {
    const iconPath = path.join(
      resourcesPath(),
      "assets",
      theme === "dark" ? "icon_dark.png" : "icon"
    );
    const icon2 = electron.nativeImage.createFromPath(iconPath);
    electron.app.dock?.setIcon(icon2);
  }
};
const switchLn = (_, ln) => {
  sendLog("switchLn", { ln });
  console.log("switchLn", ln);
  i18next.changeLanguage(ln);
};
const registerIPC = () => {
  electron.ipcMain.handle("get_app_version", getAppVersion);
  electron.ipcMain.handle("get_platform_info", getPlatformInfo);
  electron.ipcMain.handle("open_devtool", OpenDevTool);
  electron.ipcMain.handle("toggle_hidden_devtools", toggleHiddenDevTools);
  electron.ipcMain.handle("open_external_link", openExternalLink);
  electron.ipcMain.handle("show_native_dialog", showNativeDialog);
  electron.ipcMain.handle("request_file_access", requestFileAccess);
  electron.ipcMain.handle("mcp_client_tool_list", mcpClientToolList);
  electron.ipcMain.handle("mcp_client_tool_call", mcpClientToolCall);
  electron.ipcMain.handle("mcp_client_update_config", mcpClientUpdateConfig);
  electron.ipcMain.handle("mcp_client_get_config", mcpClientGetConfig);
  electron.ipcMain.handle("webview-loaded", webviewLoaded);
  electron.ipcMain.handle("switch_theme", switchTheme);
  electron.ipcMain.handle("switch_ln", switchLn);
  electron.ipcMain.handle("get_language", () => i18next.language);
  onEvent(({ type, payload }) => {
    console.log("Received event from renderer:", type, payload);
    if (type === "TEST_EVENT") {
      sendEvent("TEST_EVENT", "this msg comes from main process");
    }
  });
};
const SCHEME = "qwen";
function handleProtocolUrl(url) {
  if (!validateProtocol(url)) return;
  const parsed = new URL(url);
  const action = parsed.hostname;
  const params = Object.fromEntries(parsed.searchParams.entries());
  console.log("handleProtocolUrl", action, params);
  if (action === "open") {
    exports.mainWindow?.show();
    sendEvent("set_cookie", params.token);
  }
}
function validateProtocol(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "qwen:" && ["open"].includes(parsed.hostname) && // 允许的操作列表
    (parsed.hostname !== "open" || !!parsed.searchParams.get("token"));
  } catch {
    return false;
  }
}
const callClient = () => {
  if (!electron.app.isDefaultProtocolClient(SCHEME)) {
    electron.app.setAsDefaultProtocolClient(SCHEME);
  }
  electron.app.on("open-url", (event, url) => {
    sendLog("openUrl", { url });
    event.preventDefault();
    console.log("open-url", url);
    handleProtocolUrl(url);
  });
  electron.app.on("second-instance", (event, argv) => {
    console.log("second-instance", event);
    if (process.platform !== "darwin") {
      const url = argv.find((arg) => arg.startsWith("qwen://"));
      if (url) handleProtocolUrl(url);
    }
  });
};
const version = "1.0.2";
process.on("uncaughtException", (error) => {
  sendLog("nodeUncaughtException", { c1: error.message });
});
exports.mainWindow = null;
if (!electron.app.isPackaged && process.env.NODE_ENV === "development") {
  Object.defineProperty(electron.app, "isPackaged", {
    get: () => true
  });
}
function createWindow() {
  sendLog("initProcess", { c1: process.pid, c2: "createWindow" });
  if (exports.mainWindow && !exports.mainWindow.isDestroyed()) {
    exports.mainWindow.show();
    return exports.mainWindow;
  }
  const primaryDisplay = electron.screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  const mainWindowState = windowStateKeeper({
    defaultWidth: Math.min(1280, width * 0.85),
    defaultHeight: Math.min(840, height * 0.85),
    fullScreen: false
  });
  exports.mainWindow = new electron.BrowserWindow({
    width: mainWindowState.width,
    height: mainWindowState.height,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    center: true,
    minWidth: 400,
    titleBarStyle: process.platform === "darwin" ? "hidden" : void 0,
    minHeight: 600,
    ...process.platform === "linux" ? { icon } : {},
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      webviewTag: true,
      nodeIntegration: true,
      contextIsolation: false,
      nodeIntegrationInSubFrames: true,
      // TODO:调试用 发布前去除
      webSecurity: false,
      // 禁用同源策略和XSS保护等
      allowRunningInsecureContent: true
      // 允许运行非安全上下文中的内容
    }
  });
  mainWindowState.manage(exports.mainWindow);
  electron.ipcMain.on("minimize-window", () => {
    if (exports.mainWindow) exports.mainWindow.minimize();
  });
  electron.ipcMain.on("maximize-window", () => {
    if (exports.mainWindow) {
      if (exports.mainWindow.isMaximized()) {
        exports.mainWindow.unmaximize();
      } else {
        exports.mainWindow.maximize();
      }
    }
  });
  electron.ipcMain.on("close-window", () => {
    if (exports.mainWindow) {
      if (process.platform === "darwin") {
        exports.mainWindow.hide();
      } else {
        exports.mainWindow.close();
      }
    }
  });
  exports.mainWindow.on("ready-to-show", () => {
    sendLog("initProcess", { c1: process.pid, c2: "windowReadyToShow" });
    exports.mainWindow?.show();
  });
  exports.mainWindow.webContents.setWindowOpenHandler((details) => {
    electron.shell.openExternal(details.url);
    return { action: "deny" };
  });
  exports.mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "crashed") {
      console.log("Renderer process crashed:", details);
      sendLog("renderCrush", { c1: details.reason });
    }
  });
  exports.mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        `Failed to load URL: ${validatedURL} with error: ${errorDescription} (${errorCode})`
      );
      sendLog("renderCrush", { c1: errorCode, c2: errorDescription, c3: validatedURL });
    }
  );
  exports.mainWindow.webContents.on("dom-ready", () => {
    sendLog("initProcess", { c1: process.pid, c2: "webContentsDomReady" });
  });
  exports.mainWindow.webContents.on("did-finish-load", () => {
    sendLog("initProcess", { c1: process.pid, c2: "webContentsDidFinishLoad" });
  });
  const defaultUA = exports.mainWindow.webContents.getUserAgent();
  const customUA = `${defaultUA} AliDesktop(QWENCHAT/${version})`;
  if (utils.is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    exports.mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"], { userAgent: customUA });
  } else {
    exports.mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  return exports.mainWindow;
}
electron.app.whenReady().then(async () => {
  sendLog("initProcess", { c1: process.pid, c2: "appReady" });
  utils.electronApp.setAppUserModelId("com.qwen.chat");
  electron.app.on("browser-window-created", (_, window) => {
    utils.optimizer.watchWindowShortcuts(window);
  });
  await initI18n();
  createWindow();
  callClient();
  registerIPC();
  autoUpdate();
  buildAppMenu();
  electron.app.on("activate", function() {
    sendLog("initProcess", { c1: process.pid, c2: "appActivate" });
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      exports.mainWindow?.show();
    }
  });
});
electron.app.on("browser-window-created", (_, window) => {
  utils.optimizer.watchWindowShortcuts(window);
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
