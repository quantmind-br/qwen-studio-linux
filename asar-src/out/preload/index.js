"use strict";
const electron = require("electron");
const preload = require("@electron-toolkit/preload");
const path = require("path");
class EventEmitter {
  listeners = {};
  on(eventName, listener) {
    if (!this.listeners[eventName]) {
      this.listeners[eventName] = [];
    }
    this.listeners[eventName].push(listener);
  }
  emit(eventName, ...args) {
    const listeners = this.listeners[eventName];
    if (listeners) {
      listeners.forEach((listener) => listener(...args));
    }
  }
}
const events = new EventEmitter();
const isTopLevelFrame = (() => {
  try {
    return window.top === window;
  } catch {
    return false;
  }
})();
const api = {
  PRELOAD_FILE_PATH: path.join(__dirname, "../preload/index.js"),
  open_devtool: () => electron.ipcRenderer.invoke("open_devtool"),
  toggle_hidden_devtools: () => electron.ipcRenderer.invoke("toggle_hidden_devtools"),
  get_app_version: () => electron.ipcRenderer.invoke("get_app_version"),
  get_platform_info: () => electron.ipcRenderer.invoke("get_platform_info"),
  open_external_link: (url) => electron.ipcRenderer.invoke("open_external_link", url),
  show_native_dialog: (options) => electron.ipcRenderer.invoke("show_native_dialog", options),
  request_file_access: (purpose) => electron.ipcRenderer.invoke("request_file_access", purpose),
  // MCP 方法 - 旧版 API（向后兼容）
  mcp_client_connect: () => electron.ipcRenderer.invoke("mcp_client_connect"),
  mcp_client_close: () => electron.ipcRenderer.invoke("mcp_client_close"),
  mcp_client_tool_list: (serviceName) => electron.ipcRenderer.invoke("mcp_client_tool_list", serviceName),
  mcp_client_get_config: () => electron.ipcRenderer.invoke("mcp_client_get_config"),
  mcp_client_tool_call: (options) => electron.ipcRenderer.invoke("mcp_client_tool_call", options),
  mcp_client_update_config: (config = {}) => {
    return electron.ipcRenderer.invoke("mcp_client_update_config", config);
  },
  // MCP 方法 - 新版 API（推荐使用）
  mcp: {
    // 配置管理
    getServers: () => electron.ipcRenderer.invoke("mcp:getServers"),
    updateConfig: (config) => electron.ipcRenderer.invoke("mcp:updateConfig", config),
    // 服务器管理
    startServer: (serverId) => electron.ipcRenderer.invoke("mcp:startServer", { serverId }),
    stopServer: (serverId) => electron.ipcRenderer.invoke("mcp:stopServer", { serverId }),
    restartServer: (serverId) => electron.ipcRenderer.invoke("mcp:restartServer", { serverId }),
    checkHealth: (serverId) => electron.ipcRenderer.invoke("mcp:checkHealth", { serverId }),
    getServerLogs: (serverId, limit) => electron.ipcRenderer.invoke("mcp:getServerLogs", { serverId, limit }),
    // 工具管理
    listTools: (serverId, includeDisabled) => electron.ipcRenderer.invoke("mcp:listTools", { serverId, includeDisabled }),
    callTool: (params) => electron.ipcRenderer.invoke("mcp:callTool", params),
    abortTool: (callId) => electron.ipcRenderer.invoke("mcp:abortTool", { callId }),
    batchCallTools: (calls) => electron.ipcRenderer.invoke("mcp:batchCallTools", { calls }),
    // 资源管理
    listResources: (serverId) => electron.ipcRenderer.invoke("mcp:listResources", { serverId }),
    getResource: (serverId, uri) => electron.ipcRenderer.invoke("mcp:getResource", { serverId, uri }),
    // Prompt 管理
    listPrompts: (serverId) => electron.ipcRenderer.invoke("mcp:listPrompts", { serverId }),
    getPrompt: (serverId, name, args) => electron.ipcRenderer.invoke("mcp:getPrompt", { serverId, name, arguments: args }),
    // 统计信息
    getStats: () => electron.ipcRenderer.invoke("mcp:getStats")
  },
  switch_theme: (theme) => electron.ipcRenderer.invoke("switch_theme", theme),
  switch_ln: (language) => electron.ipcRenderer.invoke("switch_ln", language),
  update_title_bar_for_system_theme: (isDark) => electron.ipcRenderer.invoke("update_title_bar_for_system_theme", isDark),
  // 日志管理
  export_log_file: () => electron.ipcRenderer.invoke("export_log_file"),
  get_log_file_path: () => electron.ipcRenderer.invoke("get_log_file_path"),
  // 事件系统
  on_event: (type, callback) => {
    events.on(type, callback);
  },
  send_event: (data) => {
    electron.ipcRenderer.send("event_to_main", data);
  }
};
if (isTopLevelFrame && process.contextIsolated) {
  try {
    electron.contextBridge.exposeInMainWorld("electron", preload.electronAPI);
    electron.contextBridge.exposeInMainWorld("electronAPI", api);
  } catch (error) {
    console.error(error);
  }
} else if (isTopLevelFrame) {
  window.electron = preload.electronAPI;
  window.electronAPI = api;
}
electron.ipcRenderer.on("event_from_main", (_, { type, payload }) => {
  events.emit(type, payload);
});
