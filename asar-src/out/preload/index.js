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
const api = {
  PRELOAD_FILE_PATH: path.join(__dirname, "../preload/index.js"),
  open_devtool: () => electron.ipcRenderer.invoke("open_devtool"),
  toggle_hidden_devtools: () => electron.ipcRenderer.invoke("toggle_hidden_devtools"),
  get_app_version: () => electron.ipcRenderer.invoke("get_app_version"),
  get_platform_info: () => electron.ipcRenderer.invoke("get_platform_info"),
  open_external_link: (url) => electron.ipcRenderer.invoke("open_external_link", url),
  show_native_dialog: (options) => electron.ipcRenderer.invoke("show_native_dialog", options),
  request_file_access: (purpose) => electron.ipcRenderer.invoke("request_file_access", purpose),
  // MCP 方法
  mcp_client_connect: () => electron.ipcRenderer.invoke("mcp_client_connect"),
  mcp_client_close: () => electron.ipcRenderer.invoke("mcp_client_close"),
  mcp_client_tool_list: (serviceName) => electron.ipcRenderer.invoke("mcp_client_tool_list", serviceName),
  mcp_client_get_config: () => electron.ipcRenderer.invoke("mcp_client_get_config"),
  mcp_client_tool_call: (options) => electron.ipcRenderer.invoke("mcp_client_tool_call", options),
  mcp_client_update_config: (config = {}) => electron.ipcRenderer.invoke("mcp_client_update_config", config),
  switch_theme: (theme) => electron.ipcRenderer.invoke("switch_theme", theme),
  switch_ln: (language) => electron.ipcRenderer.invoke("switch_ln", language),
  // 事件系统
  on_event: (type, callback) => {
    events.on(type, callback);
  },
  send_event: (data) => {
    electron.ipcRenderer.send("event_to_main", data);
  }
};
if (process.contextIsolated) {
  try {
    electron.contextBridge.exposeInMainWorld("electron", preload.electronAPI);
    electron.contextBridge.exposeInMainWorld("electronAPI", api);
  } catch (error) {
    console.error(error);
  }
} else {
  window.electron = preload.electronAPI;
  window.electronAPI = api;
}
electron.ipcRenderer.on("event_from_main", (_, { type, payload }) => {
  events.emit(type, payload);
});
