"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const electron = require("electron");
const path = require("path");
const fs = require("fs/promises");
const AESPluginEvent = require("@ali/aes-tracker-plugin-event/index-node");
const AES = require("@ali/aes-tracker/index-node");
const electronUpdater = require("electron-updater");
const i18next = require("i18next");
const Backend = require("i18next-fs-backend");
const os = require("os");
const settings = require("electron-settings");
const windowStateKeeper = require("electron-window-state");
const fs$1 = require("fs");
const index_js = require("@modelcontextprotocol/sdk/client/index.js");
const stdio_js = require("@modelcontextprotocol/sdk/client/stdio.js");
const sse_js = require("@modelcontextprotocol/sdk/client/sse.js");
const streamableHttp_js = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const zod = require("zod");
const events = require("events");
function getPlatformDir(platform = os.platform(), arch = os.arch()) {
  if (platform === "darwin") {
    return arch === "arm64" ? "mac-arm64" : "mac-x64";
  }
  if (platform === "win32") {
    return "win-x64";
  }
  throw new Error(`Unsupported platform: ${platform}, arch: ${arch}`);
}
function resourcesPath() {
  return !electron.app.isPackaged ? `${electron.app.getAppPath()}/resources` : process.resourcesPath;
}
function getResourcePath(type, binName) {
  const dir = getPlatformDir();
  const base = !electron.app.isPackaged ? `${electron.app.getAppPath()}/resources/${type}/${dir}` : path.join(process.resourcesPath, type);
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
function isHttpConfig(config) {
  return !!config.url;
}
function buildEnhancedPath() {
  const pathToMyBin = path.join(electron.app.getAppPath(), "resources", "bin");
  const originalPath = process.env.PATH || "";
  const extraPaths = process.platform === "win32" ? [] : ["/usr/local/bin", "/opt/homebrew/bin"];
  return [pathToMyBin, ...extraPaths, originalPath].filter(Boolean).join(path.delimiter);
}
function ensureArgs(config, args) {
  config.args ||= [];
  for (const arg of args.reverse()) {
    if (!config.args.includes(arg)) {
      config.args.unshift(arg);
    }
  }
}
function resolveCommand(config) {
  const cmd = config.command;
  switch (cmd) {
    case "bun":
      return getBunPath();
    case "npx":
      ensureArgs(config, ["x", "-y"]);
      return getBunPath();
    case "system-npx":
      ensureArgs(config, ["-y"]);
      return "npx";
    case "uvx":
      return getUvxPath();
    default:
      return cmd;
  }
}
function normalizeServerType(type) {
  if (!type) return void 0;
  const normalized = type.toLowerCase().replace(/[_-]/g, "");
  switch (normalized) {
    case "streamablehttp":
    case "httpstream":
      return "streamableHttp";
    case "sse":
      return "sse";
    case "stdio":
      return "stdio";
    default:
      return type;
  }
}
function adaptConfig(configs) {
  for (const serverName in configs) {
    const config = configs[serverName];
    if (config.type) {
      config.type = normalizeServerType(config.type);
    }
    if ("transportType" in config) {
      delete config.transportType;
    }
    if (isHttpConfig(config)) {
      continue;
    }
    config.command = resolveCommand(config);
    config.env = {
      ...process.env,
      ...config.env,
      PATH: buildEnhancedPath()
    };
  }
  return configs;
}
const TRUSTED_WEB_ORIGINS = /* @__PURE__ */ new Set(["https://chat.qwen.ai", "https://pre-chat.qwen.ai"]);
const TRUSTED_LOCAL_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1"]);
const ALLOWED_MCP_COMMANDS = /* @__PURE__ */ new Set(["bun", "npx", "uvx", "system-npx"]);
const BLOCKED_MCP_COMMANDS = /* @__PURE__ */ new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "cscript",
  "cscript.exe",
  "osascript",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "wscript",
  "wscript.exe",
  "zsh"
]);
function isTopFrame(event) {
  const frame = event.senderFrame;
  return !!frame && !frame.detached && frame.parent === null;
}
function isTrustedFrameUrl(frameUrl, frameOrigin) {
  if (TRUSTED_WEB_ORIGINS.has(frameOrigin)) return true;
  if (frameUrl.startsWith("file://")) return true;
  try {
    const url = new URL(frameUrl);
    return (url.protocol === "http:" || url.protocol === "https:") && TRUSTED_LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
function isTrustedIpcSender(event) {
  const frame = event.senderFrame;
  if (!frame) return false;
  return isTopFrame(event) && isTrustedFrameUrl(frame.url, frame.origin);
}
function assertTrustedIpcSender(event) {
  if (!isTrustedIpcSender(event)) {
    const frame = event.senderFrame;
    throw new Error(
      `IPC sender is not trusted: url=${frame?.url || "unknown"}, origin=${frame?.origin || "unknown"}`
    );
  }
}
function commandName(command) {
  if (typeof command !== "string") return "";
  return path.basename(command).toLowerCase();
}
function isAllowedMcpCommand(command) {
  if (typeof command !== "string" || !command.trim()) return false;
  if (command === getBunPath() || command === getUvxPath()) return true;
  const name = commandName(command);
  if (BLOCKED_MCP_COMMANDS.has(name)) return false;
  return ALLOWED_MCP_COMMANDS.has(command) || ALLOWED_MCP_COMMANDS.has(name);
}
function assertSafeMcpServerConfig(serverName, serverConfig) {
  if ("url" in serverConfig || "baseUrl" in serverConfig) {
    return;
  }
  if (!isAllowedMcpCommand(serverConfig.command)) {
    throw new Error(`MCP command is not allowed for server "${serverName}": ${serverConfig.command}`);
  }
}
function assertSafeMcpConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Invalid MCP config");
  }
  for (const [serverName, serverConfig] of Object.entries(config)) {
    if (!serverConfig || typeof serverConfig !== "object" || Array.isArray(serverConfig)) {
      throw new Error(`Invalid MCP server config: ${serverName}`);
    }
    assertSafeMcpServerConfig(serverName, serverConfig);
  }
}
class Proxy {
  options;
  mcpServers;
  clients;
  constructor() {
    this.options = {};
    this.mcpServers = {};
    this.clients = {};
  }
  setMCPServers = (mcpServers) => {
    this.mcpServers = {
      ...mcpServers
    };
  };
  getMCPServers = () => {
    return this.mcpServers;
  };
  listTools = async ({ serverName }) => {
    try {
      const client = await this.getClient(serverName);
      const result = await client.listTools();
      return result;
    } catch (e) {
      console.error(`[MCP List Tools] 获取工具列表失败: ${serverName}`, {
        error: e?.message || String(e),
        code: e?.code,
        stack: e?.stack
      });
      throw e;
    }
  };
  callTool = async ({
    serverName,
    toolName,
    toolArguments
  }) => {
    try {
      const client = await this.getClient(serverName);
      const result = await client.callTool({
        name: toolName,
        arguments: toolArguments
      });
      return result;
    } catch (e) {
      console.error(`[MCP Tool Error] ${serverName}.${toolName}`, {
        error: e?.message || String(e),
        code: e?.code,
        stack: e?.stack
      });
      throw e;
    }
  };
  getClient = async (serverName) => {
    const mcp_config = this.mcpServers[serverName];
    if (!mcp_config) {
      const error2 = `未找到服务器配置: ${serverName}`;
      console.error(`[MCP Client Error] ${error2}`);
      throw new Error(error2);
    }
    if (this.clients[serverName]) {
      return this.clients[serverName];
    }
    const client = new index_js.Client(
      {
        name: serverName,
        version: "1.0.0"
      }
    );
    const httpConfig = mcp_config;
    const isHttpTransport = "url" in mcp_config;
    let transportType = "Stdio";
    let transport;
    try {
      if (isHttpTransport) {
        const url = new URL(httpConfig.url);
        const rawType = httpConfig.type || httpConfig.transportType || "sse";
        const normalizedType = rawType.toLowerCase().replace(/[_-]/g, "");
        transportType = rawType.toUpperCase();
        const requestInit = {};
        if (httpConfig.headers) {
          requestInit.headers = httpConfig.headers;
        }
        const isStreamableHttp = normalizedType === "streamablehttp" || normalizedType === "httpstream";
        if (isStreamableHttp) {
          transport = new streamableHttp_js.StreamableHTTPClientTransport(url, { requestInit });
        } else {
          transport = new sse_js.SSEClientTransport(url, { requestInit });
        }
      } else {
        assertSafeMcpServerConfig(serverName, mcp_config);
        transport = new stdio_js.StdioClientTransport(
          this.mcpServers[serverName]
        );
      }
      await client.connect(transport);
      if (!isHttpTransport) {
        this.clients[serverName] = client;
      }
      return client;
    } catch (e) {
      console.error(`[MCP Client] 连接失败: ${serverName}`, {
        transport: transportType,
        error: e?.message || String(e),
        code: e?.code,
        stack: e?.stack,
        config: isHttpTransport ? {
          originalType: httpConfig.type,
          url: httpConfig.url,
          headers: httpConfig.headers
        } : {
          command: mcp_config.command,
          args: mcp_config.args
        },
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
      throw e;
    }
  };
}
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
const icon = path.join(__dirname, "../../resources/assets/icon.png");
const autoUpdateConfig = {
  notAvailableTip: false
};
let isInitialized = false;
const initializeAutoUpdater = () => {
  if (isInitialized) return;
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
      total: (progress.total / 1024 / 1024).toFixed(1) + "MB"
    };
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
    console.error("AutoUpdater error:", err);
    sendEvent("appUpdate-status", { status: "error", msg: err.message });
    if (autoUpdateConfig.notAvailableTip) {
      electron.dialog.showMessageBox({
        type: "info",
        icon,
        message: i18next.t("update.latest_version", { version: electron.app.getVersion() })
      });
    }
  });
  isInitialized = true;
};
const checkForUpdates = () => {
  try {
    initializeAutoUpdater();
    autoUpdateConfig.notAvailableTip = true;
    electronUpdater.autoUpdater.checkForUpdates();
  } catch (error2) {
    console.error("Failed to check for updates:", error2);
    electron.dialog.showMessageBox({
      type: "info",
      icon,
      message: i18next.t("update.latest_version", { version: "当前版本" })
    });
  }
};
const autoUpdate = () => {
  initializeAutoUpdater();
  electronUpdater.autoUpdater.checkForUpdates();
};
const buildAppMenu = () => {
  const appName = electron.app.getName();
  const checkUpdateItem = {
    label: i18next.t("menu.check_update"),
    click() {
      checkForUpdates();
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
  const basePath = path.join(resourcesPath(), "i18n");
  let initialLanguage = "en-US";
  try {
    const savedLanguage = await settings.get("app_language");
    if (savedLanguage && typeof savedLanguage === "string" && SUPPORTED_LANGUAGES.includes(savedLanguage)) {
      initialLanguage = savedLanguage;
    } else {
      const systemLanguage = getSystemLanguage();
      initialLanguage = systemLanguage;
    }
  } catch (error2) {
    initialLanguage = getSystemLanguage();
  }
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
}
i18next.on("languageChanged", async (lng) => {
  if (i18next.isInitialized) {
    try {
      await settings.set("app_language", lng);
    } catch (error2) {
      console.error("Failed to save language setting:", error2);
    }
    buildAppMenu();
  }
});
const mcpServer = new Proxy();
const updateMacDockIcon = () => {
  if (process.platform !== "darwin" || !electron.app.isReady()) return;
  const iconName = electron.nativeTheme.shouldUseDarkColors ? "icon_dark.png" : "icon.png";
  const iconPath = path.join(resourcesPath(), "assets", iconName);
  const icon2 = electron.nativeImage.createFromPath(iconPath);
  if (!icon2.isEmpty()) {
    electron.app.dock?.setIcon(icon2);
  } else {
    sendLog("updateMacDockIcon: invalid icon", { iconPath });
  }
};
if (process.platform === "darwin") {
  electron.nativeTheme.on("updated", updateMacDockIcon);
}
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
let pendingEvents = [];
const sendEvent = (type, payload) => {
  const wbs = electron.webContents.getAllWebContents();
  let sent = false;
  if (wbs.length) {
    for (let web of wbs) {
      if (!web.isDestroyed()) {
        web.send("event_from_main", { type, payload });
        sent = true;
      }
    }
  }
  if (!sent) {
    pendingEvents.push({ type, payload });
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
    console.error(`[IPC] mcpClientToolList 失败: ${serverName}`, {
      error: e?.message || String(e),
      code: e?.code,
      stack: e?.stack
    });
    throw e;
  }
};
const mcpClientGetConfig = async () => mcpServer.getMCPServers();
const mcpClientToolCall = async (_, params) => {
  try {
    const result = await mcpServer.callTool(params);
    return result;
  } catch (e) {
    console.error(`[IPC] mcpClientToolCall 失败: ${params.serverName}.${params.toolName}`, {
      error: e?.message || String(e),
      code: e?.code,
      stack: e?.stack
    });
    throw e;
  }
};
const mcpClientUpdateConfig = async (_, config) => {
  try {
    console.log("[MCP] 更新配置，服务器数量:", Object.keys(config).length);
    assertSafeMcpConfig(config);
    const adaptedConfig = adaptConfig(config);
    console.log("[MCP] 配置适配完成");
    mcpServer.setMCPServers(adaptedConfig);
    settings.set("mcp_config", config);
    const result = mcpClientGetConfig();
    return result;
  } catch (err) {
    console.error(`[IPC] mcpClientUpdateConfig 失败`, {
      error: err?.message || String(err),
      code: err?.code,
      stack: err?.stack
    });
    throw err;
  }
};
const OpenDevTool = () => {
  exports.mainWindow?.webContents.openDevTools();
};
const exportLogFile = async () => {
  const logPath2 = path.join(electron.app.getPath("userData"), "qwen-electron-debug.log");
  try {
    await electron.shell.showItemInFolder(logPath2);
    return { success: true, path: logPath2 };
  } catch (e) {
    console.error("[Export Log] 打开日志目录失败", {
      error: e?.message,
      logPath: logPath2
    });
    throw e;
  }
};
const getLogFilePath = () => {
  const logPath2 = path.join(electron.app.getPath("userData"), "qwen-electron-debug.log");
  return { path: logPath2 };
};
const toggleHiddenDevTools = () => {
  if (!exports.mainWindow || exports.mainWindow.isDestroyed()) return false;
  if (exports.mainWindow.webContents.isDevToolsOpened()) {
    exports.mainWindow.webContents.closeDevTools();
    return false;
  } else {
    exports.mainWindow.webContents.openDevTools();
    return true;
  }
};
let webViewContents = void 0;
const webviewLoaded = (_, id) => {
  sendLog("webviewLoaded", { id });
  webViewContents = electron.webContents.fromId(id);
  if (webViewContents && !webViewContents.isDestroyed()) {
    const isTrustedChatOrigin = (origin) => origin === "https://chat.qwen.ai" || origin === "https://pre-chat.qwen.ai";
    const originFromUrl = (url) => {
      try {
        return new URL(url).origin;
      } catch {
        return "";
      }
    };
    const allowedPermissions = /* @__PURE__ */ new Set(["media", "clipboard-sanitized-write", "notifications"]);
    webViewContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
      const origin = details.requestingUrl ? originFromUrl(details.requestingUrl) : originFromUrl(contents.getURL());
      callback(isTrustedChatOrigin(origin) && allowedPermissions.has(permission));
    });
    webViewContents.session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
      return isTrustedChatOrigin(requestingOrigin) && allowedPermissions.has(permission);
    });
    webViewContents.session.setDevicePermissionHandler((details) => {
      return isTrustedChatOrigin(details.origin);
    });
    for (const evt of pendingEvents) {
      webViewContents.send("event_from_main", evt);
    }
    pendingEvents = [];
  }
};
const switchTheme = (_, theme) => {
  sendLog("switchTheme", { theme });
  exports.mainWindow?.webContents.send("switch_theme", theme);
  const themeSource = ["light", "dark", "system"].includes(theme) ? theme : "system";
  electron.nativeTheme.themeSource = themeSource;
  if (process.platform === "darwin") {
    updateMacDockIcon();
  }
};
const switchLn = (_, ln) => {
  sendLog("switchLn", { ln });
  i18next.changeLanguage(ln);
};
const updateTitleBarForSystemTheme = (_, isDark) => {
};
class McpCache {
  cache = /* @__PURE__ */ new Map();
  maxSize = 500;
  /**
   * 设置缓存
   */
  set(key, value, ttl) {
    const expireAt = Date.now() + ttl;
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { value, expireAt });
  }
  /**
   * 获取缓存
   */
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      return void 0;
    }
    if (Date.now() > entry.expireAt) {
      this.cache.delete(key);
      return void 0;
    }
    return entry.value;
  }
  /**
   * 检查缓存是否存在
   */
  has(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }
    if (Date.now() > entry.expireAt) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }
  /**
   * 删除缓存
   */
  remove(key) {
    this.cache.delete(key);
  }
  /**
   * 清除指定前缀的缓存
   */
  clearByPrefix(prefix) {
    const keysToDelete = [];
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
  }
  /**
   * 清除所有缓存
   */
  clear() {
    this.cache.clear();
  }
  /**
   * 获取缓存统计信息
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize
    };
  }
  /**
   * 清理过期缓存
   */
  cleanup() {
    const now = Date.now();
    const keysToDelete = [];
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expireAt) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
  }
}
class McpLogger {
  level;
  context;
  levelPriority = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
  };
  constructor(level = "info", context = {}) {
    this.level = level;
    this.context = context;
  }
  /**
   * 创建带上下文的子 Logger
   */
  withContext(additionalContext) {
    return new McpLogger(this.level, {
      ...this.context,
      ...additionalContext
    });
  }
  /**
   * 格式化日志消息
   */
  formatMessage(level, message, data) {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const contextStr = Object.keys(this.context).length > 0 ? JSON.stringify(this.context) : "";
    const dataStr = data ? JSON.stringify(data, null, 2) : "";
    return `[${timestamp}] [${level.toUpperCase()}] [MCP] ${contextStr ? `${contextStr} ` : ""}${message}${dataStr ? `
${dataStr}` : ""}`;
  }
  /**
   * 检查是否应该记录该级别的日志
   */
  shouldLog(level) {
    return this.levelPriority[level] >= this.levelPriority[this.level];
  }
  /**
   * Debug 日志
   */
  debug(message, data) {
    if (this.shouldLog("debug")) {
      console.log(this.formatMessage("debug", message, data));
    }
  }
  /**
   * Info 日志
   */
  info(message, data) {
    if (this.shouldLog("info")) {
      console.log(this.formatMessage("info", message, data));
    }
  }
  /**
   * Warn 日志
   */
  warn(message, data) {
    if (this.shouldLog("warn")) {
      console.warn(this.formatMessage("warn", message, data));
    }
  }
  /**
   * Error 日志
   */
  error(message, error2, data) {
    if (this.shouldLog("error")) {
      const errorData = error2 instanceof Error ? {
        message: error2.message,
        stack: error2.stack,
        ...data
      } : { error: error2, ...data };
      console.error(this.formatMessage("error", message, errorData));
    }
  }
  /**
   * 设置日志级别
   */
  setLevel(level) {
    this.level = level;
  }
  /**
   * 获取当前日志级别
   */
  getLevel() {
    return this.level;
  }
}
class ServerLogBuffer {
  buffers = /* @__PURE__ */ new Map();
  maxSize;
  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }
  /**
   * 添加日志
   */
  append(serverKey, log) {
    let buffer = this.buffers.get(serverKey);
    if (!buffer) {
      buffer = [];
      this.buffers.set(serverKey, buffer);
    }
    buffer.push(log);
    if (buffer.length > this.maxSize) {
      buffer.shift();
    }
  }
  /**
   * 获取日志
   */
  get(serverKey, limit) {
    const buffer = this.buffers.get(serverKey) || [];
    if (limit && limit < buffer.length) {
      return buffer.slice(-limit);
    }
    return [...buffer];
  }
  /**
   * 清除指定服务器的日志
   */
  remove(serverKey) {
    this.buffers.delete(serverKey);
  }
  /**
   * 清除所有日志
   */
  clear() {
    this.buffers.clear();
  }
  /**
   * 获取统计信息
   */
  getStats() {
    let totalLogs = 0;
    for (const buffer of this.buffers.values()) {
      totalLogs += buffer.length;
    }
    return {
      totalServers: this.buffers.size,
      totalLogs
    };
  }
}
class ServerManager extends events.EventEmitter {
  servers = /* @__PURE__ */ new Map();
  pendingConnections = /* @__PURE__ */ new Map();
  logBuffer;
  logger;
  constructor(logger) {
    super();
    this.logger = logger.withContext({ component: "ServerManager" });
    this.logBuffer = new ServerLogBuffer(200);
  }
  /**
   * 从存储加载服务器配置
   */
  async loadServers() {
    try {
      const config = await settings.get("mcp_config");
      if (!config) {
        this.logger.info("No MCP config found");
        return;
      }
      assertSafeMcpConfig(config);
      const adaptedConfig = adaptConfig(config);
      assertSafeMcpConfig(adaptedConfig);
      for (const [name, serverConfig] of Object.entries(adaptedConfig)) {
        const server = {
          id: name,
          name,
          type: this.detectServerType(serverConfig),
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env,
          baseUrl: serverConfig.url || serverConfig.baseUrl,
          headers: serverConfig.headers,
          timeout: serverConfig.timeout,
          isActive: true,
          disabledTools: [],
          registryUrl: serverConfig.registryUrl
        };
        this.servers.set(name, {
          server,
          status: "disconnected"
        });
      }
      this.logger.info("Loaded servers", { count: this.servers.size });
    } catch (error2) {
      this.logger.error("Failed to load servers", error2);
    }
  }
  /**
   * 检测服务器类型
   */
  detectServerType(config) {
    if (config.url || config.baseUrl) {
      return config.type || "sse";
    }
    if (config.command) {
      return "stdio";
    }
    return "stdio";
  }
  /**
   * 获取所有服务器
   */
  async getServers() {
    if (this.servers.size === 0) {
      await this.loadServers();
    }
    return Array.from(this.servers.values()).map((info) => info.server);
  }
  /**
   * 获取单个服务器
   */
  async getServer(serverId) {
    const info = this.servers.get(serverId);
    if (!info) {
      throw new Error(`Server not found: ${serverId}`);
    }
    return info.server;
  }
  /**
   * 更新服务器配置
   */
  async updateServers(config) {
    this.logger.info("Updating servers", { count: Object.keys(config).length });
    assertSafeMcpConfig(config);
    const adaptedConfig = adaptConfig(config);
    assertSafeMcpConfig(adaptedConfig);
    await settings.set("mcp_config", config);
    const newServers = /* @__PURE__ */ new Map();
    for (const [name, serverConfig] of Object.entries(adaptedConfig)) {
      const server = {
        id: name,
        name,
        type: this.detectServerType(serverConfig),
        command: serverConfig.command,
        args: serverConfig.args,
        env: serverConfig.env,
        baseUrl: serverConfig.url || serverConfig.baseUrl,
        headers: serverConfig.headers,
        timeout: serverConfig.timeout,
        isActive: true,
        disabledTools: [],
        registryUrl: serverConfig.registryUrl
      };
      const existing = this.servers.get(name);
      if (existing && existing.client) {
        newServers.set(name, {
          server,
          client: existing.client,
          status: existing.status
        });
      } else {
        newServers.set(name, {
          server,
          status: "disconnected"
        });
      }
    }
    for (const [name, info] of this.servers.entries()) {
      if (!newServers.has(name) && info.client) {
        this.logger.info("Closing removed server", { serverId: name });
        await info.client.close();
      }
    }
    this.servers = newServers;
  }
  /**
   * 获取客户端（自动连接）
   */
  async getClient(serverId) {
    const info = this.servers.get(serverId);
    if (!info) {
      throw new Error(`Server not found: ${serverId}`);
    }
    const pending = this.pendingConnections.get(serverId);
    if (pending) {
      this.logger.debug("Waiting for pending connection", { serverId });
      return pending;
    }
    if (info.client) {
      try {
        await info.client.ping({ timeout: 1e3 });
        this.logger.debug("Using existing client", { serverId });
        return info.client;
      } catch (error2) {
        this.logger.warn("Client unhealthy, reconnecting", { serverId });
        info.client = void 0;
        info.status = "disconnected";
      }
    }
    return this.connectServer(serverId);
  }
  /**
   * 连接服务器
   */
  async connectServer(serverId) {
    const info = this.servers.get(serverId);
    if (!info) {
      throw new Error(`Server not found: ${serverId}`);
    }
    const connectionPromise = this.createConnection(info);
    this.pendingConnections.set(serverId, connectionPromise);
    try {
      const client = await connectionPromise;
      info.client = client;
      info.status = "connected";
      info.lastError = void 0;
      this.emit("status", { serverId, status: "connected" });
      this.addLog(serverId, {
        timestamp: Date.now(),
        level: "info",
        message: "Server connected",
        source: "client"
      });
      return client;
    } catch (error2) {
      info.status = "error";
      info.lastError = error2.message;
      this.emit("status", { serverId, status: "error" });
      this.addLog(serverId, {
        timestamp: Date.now(),
        level: "error",
        message: `Connection failed: ${error2.message}`,
        source: "client"
      });
      throw error2;
    } finally {
      this.pendingConnections.delete(serverId);
    }
  }
  /**
   * 创建实际的连接
   */
  async createConnection(info) {
    const { server } = info;
    this.logger.info("Creating connection", { serverId: server.id });
    info.status = "connecting";
    this.emit("status", { serverId: server.id, status: "connecting" });
    const client = new index_js.Client(
      {
        name: "Qwen Desktop",
        version: electron.app.getVersion()
      },
      {
        capabilities: {}
      }
    );
    const transport = await this.createTransport(server);
    await client.connect(transport);
    this.logger.info("Connection established", { serverId: server.id });
    return client;
  }
  /**
   * 创建传输层
   */
  async createTransport(server) {
    if (server.baseUrl) {
      const url = new URL(server.baseUrl);
      const requestInit = {};
      if (server.headers) {
        requestInit.headers = server.headers;
      }
      if (server.type === "streamableHttp") {
        this.logger.debug("Using StreamableHTTP transport", { serverId: server.id });
        return new streamableHttp_js.StreamableHTTPClientTransport(url, { requestInit });
      } else {
        this.logger.debug("Using SSE transport", { serverId: server.id });
        return new sse_js.SSEClientTransport(url, {
          requestInit,
          eventSourceInit: {}
        });
      }
    } else if (server.command) {
      this.logger.debug("Using Stdio transport", { serverId: server.id, command: server.command });
      assertSafeMcpServerConfig(server.id, {
        command: server.command,
        args: server.args,
        env: server.env
      });
      const params = {
        command: server.command,
        args: server.args || [],
        env: server.env || {}
      };
      const transport = new stdio_js.StdioClientTransport(params);
      transport.stderr?.on("data", (data) => {
        const message = data.toString().trim();
        this.addLog(server.id, {
          timestamp: Date.now(),
          level: "stderr",
          message,
          source: "stdio"
        });
      });
      return transport;
    } else {
      throw new Error("Invalid server configuration: no baseUrl or command");
    }
  }
  /**
   * 启动服务器
   */
  async startServer(serverId) {
    this.logger.info("Starting server", { serverId });
    await this.getClient(serverId);
  }
  /**
   * 停止服务器
   */
  async stopServer(serverId) {
    const info = this.servers.get(serverId);
    if (!info) {
      throw new Error(`Server not found: ${serverId}`);
    }
    if (!info.client) {
      this.logger.warn("Server not connected", { serverId });
      return;
    }
    this.logger.info("Stopping server", { serverId });
    try {
      await info.client.close();
      info.client = void 0;
      info.status = "disconnected";
      this.emit("status", { serverId, status: "disconnected" });
      this.addLog(serverId, {
        timestamp: Date.now(),
        level: "info",
        message: "Server stopped",
        source: "client"
      });
    } catch (error2) {
      this.logger.error("Failed to stop server", error2, { serverId });
      throw error2;
    }
  }
  /**
   * 获取服务器日志
   */
  getLogs(serverId, limit) {
    return this.logBuffer.get(serverId, limit);
  }
  /**
   * 添加日志
   */
  addLog(serverId, log) {
    this.logBuffer.append(serverId, log);
    this.emit("log", { serverId, ...log });
  }
  /**
   * 清理所有连接
   */
  async cleanup() {
    this.logger.info("Cleaning up all servers");
    const closePromises = [];
    for (const [serverId, info] of this.servers.entries()) {
      if (info.client) {
        closePromises.push(
          info.client.close().catch((error2) => {
            this.logger.error("Failed to close server", error2, { serverId });
          })
        );
      }
    }
    await Promise.all(closePromises);
    this.servers.clear();
    this.pendingConnections.clear();
    this.logBuffer.clear();
  }
}
class ToolRegistry {
  tools = /* @__PURE__ */ new Map();
  toolsByServer = /* @__PURE__ */ new Map();
  /**
   * 注册工具
   */
  register(tool) {
    this.tools.set(tool.id, tool);
    if (!this.toolsByServer.has(tool.serverId)) {
      this.toolsByServer.set(tool.serverId, /* @__PURE__ */ new Set());
    }
    this.toolsByServer.get(tool.serverId).add(tool.id);
  }
  /**
   * 批量注册工具
   */
  registerMany(tools) {
    for (const tool of tools) {
      this.register(tool);
    }
  }
  /**
   * 获取工具
   */
  get(toolId) {
    return this.tools.get(toolId);
  }
  /**
   * 获取指定服务器的所有工具
   */
  getByServer(serverId) {
    const toolIds = this.toolsByServer.get(serverId);
    if (!toolIds) {
      return [];
    }
    const tools = [];
    for (const toolId of toolIds) {
      const tool = this.tools.get(toolId);
      if (tool) {
        tools.push(tool);
      }
    }
    return tools;
  }
  /**
   * 搜索工具
   */
  search(query) {
    const results = [];
    const lowerQuery = query.toLowerCase();
    for (const tool of this.tools.values()) {
      if (tool.name.toLowerCase().includes(lowerQuery) || tool.description.toLowerCase().includes(lowerQuery)) {
        results.push(tool);
      }
    }
    return results;
  }
  /**
   * 清除指定服务器的工具
   */
  clearByServer(serverId) {
    const toolIds = this.toolsByServer.get(serverId);
    if (toolIds) {
      for (const toolId of toolIds) {
        this.tools.delete(toolId);
      }
      this.toolsByServer.delete(serverId);
    }
  }
  /**
   * 清除所有工具
   */
  clear() {
    this.tools.clear();
    this.toolsByServer.clear();
  }
  /**
   * 获取统计信息
   */
  getStats() {
    const toolsPerServer = {};
    for (const [serverId, toolIds] of this.toolsByServer.entries()) {
      toolsPerServer[serverId] = toolIds.size;
    }
    return {
      totalTools: this.tools.size,
      serverCount: this.toolsByServer.size,
      toolsPerServer
    };
  }
}
class McpService extends events.EventEmitter {
  cache;
  logger;
  serverManager;
  toolRegistry;
  config;
  activeToolCalls = /* @__PURE__ */ new Map();
  initialized = false;
  constructor(config = {}) {
    super();
    this.config = {
      cacheEnabled: config.cacheEnabled ?? true,
      logLevel: config.logLevel ?? "info",
      maxConcurrentCalls: config.maxConcurrentCalls ?? 5
    };
    this.cache = new McpCache();
    this.logger = new McpLogger(this.config.logLevel, { service: "McpService" });
    this.serverManager = new ServerManager(this.logger);
    this.toolRegistry = new ToolRegistry();
    this.serverManager.on("status", (event) => this.emit("server:status", event));
    this.serverManager.on("log", (event) => this.emit("server:log", event));
  }
  /**
   * 初始化服务（加载配置）
   */
  async init() {
    if (this.initialized) {
      return;
    }
    this.logger.info("Initializing MCP service");
    await this.serverManager.loadServers();
    this.initialized = true;
  }
  // ==================== 配置管理 ====================
  /**
   * 获取所有服务器配置
   */
  async getServers() {
    await this.init();
    return this.serverManager.getServers();
  }
  /**
   * 更新服务器配置
   */
  async updateConfig(servers) {
    await this.init();
    this.logger.info("Updating MCP configuration", { serverCount: Object.keys(servers).length });
    await this.serverManager.updateServers(servers);
    if (this.config.cacheEnabled) {
      this.cache.clear();
      this.toolRegistry.clear();
    }
    return this.serverManager.getServers();
  }
  // ==================== 服务器管理 ====================
  /**
   * 启动服务器
   */
  async startServer(serverId) {
    await this.init();
    this.logger.info("Starting server", { serverId });
    await this.serverManager.startServer(serverId);
  }
  /**
   * 停止服务器
   */
  async stopServer(serverId) {
    await this.init();
    this.logger.info("Stopping server", { serverId });
    await this.serverManager.stopServer(serverId);
    if (this.config.cacheEnabled) {
      this.cache.clearByPrefix(`server:${serverId}`);
      this.toolRegistry.clearByServer(serverId);
    }
  }
  /**
   * 重启服务器
   */
  async restartServer(serverId) {
    await this.init();
    this.logger.info("Restarting server", { serverId });
    await this.stopServer(serverId);
    await this.startServer(serverId);
  }
  /**
   * 检查服务器健康状态
   */
  async checkHealth(serverId) {
    await this.init();
    this.logger.debug("Checking server health", { serverId });
    try {
      const startTime = Date.now();
      const client = await this.serverManager.getClient(serverId);
      await client.ping({ timeout: 5e3 });
      const latency = Date.now() - startTime;
      this.logger.debug("Health check passed", { serverId, latency });
      return { healthy: true, latency };
    } catch (error2) {
      this.logger.warn("Health check failed", { serverId, error: error2.message });
      return { healthy: false, error: error2.message };
    }
  }
  /**
   * 获取服务器日志
   */
  async getServerLogs(serverId, limit = 100) {
    await this.init();
    return this.serverManager.getLogs(serverId, limit);
  }
  // ==================== 工具管理 ====================
  /**
   * 列出工具
   */
  async listTools(serverId, includeDisabled = false) {
    await this.init();
    this.logger.debug("Listing tools", { serverId, includeDisabled });
    if (serverId) {
      return this.listToolsForServer(serverId, includeDisabled);
    }
    const servers = await this.serverManager.getServers();
    const activeServers = servers.filter((s) => s.isActive);
    const toolsPromises = activeServers.map(
      (server) => this.listToolsForServer(server.id, includeDisabled).catch((error2) => {
        this.logger.error("Failed to list tools for server", error2, { serverId: server.id });
        return [];
      })
    );
    const toolsArrays = await Promise.all(toolsPromises);
    return toolsArrays.flat();
  }
  /**
   * 列出单个服务器的工具
   */
  async listToolsForServer(serverId, includeDisabled) {
    const cacheKey = `server:${serverId}:tools`;
    if (this.config.cacheEnabled && this.cache.has(cacheKey)) {
      this.logger.debug("Tools loaded from cache", { serverId });
      return this.cache.get(cacheKey);
    }
    const client = await this.serverManager.getClient(serverId);
    const server = await this.serverManager.getServer(serverId);
    const { tools } = await client.listTools();
    const mcpTools = tools.map((tool) => ({
      id: `${serverId}__${tool.name}`,
      name: tool.name,
      description: tool.description || "",
      serverId,
      serverName: server.name,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      disabled: server.disabledTools?.includes(tool.name) || false
    }));
    const filteredTools = includeDisabled ? mcpTools : mcpTools.filter((tool) => !tool.disabled);
    if (this.config.cacheEnabled) {
      this.cache.set(cacheKey, filteredTools, 5 * 60 * 1e3);
    }
    this.toolRegistry.registerMany(filteredTools);
    return filteredTools;
  }
  /**
   * 调用工具
   */
  async callTool(params) {
    await this.init();
    const { serverId, toolName, arguments: args, callId = this.generateCallId() } = params;
    this.logger.info("Calling tool", { serverId, toolName, callId });
    const abortController = new AbortController();
    this.activeToolCalls.set(callId, abortController);
    try {
      const client = await this.serverManager.getClient(serverId);
      const result = await client.callTool(
        { name: toolName, arguments: args },
        void 0,
        {
          signal: abortController.signal,
          timeout: 6e4
        }
      );
      this.logger.info("Tool call succeeded", { serverId, toolName, callId });
      return {
        success: true,
        content: result.content,
        isError: result.isError
      };
    } catch (error2) {
      this.logger.error("Tool call failed", error2, { serverId, toolName, callId });
      return {
        success: false,
        error: error2.message,
        isError: true
      };
    } finally {
      this.activeToolCalls.delete(callId);
    }
  }
  /**
   * 取消工具调用
   */
  async abortTool(callId) {
    const controller = this.activeToolCalls.get(callId);
    if (controller) {
      this.logger.info("Aborting tool call", { callId });
      controller.abort();
      this.activeToolCalls.delete(callId);
      return true;
    }
    this.logger.warn("Tool call not found", { callId });
    return false;
  }
  /**
   * 批量调用工具
   */
  async batchCallTools(calls) {
    await this.init();
    this.logger.info("Batch calling tools", { count: calls.length });
    const results = [];
    const chunks = this.chunkArray(calls, this.config.maxConcurrentCalls);
    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map((call) => this.callTool(call))
      );
      results.push(...chunkResults);
    }
    return results;
  }
  // ==================== 资源管理 ====================
  /**
   * 列出资源
   */
  async listResources(serverId) {
    await this.init();
    this.logger.debug("Listing resources", { serverId });
    const cacheKey = `server:${serverId}:resources`;
    if (this.config.cacheEnabled && this.cache.has(cacheKey)) {
      this.logger.debug("Resources loaded from cache", { serverId });
      return this.cache.get(cacheKey);
    }
    const client = await this.serverManager.getClient(serverId);
    const { resources } = await client.listResources();
    const mcpResources = resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType
    }));
    if (this.config.cacheEnabled) {
      this.cache.set(cacheKey, mcpResources, 2 * 60 * 1e3);
    }
    return mcpResources;
  }
  /**
   * 获取资源内容
   */
  async getResource(serverId, uri) {
    await this.init();
    this.logger.debug("Getting resource", { serverId, uri });
    const client = await this.serverManager.getClient(serverId);
    const result = await client.readResource({ uri });
    return result;
  }
  // ==================== Prompt 管理 ====================
  /**
   * 列出 Prompts
   */
  async listPrompts(serverId) {
    await this.init();
    this.logger.debug("Listing prompts", { serverId });
    const cacheKey = `server:${serverId}:prompts`;
    if (this.config.cacheEnabled && this.cache.has(cacheKey)) {
      this.logger.debug("Prompts loaded from cache", { serverId });
      return this.cache.get(cacheKey);
    }
    const client = await this.serverManager.getClient(serverId);
    const { prompts } = await client.listPrompts();
    const mcpPrompts = prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments
    }));
    if (this.config.cacheEnabled) {
      this.cache.set(cacheKey, mcpPrompts, 5 * 60 * 1e3);
    }
    return mcpPrompts;
  }
  /**
   * 获取 Prompt
   */
  async getPrompt(serverId, name, args) {
    await this.init();
    this.logger.debug("Getting prompt", { serverId, name });
    const client = await this.serverManager.getClient(serverId);
    const result = await client.getPrompt({ name, arguments: args });
    return result;
  }
  // ==================== 统计信息 ====================
  /**
   * 获取统计信息
   */
  getStats() {
    return {
      cacheStats: this.cache.getStats(),
      toolStats: this.toolRegistry.getStats()
    };
  }
  // ==================== 工具方法 ====================
  generateCallId() {
    return `call-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
  /**
   * 清理资源
   */
  async cleanup() {
    this.logger.info("Cleaning up MCP service");
    for (const [callId, controller] of this.activeToolCalls) {
      this.logger.debug("Aborting pending tool call", { callId });
      controller.abort();
    }
    this.activeToolCalls.clear();
    await this.serverManager.cleanup();
    this.cache.clear();
    this.toolRegistry.clear();
    this.removeAllListeners();
    this.initialized = false;
  }
}
const mcpService = new McpService({
  cacheEnabled: true,
  logLevel: "info",
  maxConcurrentCalls: 5
});
var MCPErrorCode = /* @__PURE__ */ ((MCPErrorCode2) => {
  MCPErrorCode2["CONNECTION_FAILED"] = "MCP_CONNECTION_FAILED";
  MCPErrorCode2["CONNECTION_TIMEOUT"] = "MCP_CONNECTION_TIMEOUT";
  MCPErrorCode2["INVALID_CONFIG"] = "MCP_INVALID_CONFIG";
  MCPErrorCode2["SERVER_NOT_FOUND"] = "MCP_SERVER_NOT_FOUND";
  MCPErrorCode2["TOOL_NOT_FOUND"] = "MCP_TOOL_NOT_FOUND";
  MCPErrorCode2["TOOL_CALL_FAILED"] = "MCP_TOOL_CALL_FAILED";
  MCPErrorCode2["TOOL_TIMEOUT"] = "MCP_TOOL_TIMEOUT";
  MCPErrorCode2["TOOL_ABORTED"] = "MCP_TOOL_ABORTED";
  MCPErrorCode2["RESOURCE_NOT_FOUND"] = "MCP_RESOURCE_NOT_FOUND";
  MCPErrorCode2["RESOURCE_ACCESS_DENIED"] = "MCP_RESOURCE_ACCESS_DENIED";
  MCPErrorCode2["PROMPT_NOT_FOUND"] = "MCP_PROMPT_NOT_FOUND";
  MCPErrorCode2["INTERNAL_ERROR"] = "MCP_INTERNAL_ERROR";
  return MCPErrorCode2;
})(MCPErrorCode || {});
const ServerIdSchema = zod.z.object({
  serverId: zod.z.string().min(1, "Server ID is required")
});
const CallToolSchema = zod.z.object({
  serverId: zod.z.string().min(1, "Server ID is required"),
  toolName: zod.z.string().min(1, "Tool name is required"),
  arguments: zod.z.record(zod.z.any()),
  callId: zod.z.string().optional()
});
const AbortToolSchema = zod.z.object({
  callId: zod.z.string().min(1, "Call ID is required")
});
const ListToolsSchema = zod.z.object({
  serverId: zod.z.string().optional(),
  includeDisabled: zod.z.boolean().optional()
});
const GetResourceSchema = zod.z.object({
  serverId: zod.z.string().min(1, "Server ID is required"),
  uri: zod.z.string().min(1, "Resource URI is required")
});
const GetPromptSchema = zod.z.object({
  serverId: zod.z.string().min(1, "Server ID is required"),
  name: zod.z.string().min(1, "Prompt name is required"),
  arguments: zod.z.record(zod.z.string()).optional()
});
const ServerLogsSchema = zod.z.object({
  serverId: zod.z.string().min(1, "Server ID is required"),
  limit: zod.z.number().int().positive().optional()
});
const UpdateConfigSchema = zod.z.record(zod.z.any());
const BatchCallToolsSchema = zod.z.object({
  calls: zod.z.array(
    zod.z.object({
      serverId: zod.z.string(),
      toolName: zod.z.string(),
      arguments: zod.z.record(zod.z.any()),
      callId: zod.z.string().optional()
    })
  )
});
function success(data) {
  return {
    success: true,
    apiVersion: "1.0.0",
    data
  };
}
function error(code, message, details, serverId) {
  return {
    success: false,
    apiVersion: "1.0.0",
    error: {
      code,
      message,
      details,
      serverId,
      timestamp: Date.now()
    }
  };
}
function validate(schema, data) {
  try {
    return schema.parse(data);
  } catch (err) {
    return error(
      MCPErrorCode.INVALID_CONFIG,
      "Invalid parameters",
      err.errors
    );
  }
}
async function handleAsync(fn) {
  try {
    const result = await fn();
    return success(result);
  } catch (err) {
    return error(
      MCPErrorCode.INTERNAL_ERROR,
      err.message || "Unknown error",
      { stack: err.stack }
    );
  }
}
function registerMcpHandlers() {
  electron.ipcMain.handle("mcp:getServers", async (event) => {
    assertTrustedIpcSender(event);
    return handleAsync(() => mcpService.getServers());
  });
  electron.ipcMain.handle("mcp:updateConfig", async (event, data) => {
    assertTrustedIpcSender(event);
    const validated = validate(UpdateConfigSchema, data);
    if ("success" in validated && !validated.success) {
      return validated;
    }
    assertSafeMcpConfig(validated);
    return handleAsync(() => mcpService.updateConfig(validated));
  });
  electron.ipcMain.handle("mcp:startServer", async (event, data) => {
    assertTrustedIpcSender(event);
    const validated = validate(ServerIdSchema, data);
    if ("success" in validated && !validated.success) {
      return validated;
    }
    return handleAsync(() => mcpService.startServer(validated.serverId));
  });
  electron.ipcMain.handle("mcp:stopServer", async (event, data) => {
    assertTrustedIpcSender(event);
    const validated = validate(ServerIdSchema, data);
    if ("success" in validated && !validated.success) {
      return validated;
    }
    return handleAsync(() => mcpService.stopServer(validated.serverId));
  });
  electron.ipcMain.handle("mcp:restartServer", async (event, data) => {
    assertTrustedIpcSender(event);
    const validated = validate(ServerIdSchema, data);
    if ("success" in validated && !validated.success) {
      return validated;
    }
    return handleAsync(() => mcpService.restartServer(validated.serverId));
  });
  electron.ipcMain.handle("mcp:checkHealth", async (event, data) => {
    assertTrustedIpcSender(event);
    const validated = validate(ServerIdSchema, data);
    if ("success" in validated && !validated.success) {
      return validated;
    }
    return handleAsync(() => mcpService.checkHealth(validated.serverId));
  });
  electron.ipcMain.handle("mcp:getServerLogs", async (event, data) => {
    assertTrustedIpcSender(event);
    const validated = validate(ServerLogsSchema, data);
    if ("success" in validated && !validated.success) {
      return validated;
    }
    const { serverId, limit } = validated;
    return handleAsync(() => mcpService.getServerLogs(serverId, limit));
  });
  electron.ipcMain.handle("mcp:listTools", async (event, data = {}) => {
    assertTrustedIpcSender(event);
    const validated = validate(ListToolsSchema, data);
    if ("success" in validated && !validated.success) {
      return validated;
    }
    const { serverId, includeDisabled } = validated;
    return handleAsync(() => mcpService.listTools(serverId, includeDisabled));
  });
  electron.ipcMain.handle("mcp:callTool", async (event, data) => {
    assertTrustedIpcSender(event);
    const validated = validate(CallToolSchema, data);
    if ("success" in validated && !validated.success) {
      return validated;
    }
    return handleAsync(() => mcpService.callTool(validated));
  });
  electron.ipcMain.handle("mcp:abortTool", async (event, data) => {
    assertTrustedIpcSender(event);
    const validated = validate(AbortToolSchema, data);
    if ("success" in validated && !validated.success) {
      return validated;
    }
    return handleAsync(() => mcpService.abortTool(validated.callId));
  });
  electron.ipcMain.handle("mcp:batchCallTools", async (event, data) => {
    assertTrustedIpcSender(event);
    const validated = validate(BatchCallToolsSchema, data);
    if ("success" in validated && !validated.success) {
      return validated;
    }
    return handleAsync(() => mcpService.batchCallTools(validated.calls));
  });
  electron.ipcMain.handle("mcp:listResources", async (event, data) => {
    assertTrustedIpcSender(event);
    const validated = validate(ServerIdSchema, data);
    if ("success" in validated && !validated.success) {
      return validated;
    }
    return handleAsync(() => mcpService.listResources(validated.serverId));
  });
  electron.ipcMain.handle("mcp:getResource", async (event, data) => {
    assertTrustedIpcSender(event);
    const validated = validate(GetResourceSchema, data);
    if ("success" in validated && !validated.success) {
      return validated;
    }
    const { serverId, uri } = validated;
    return handleAsync(() => mcpService.getResource(serverId, uri));
  });
  electron.ipcMain.handle("mcp:listPrompts", async (event, data) => {
    assertTrustedIpcSender(event);
    const validated = validate(ServerIdSchema, data);
    if ("success" in validated && !validated.success) {
      return validated;
    }
    return handleAsync(() => mcpService.listPrompts(validated.serverId));
  });
  electron.ipcMain.handle("mcp:getPrompt", async (event, data) => {
    assertTrustedIpcSender(event);
    const validated = validate(GetPromptSchema, data);
    if ("success" in validated && !validated.success) {
      return validated;
    }
    const { serverId, name, arguments: args } = validated;
    return handleAsync(() => mcpService.getPrompt(serverId, name, args));
  });
  electron.ipcMain.handle("mcp:getStats", async (event) => {
    assertTrustedIpcSender(event);
    try {
      const stats = mcpService.getStats();
      return success(stats);
    } catch (err) {
      return error(MCPErrorCode.INTERNAL_ERROR, err.message);
    }
  });
}
const registerIPC = () => {
  electron.ipcMain.handle("get_app_version", getAppVersion);
  electron.ipcMain.handle("get_platform_info", getPlatformInfo);
  electron.ipcMain.handle("open_devtool", (event) => {
    assertTrustedIpcSender(event);
    return OpenDevTool();
  });
  electron.ipcMain.handle("toggle_hidden_devtools", (event) => {
    assertTrustedIpcSender(event);
    return toggleHiddenDevTools();
  });
  electron.ipcMain.handle("export_log_file", (event) => {
    assertTrustedIpcSender(event);
    return exportLogFile();
  });
  electron.ipcMain.handle("get_log_file_path", (event) => {
    assertTrustedIpcSender(event);
    return getLogFilePath();
  });
  electron.ipcMain.handle("open_external_link", (event, url) => {
    assertTrustedIpcSender(event);
    return openExternalLink(event, url);
  });
  electron.ipcMain.handle("show_native_dialog", (event, options) => {
    assertTrustedIpcSender(event);
    return showNativeDialog(event, options);
  });
  electron.ipcMain.handle("request_file_access", (event, purpose, returnFile) => {
    assertTrustedIpcSender(event);
    return requestFileAccess(event, purpose, returnFile);
  });
  registerMcpHandlers();
  electron.ipcMain.handle("mcp_client_tool_list", (event, serverName) => {
    assertTrustedIpcSender(event);
    return mcpClientToolList(event, serverName);
  });
  electron.ipcMain.handle("mcp_client_tool_call", (event, params) => {
    assertTrustedIpcSender(event);
    return mcpClientToolCall(event, params);
  });
  electron.ipcMain.handle("mcp_client_update_config", (event, config) => {
    assertTrustedIpcSender(event);
    return mcpClientUpdateConfig(event, config);
  });
  electron.ipcMain.handle("mcp_client_get_config", (event) => {
    assertTrustedIpcSender(event);
    return mcpClientGetConfig();
  });
  electron.ipcMain.handle("webview-loaded", (event, id) => {
    assertTrustedIpcSender(event);
    return webviewLoaded(event, id);
  });
  electron.ipcMain.handle("switch_theme", switchTheme);
  electron.ipcMain.handle("switch_ln", switchLn);
  electron.ipcMain.handle("update_title_bar_for_system_theme", updateTitleBarForSystemTheme);
  electron.ipcMain.handle("get_language", () => i18next.language);
  onEvent(({ type, payload }) => {
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
  if (action === "open") {
    if (exports.mainWindow) {
      if (exports.mainWindow.isMinimized()) {
        exports.mainWindow.restore();
      }
      exports.mainWindow.show();
      exports.mainWindow.focus();
    }
    sendEvent("set_cookie", params.token);
  }
}
function validateProtocol(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "qwen:" && ["open"].includes(parsed.hostname) && (parsed.hostname !== "open" || !!parsed.searchParams.get("token"));
  } catch {
    return false;
  }
}
const callClient = () => {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      electron.app.setAsDefaultProtocolClient(SCHEME, process.execPath, [process.argv[1]]);
    }
  } else {
    electron.app.setAsDefaultProtocolClient(SCHEME);
  }
  electron.app.on("open-url", (event, url) => {
    sendLog("openUrl", { url });
    event.preventDefault();
    handleProtocolUrl(url);
  });
  electron.app.on("second-instance", (_, argv) => {
    const urlArg = argv.find((arg) => arg.startsWith("qwen://"));
    if (urlArg) {
      handleProtocolUrl(urlArg);
    }
    if (exports.mainWindow) {
      if (exports.mainWindow.isMinimized()) {
        exports.mainWindow.restore();
      }
      exports.mainWindow.focus();
    }
  });
};
const version = "1.0.5";
function checkArchitectureMatch() {
  const processArch = process.arch;
  const isUnderTranslation = electron.app.runningUnderARM64Translation || false;
  let systemArch;
  let appArch;
  if (isUnderTranslation) {
    systemArch = "arm64";
    appArch = "x64";
  } else {
    const detectedArch = os.arch();
    systemArch = detectedArch;
    appArch = processArch;
  }
  const isMatch = systemArch === appArch && !isUnderTranslation;
  console.log("🔍 架构检测详情:", {
    systemArch,
    processArch,
    appArch,
    isUnderTranslation,
    isMatch
  });
  return {
    isMatch,
    systemArch,
    appArch,
    isUnderTranslation
  };
}
async function checkArchitectureBeforeStart() {
  if (process.platform !== "darwin") {
    return true;
  }
  try {
    const { isMatch, systemArch, appArch, isUnderTranslation } = checkArchitectureMatch();
    sendLog("archCheck", {
      c1: systemArch,
      c2: appArch,
      c3: isMatch ? "match" : "mismatch",
      c4: isUnderTranslation ? "rosetta" : "native"
    });
    if (isMatch) {
      console.log(`✅ 架构匹配: ${systemArch}`);
      return true;
    }
    console.log(`❌ 架构不匹配: 系统=${systemArch}, 应用=${appArch}, 转译=${isUnderTranslation}`);
    const shouldContinue = await showArchMismatchDialog(systemArch, appArch, isUnderTranslation);
    return shouldContinue;
  } catch (error2) {
    console.error("架构检测失败:", error2);
    sendLog("archCheckError", { c1: error2.message });
    return true;
  }
}
async function showArchMismatchDialog(systemArch, appArch, isUnderTranslation = false) {
  const getArchName = (arch2) => {
    if (arch2 === "arm64") {
      return i18next.t("arch.arch_apple_silicon");
    } else if (arch2 === "x64") {
      return i18next.t("arch.arch_intel");
    }
    return arch2;
  };
  const systemName = getArchName(systemArch);
  const appName = getArchName(appArch);
  const detailParts = [
    "",
    i18next.t("arch.system_arch", { arch: systemName }),
    i18next.t("arch.app_arch", { arch: appName })
  ];
  if (isUnderTranslation) {
    detailParts.push(i18next.t("arch.running_under_rosetta"));
  }
  detailParts.push(
    "",
    i18next.t("arch.performance_warning"),
    i18next.t("arch.performance_issue_1"),
    i18next.t("arch.performance_issue_2"),
    i18next.t("arch.performance_issue_3"),
    i18next.t("arch.performance_issue_4"),
    "",
    i18next.t("arch.recommendation")
  );
  const detailMessage = detailParts.join("\n");
  try {
    console.log("⚠️ 显示架构不匹配对话框...");
    const response = await electron.dialog.showMessageBox({
      type: "warning",
      title: i18next.t("arch.mismatch_title"),
      message: i18next.t("arch.mismatch_message"),
      detail: detailMessage,
      buttons: [i18next.t("arch.go_to_download"), i18next.t("arch.continue_anyway")],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (response.response === 0) {
      console.log("用户选择前往下载");
      sendLog("archCheckAction", { c1: "goToDownload" });
      await electron.shell.openExternal("https://qwen.ai/download");
      return false;
    } else {
      console.log("用户选择继续使用");
      sendLog("archCheckAction", { c1: "continueAnyway" });
      return true;
    }
  } catch (error2) {
    console.error("❌ 显示对话框失败:", error2);
    sendLog("archCheckDialogError", { c1: error2.message });
    return true;
  }
}
process.on("uncaughtException", (error2) => {
  sendLog("nodeUncaughtException", { c1: error2.message });
});
process.on("unhandledRejection", (reason, _) => {
  let msg = "";
  if (typeof reason === "object" && reason !== null && "message" in reason) {
    msg = reason.message;
  } else {
    msg = String(reason);
  }
  if (msg.includes("403") && msg.includes("latest.yml") && msg.includes("Forbidden")) {
    return;
  }
  console.log("Unhandled Rejection:", reason);
});
exports.mainWindow = null;
const logPath = path.join(electron.app.getPath("userData"), "qwen-electron-debug.log");
const origLog = console.log;
try {
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  let needTruncate = true;
  if (fs$1.existsSync(logPath)) {
    const stats = fs$1.statSync(logPath);
    const lastModified = new Date(stats.mtime);
    const lastDay = lastModified.toISOString().slice(0, 10);
    if (lastDay === today) {
      needTruncate = false;
    }
  }
  if (needTruncate) {
    fs$1.writeFileSync(logPath, "");
  }
} catch (e) {
  origLog("Failed to truncate log file:", e);
}
console.log = (...args) => {
  const now = /* @__PURE__ */ new Date();
  const timeStr = now.toISOString().replace("T", " ").slice(0, 19);
  const msg = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  fs$1.appendFileSync(logPath, `[${timeStr}] ${msg}
`);
  origLog.apply(console, args);
};
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
    defaultHeight: Math.min(840, height * 0.85)
  });
  exports.mainWindow = new electron.BrowserWindow({
    width: mainWindowState.width,
    height: mainWindowState.height,
    show: false,
    center: true,
    minWidth: 400,
    titleBarStyle: process.platform === "darwin" ? "hidden" : void 0,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false
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
  });
  exports.mainWindow.webContents.setWindowOpenHandler((details) => {
    electron.shell.openExternal(details.url);
    return { action: "deny" };
  });
  exports.mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const targetUrl = params.src || "";
    if (!targetUrl.startsWith("https://chat.qwen.ai") && !targetUrl.startsWith("https://pre-chat.qwen.ai")) {
      event.preventDefault();
      return;
    }
    webPreferences.preload = path.join(__dirname, "../preload/index.js");
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.sandbox = false;
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
    if (exports.mainWindow && !exports.mainWindow.isDestroyed()) {
      exports.mainWindow.show();
    }
  });
  const defaultUA = exports.mainWindow.webContents.getUserAgent();
  const customUA = `${defaultUA} AliDesktop(QWENCHAT/${version})`;
  if (!electron.app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    exports.mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"], { userAgent: customUA });
  } else {
    exports.mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  return exports.mainWindow;
}
let deeplinkingUrl = null;
if (process.platform === "win32") {
  const urlArg = process.argv.find((arg) => arg.startsWith("qwen://"));
  if (urlArg) {
    deeplinkingUrl = urlArg;
  }
}
const gotTheLock = electron.app.requestSingleInstanceLock();
if (!gotTheLock) {
  electron.app.quit();
} else {
  electron.app.whenReady().then(async () => {
    sendLog("initProcess", { c1: process.pid, c2: "appReady" });
    if (process.platform === "win32") {
      electron.app.setAppUserModelId("com.qwen.chat");
    }
    await initI18n();
    const shouldContinue = await checkArchitectureBeforeStart();
    if (!shouldContinue) {
      console.log("用户选择前往下载正确版本，应用即将退出");
      electron.app.quit();
      return;
    }
    createWindow();
    callClient();
    registerIPC();
    autoUpdate();
    buildAppMenu();
    if (deeplinkingUrl) {
      handleProtocolUrl(deeplinkingUrl);
    }
    electron.app.on("activate", function() {
      sendLog("initProcess", { c1: process.pid, c2: "appActivate" });
      if (electron.BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        exports.mainWindow?.show();
      }
    });
  });
}
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
