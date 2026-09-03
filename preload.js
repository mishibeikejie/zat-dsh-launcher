'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * 渲染进程唯一入口。只暴露白名单方法，不暴露 ipcRenderer 本体。
 * 所有方法都返回 Promise<{ ok, message, ... }>；on* 用于订阅事件。
 */

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  // 返回取消函数：一次性订阅（如安装进度）用完必须取消，
  // 否则多次安装会累积永久监听器（旧监听器继续处理新进度事件，泄漏+浪费）
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  // 初始状态 / 设置
  getState: () => ipcRenderer.invoke('state:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  clearLogs: (terminalId) => ipcRenderer.invoke('logs:clear', terminalId),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  openUrl: (url) => ipcRenderer.invoke('shell:open-url', url),

  // DSH 生命周期
  start: (terminalId) => ipcRenderer.invoke('dsh:start', terminalId),
  stop: (terminalId, options) => ipcRenderer.invoke('dsh:stop', terminalId, options),
  restart: (terminalId, options) => ipcRenderer.invoke('dsh:restart', terminalId, options),
  openWeb: (terminalId) => ipcRenderer.invoke('dsh:open-web', terminalId),

  // 独立终端注册与实时状态
  terminalList: () => ipcRenderer.invoke('terminals:list'),
  terminalSelect: (terminalId) => ipcRenderer.invoke('terminals:select', terminalId),
  terminalStatus: (terminalId) => ipcRenderer.invoke('terminals:status', terminalId),
  terminalSessions: (terminalId) => ipcRenderer.invoke('terminals:sessions', terminalId),
  terminalScan: () => ipcRenderer.invoke('terminals:scan'),
  terminalChooseDirectory: () => ipcRenderer.invoke('terminals:choose-directory'),
  terminalConnectDirectory: (dshDir, options) => ipcRenderer.invoke('terminals:connect-directory', dshDir, options),
  terminalCreateEmpty: () => ipcRenderer.invoke('terminals:create-empty'),
  installFresh: (options) => ipcRenderer.invoke('terminals:install-fresh', options),
  engineStatus: (terminalId) => ipcRenderer.invoke('engine:status', terminalId),
  engineInject: (terminalId) => ipcRenderer.invoke('engine:inject', terminalId),
  engineRollback: (terminalId) => ipcRenderer.invoke('engine:rollback', terminalId),
  engineInstall: (terminalId) => ipcRenderer.invoke('engine:install', terminalId),
  engineCheckUpdate: (terminalId) => ipcRenderer.invoke('engine:check-update', terminalId),
  rescueStatus: (terminalId) => ipcRenderer.invoke('rescue:status', terminalId),
  rescueCreate: (terminalId) => ipcRenderer.invoke('rescue:create', terminalId),
  rescueRestore: (terminalId) => ipcRenderer.invoke('rescue:restore', terminalId),
  rescueDiagnose: (terminalId) => ipcRenderer.invoke('rescue:diagnose', terminalId),
  rescueExclude: (terminalId, pluginName) => ipcRenderer.invoke('rescue:exclude', terminalId, pluginName),
  rescueReinstallBundles: (terminalId) => ipcRenderer.invoke('rescue:reinstall-bundles', terminalId),
  rescueRebuildSource: (terminalId) => ipcRenderer.invoke('rescue:rebuild-source', terminalId),
  rescueInstallSourceDeps: (terminalId) => ipcRenderer.invoke('rescue:install-source-deps', terminalId),
  harnessInfo: (terminalId) => ipcRenderer.invoke('harness:info', terminalId),
  harnessCheckUpdate: (terminalId) => ipcRenderer.invoke('harness:check-update', terminalId),
  harnessInstallUpdate: (terminalId) => ipcRenderer.invoke('harness:install-update', terminalId),
  launcherCheckUpdate: () => ipcRenderer.invoke('launcher:update-check'),

  // 多环境
  envList: () => ipcRenderer.invoke('env:list'),
  envSwitch: (id) => ipcRenderer.invoke('env:switch', id),
  envAdd: (input) => ipcRenderer.invoke('env:add', input),
  envRemove: (id) => ipcRenderer.invoke('env:remove', id),

  // 环境
  checkEnv: () => ipcRenderer.invoke('env:check'),
  repairEnv: () => ipcRenderer.invoke('env:repair'),
  chooseDshDir: () => ipcRenderer.invoke('config:choose-dsh-dir'),
  getConfig: () => ipcRenderer.invoke('config:get'),

  // 窗口控制
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  quitConfirmed: () => ipcRenderer.send('window:quit-confirmed'),
  quitCancelled: () => ipcRenderer.send('window:quit-cancelled'),

  // 事件订阅（回调在页面生命周期内有效）
  onLog: (cb) => on('log:entry', cb),
  onStatus: (cb) => on('status:changed', cb),
  onTerminalStatus: (cb) => on('terminals:status', cb),
  onInstallProgress: (cb) => on('install:progress', cb),
  onTerminalDeleting: (cb) => on('terminal:deleting', cb),
  onBusy: (cb) => on('busy:changed', cb),
  onSettings: (cb) => on('settings:changed', cb),
  onLogsCleared: (cb) => on('logs:cleared', cb),
  onWindowMaximized: (cb) => on('window:maximized', cb),
  onQuitRequest: (cb) => on('window:quit-request', cb),
}

contextBridge.exposeInMainWorld('dshLauncher', api)
