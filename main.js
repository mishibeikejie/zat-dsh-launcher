'use strict'

/* DSH 启动器 — 主进程（Electron） */

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron')
const { spawn, execFile } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { TerminalRegistry } = require('./src/terminal-registry')
const { TerminalSupervisor, probePort } = require('./src/terminal-supervisor')
const { parseNetstatListeningPids } = require('./src/windows-process')
const harnessUpdate = require('./src/harness-update')
const { localInfo: harnessLocalInfo, checkUpdate: checkHarnessUpdate, installUpdate: installHarnessUpdate } = harnessUpdate
const { inspectDshDir, scanDshInstallations, normalizeDshPath, normalizeNpmRoot, findRegisteredByDshDir, processEntries, findDshRootNear, findDshPackageRoots, isDshHomeDir } = require('./src/terminal-discovery')
const freshInstall = require('./src/fresh-install')
const engineManager = require('./src/engine-manager')
const rescue = require('./src/rescue')
const terminalActivity = require('./src/terminal-activity')
const sessionActivity = require('./src/session-activity')
const { fetchSessionList } = require('./src/session-list')
const { planTerminalDeletion } = require('./src/terminal-files')
const toolchainExec = require('./src/toolchain-execute')
const cliProbe = require('./src/cli-probe')

const APP_VERSION = '1.3.1'

// ---------------------------------------------------------------------------
// 白板/交付版隔离：打包版使用按版本隔离的数据目录（%APPDATA%\ZAT-Launcher\v<版本>），
// 终端注册表/日志/配置全部落在版本独立目录。
//  - 新版本（或新解压的副本）打开 = 全新白板，读不到任何旧版本/旧解压的残留记录
//  - 同一版本内反复打开 = 记录正常保留
//  - 开发版（electron .）保持原 userData，不受影响
// ---------------------------------------------------------------------------
if (app.isPackaged) {
  try {
    app.setPath('userData', path.join(app.getPath('appData'), 'ZAT-Launcher', `v${APP_VERSION}`))
  } catch { /* 设置失败则退回默认目录 */ }
}

// 单实例锁：双击/重复打开只保留一个实例，第二个实例唤醒第一个（防注册表并发写坏）
const gotSingleLock = app.requestSingleInstanceLock ? app.requestSingleInstanceLock() : true
if (!gotSingleLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    try {
      if (state.win) {
        if (state.win.isMinimized()) state.win.restore()
        state.win.focus()
      }
    } catch { /* 忽略 */ }
  })
}

// ---------------------------------------------------------------------------
// 配置与多环境（21:10 版架构：自动发现环境 + 手动环境 + 每环境日志）
// ---------------------------------------------------------------------------

const MAX_LOGS = 3000
const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024
const LOG_LINES_AFTER_ROTATION = 1000

const CONFIG = {
  dshDir: '',
  dshHome: '',
  profileName: 'web',
  port: 3080,
  webUrl: 'http://127.0.0.1:3080',
  mirror: 'https://gh-proxy.com/',
  fallbackMirror: 'https://ghfast.top/',
  startTimeoutMs: 90000,
  restartDelayMs: 2000,
}

let ENVIRONMENTS = []
let currentEnvId = ''
let terminalRegistry = null
let terminalSupervisor = null
const ignoredAutoEnvIds = []
let portCache = { at: 0, port: 0, pids: [] }

function readJsonFile(p, fallback) {
  try {
    let text = fs.readFileSync(p, 'utf8')
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1) // 容忍 UTF-8 BOM
    return JSON.parse(text)
  } catch { return fallback }
}

function configBundledPath() { return path.join(__dirname, 'launcher-config.json') }

function configUserPath() { return path.join(app.getPath('userData'), 'config.json') }

function resolveHome(dshHome) {
  return dshHome && dshHome.trim() ? dshHome.trim() : path.join(os.homedir(), '.dsh')
}

function dshHomeRoot() { return resolveHome('') }

function friendlyError(err) {
  const m = String(err && err.message || err || '未知错误')
  return m.length > 200 ? m.slice(0, 200) + '…' : m
}

function looksLikeDshDir(dir) {
  if (!dir || typeof dir !== 'string' || !fs.existsSync(dir)) return false
  return fs.existsSync(path.join(dir, 'apps', 'cli')) || fs.existsSync(path.join(dir, 'package.json'))
}

function normalizeConfig(partial) {
  const c = partial || {}
  return {
    dshHome: typeof c.dshHome === 'string' ? c.dshHome : (CONFIG.dshHome || ''),
    profileName: c.profileName || 'web',
    port: Number(c.port) || 3080,
    mirror: c.mirror || 'https://gh-proxy.com/',
    fallbackMirror: c.fallbackMirror || 'https://ghfast.top/',
  }
}

function defaultEnvironment() {
  return {
    id: 'default', name: '默认', dshHome: '', dshDir: '', profileName: 'web',
    port: 3080, mirror: 'https://gh-proxy.com/', fallbackMirror: 'https://ghfast.top/', manual: false,
  }
}

// 自动发现环境：扫描用户目录下带 profiles/web 的 .dsh* 目录
// 环境 id = 目录名 + "-" + profile 名（如 .dsh-web、.dsh-dev-web），与 21:10 版一致
// 白板/交付版（app.isPackaged）不自动扫描：打开即空白，绝不读取/注册本机已有 DSH。
function autoEnvironments() {
  if (app.isPackaged) return []
  const home = os.homedir()
  let entries = []
  try { entries = fs.readdirSync(home, { withFileTypes: true }) } catch { return [] }
  const list = []
  let idx = 0
  for (const ent of entries) {
    if (!ent.isDirectory() || !/^\.dsh[-_a-zA-Z0-9]*$/.test(ent.name)) continue
    if (ignoredAutoEnvIds.includes(ent.name)) continue
    const profileName = 'web'
    const id = `${ent.name}-${profileName}`
    list.push({
      id, name: id, dshHome: path.join(home, ent.name), dshDir: '',
      profileName, port: 3080 + idx, mirror: 'https://gh-proxy.com/',
      fallbackMirror: 'https://ghfast.top/', manual: false,
    })
    idx++
  }
  return list
}

function rebuildEnvironments() {
  const userCfg = readJsonFile(configUserPath(), {})
  const manual = Array.isArray(userCfg.envs)
    ? userCfg.envs.filter((e) => e && typeof e === 'object' && e.manual)
    : []
  const merged = [...autoEnvironments()]
  for (const m of manual) {
    if (!merged.some((e) => e.id === m.id)) merged.push(m)
  }
  ENVIRONMENTS = merged
  if (!ENVIRONMENTS.some((e) => e.id === currentEnvId)) {
    currentEnvId = ENVIRONMENTS.length ? ENVIRONMENTS[0].id : 'default'
  }
}

function applyConfig(obj, label) {
  if (!obj || typeof obj !== 'object') return
  for (const k of Object.keys(obj)) {
    if (k in CONFIG && typeof obj[k] !== 'object') CONFIG[k] = obj[k]
  }
  addLog(`使用配置（${label}）：${JSON.stringify(obj)}`, 'info')
}

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

const state = {
  settings: { autoRestart: true, autoOpen: true },
  status: { running: false, pids: [], childPid: null, starting: false, stopping: false },
  logs: [],
  win: null,
}
const logHistory = state.logs

// 日志（内存 + 推送 + 写文件，按环境分文件）
function pushLog(level, text) {
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const entry = {
    time: `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`,
    level,
    text: String(text),
    kind: '',
  }
  logHistory.push(entry)
  if (logHistory.length > MAX_LOGS) logHistory.splice(0, logHistory.length - MAX_LOGS)
  try {
    const logFile = path.join(app.getPath('userData'), `launcher-${currentEnvId || 'default'}.log`)
    fs.appendFileSync(logFile, `[${entry.time}] [${level}] ${entry.text}\n`)
    trimLogFile(logFile)
  } catch { /* 写日志失败不致命 */ }
  if (state.win && !state.win.isDestroyed()) {
    state.win.webContents.send('log:entry', entry)
  }
}

function trimLogFile(logFile) {
  try {
    if (fs.statSync(logFile).size <= MAX_LOG_FILE_BYTES) return
    const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean)
    fs.writeFileSync(logFile, `${lines.slice(-LOG_LINES_AFTER_ROTATION).join('\n')}\n`, 'utf8')
  } catch { /* 日志轮转失败不影响 DSH */ }
}

// 使用日志保留一周：启动时清理超过 7 天的启动器日志与终端活动记录。
// 只清理启动器自己的数据（userData 下），绝不碰 DSH_HOME/会话/终端目录。
function pruneOldLogs() {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000
  const cutoff = Date.now() - WEEK_MS
  const candidates = []
  try {
    const userData = app.getPath('userData')
    // 启动器根日志 launcher-*.log
    for (const name of fs.readdirSync(userData)) {
      if (/^launcher-.*\.log$/.test(name)) candidates.push(path.join(userData, name))
    }
    // 终端日志 logs/<terminalId>/launcher.log
    const logsDir = path.join(userData, 'logs')
    if (fs.existsSync(logsDir)) {
      for (const tid of fs.readdirSync(logsDir)) {
        const file = path.join(logsDir, tid, 'launcher.log')
        if (fs.existsSync(file)) candidates.push(file)
      }
    }
    // 终端活动记录 activity/<terminalId>.jsonl
    const activityDir = path.join(userData, 'activity')
    if (fs.existsSync(activityDir)) {
      for (const name of fs.readdirSync(activityDir)) {
        if (name.endsWith('.jsonl')) candidates.push(path.join(activityDir, name))
      }
    }
  } catch { /* 清理失败不影响启动 */ }
  for (const file of candidates) {
    try {
      const st = fs.statSync(file)
      if (st.isFile() && st.mtimeMs < cutoff) fs.rmSync(file, { force: true })
    } catch { /* 单个文件清理失败跳过 */ }
  }
}

function addLog(text, level) { pushLog(level || 'info', text) }

function loadLogHistoryFromDisk() {
  try {
    const logFile = path.join(app.getPath('userData'), `launcher-${currentEnvId || 'default'}.log`)
    if (!fs.existsSync(logFile)) return
    const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).slice(-MAX_LOGS)
    for (const line of lines) {
      const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\] \[(\w+)\] (.*)$/)
      if (m) logHistory.push({ time: m[1], level: m[2], text: m[3], kind: '' })
    }
    if (logHistory.length > MAX_LOGS) logHistory.splice(0, logHistory.length - MAX_LOGS)
  } catch { /* 忽略 */ }
}

// ---- 环境（21:10 原版逻辑）----

function applyEnvironment(id) {
  const env = ENVIRONMENTS.find((e) => e.id === id) || ENVIRONMENTS[0]
  if (!env) return { ok: false, message: '没有可用环境' }
  currentEnvId = env.id
  // 每个环境自己的状态:
  // - 手动环境且配了目录 → 用它的(多份 DSH 源码互不干扰)
  // - 手动新环境(dshDir 空) → 保持"未接入",让用户独立安装/选择
  // - 自动扫描环境(非手动,如 .dsh-dev 没配目录) → 继承"用户配置记忆的主环境源码目录"
  let sharedDir = ''
  if (!(env.manual && env.dshDir)) {
    const userCfg = readJsonFile(configUserPath(), {})
    const mem = (userCfg && typeof userCfg.dshDir === 'string') ? userCfg.dshDir : ''
    if (mem && looksLikeDshDir(mem)) sharedDir = mem
  }
  const envDshDir = (env.manual && !env.dshDir)
    ? ''
    : ((env.dshDir && looksLikeDshDir(env.dshDir)) ? env.dshDir : sharedDir)
  Object.assign(CONFIG, normalizeConfig({
    dshHome: env.dshHome,
    profileName: env.profileName,
    port: env.port,
    mirror: env.mirror,
    fallbackMirror: env.fallbackMirror,
  }))
  CONFIG.dshDir = envDshDir
  CONFIG.webUrl = `http://127.0.0.1:${CONFIG.port}`
  portCache = { at: 0, port: 0, pids: [] }
  saveUserConfig()
  // 切换环境 = 切换日志:清空内存缓冲,加载该环境自己的日志文件
  logHistory.length = 0
  loadLogHistoryFromDisk()
  addLog(`已切换到环境「${env.name}」：端口 ${CONFIG.port}，profile ${CONFIG.profileName}`, 'info')
  return { ok: true, message: `已切换到环境「${env.name}」`, environment: envPayload(env) }
}

function envPayload(env) {
  const e = env || ENVIRONMENTS.find((x) => x.id === currentEnvId) || defaultEnvironment()
  // 手动新环境 dshDir 为空就是"未接入"，不能拿当前主环境的目录伪装成已接入。
  const dshDir = e.manual ? (e.dshDir || '') : (e.dshDir || CONFIG.dshDir)
  return {
    id: e.id,
    name: e.name,
    dshHome: e.dshHome || dshHomeRoot(),
    profileName: e.profileName || 'web',
    port: e.port || 3080,
    webUrl: `http://127.0.0.1:${e.port || 3080}`,
    dshDir,
    manual: !!e.manual,
  }
}

function saveUserConfig() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    // 未接入(CONFIG.dshDir 空)时,保留上次记忆的 dshDir,不清掉"上次接入"提示
    let savedDshDir = CONFIG.dshDir
    if (!savedDshDir) {
      const prev = readJsonFile(configUserPath(), {})
      if (prev && typeof prev.dshDir === 'string' && prev.dshDir) savedDshDir = prev.dshDir
    }
    fs.writeFileSync(configUserPath(), JSON.stringify({
      currentEnv: currentEnvId,
      envs: ENVIRONMENTS.filter((e) => e.manual).map((e) => ({
        id: e.id, name: e.name, dshHome: e.dshHome, dshDir: e.dshDir,
        profileName: e.profileName, port: e.port, mirror: e.mirror,
        fallbackMirror: e.fallbackMirror, manual: true,
      })),
      ignoredAutoEnvIds: [...ignoredAutoEnvIds],
      settings: { ...state.settings },
      dshDir: savedDshDir,
      profileName: CONFIG.profileName,
      port: CONFIG.port,
      webUrl: CONFIG.webUrl,
      mirror: CONFIG.mirror,
      fallbackMirror: CONFIG.fallbackMirror,
    }, null, 2) + '\n', 'utf8')
  } catch (err) {
    addLog('保存 DSH 目录配置失败：' + friendlyError(err), 'warn')
  }
}

function loadConfig() {
  applyConfig(readJsonFile(configBundledPath(), {}), '项目配置 launcher-config.json')
  applyConfig(readJsonFile(configUserPath(), {}), '用户配置 config.json')
  // 接入过一次就记住:记忆的目录仍然有效则打开直接"已接入"
  if (CONFIG.dshDir && !looksLikeDshDir(CONFIG.dshDir)) {
    addLog(`记忆的 DSH 目录已失效，重置为未接入：${CONFIG.dshDir}`, 'warn')
    CONFIG.dshDir = ''
  }
  CONFIG.webUrl = `http://127.0.0.1:${CONFIG.port}`
  portCache = { at: 0, port: 0, pids: [] }
  rebuildEnvironments()
  const explicit = readJsonFile(configUserPath(), {})
  if (explicit && typeof explicit.currentEnv === 'string' && ENVIRONMENTS.some((e) => e.id === explicit.currentEnv)) {
    currentEnvId = explicit.currentEnv
  }
  // 回读用户设置（autoRestart/autoOpen 等），否则每次重启都退回默认值
  if (explicit && explicit.settings && typeof explicit.settings === 'object') {
    Object.assign(state.settings, explicit.settings)
  }
  applyEnvironment(currentEnvId)
}

function currentEnvObj() {
  return ENVIRONMENTS.find((e) => e.id === currentEnvId) || ENVIRONMENTS[0] || defaultEnvironment()
}

function terminalStorePath() { return path.join(app.getPath('userData'), 'terminals.json') }

function migrateEnvironmentsToRegistry() {
  terminalRegistry = new TerminalRegistry(terminalStorePath())
  terminalRegistry.load()
  if (!terminalRegistry.list().length) {
    for (const env of ENVIRONMENTS) {
      try {
        terminalRegistry.add({
          id: env.id,
          name: env.name,
          port: env.port,
          dshDir: env.dshDir || (env.manual ? '' : CONFIG.dshDir),
          dshHome: env.dshHome || resolveHome(''),
          profileName: env.profileName || 'web',
          sourceType: env.manual ? 'manual' : 'scanned',
        })
      } catch (err) {
        addLog(`迁移终端「${env.name}」失败：${friendlyError(err)}`, 'warn')
      }
    }
  }
  if (terminalRegistry.get(currentEnvId)) terminalRegistry.select(currentEnvId)
  else if (terminalRegistry.selectedTerminalId) currentEnvId = terminalRegistry.selectedTerminalId
}

function supervisorStatusForUi(runtime) {
  return {
    running: runtime.state === 'running' || runtime.state === 'attached-running',
    pids: runtime.pid ? [runtime.pid] : [],
    childPid: runtime.pid || null,
    starting: ['starting', 'waiting-port', 'checking-http'].includes(runtime.state),
    stopping: runtime.state === 'stopping',
    state: runtime.state,
    ownership: runtime.ownership,
    httpHealthy: runtime.httpHealthy,
    harnessConfirmed: runtime.harnessConfirmed,
    lastCheckedAt: runtime.lastCheckedAt,
    activeMs: runtime.activeMs || 0,
    activeSince: runtime.activeSince || 0,
    uptimeMs: (runtime.activeMs || 0) + (runtime.activeSince ? Date.now() - runtime.activeSince : 0),
  }
}

function terminalRescueStatus(terminalId) {
  return rescue.rescueStatus(rescue.rescueDirFor(app.getPath('userData'), terminalId))
}

function emitTerminalSnapshot() {
  if (!state.win || state.win.isDestroyed() || !terminalRegistry || !terminalSupervisor) return
  const selectedId = terminalRegistry.selectedTerminalId
  state.win.webContents.send('terminals:status', {
    selectedTerminalId: selectedId,
    paths: selectedId ? terminalPaths(selectedId) : null,
    terminals: terminalRegistry.list().map(terminal => ({ ...terminal, rescue: terminalRescueStatus(terminal.id), runtime: terminalSupervisor.publicRuntime(terminal.id) })),
  })
}

// 安装/引擎进度事件（推送到渲染进程实时可见）
function emitInstallProgress(payload) {
  if (state.win && !state.win.isDestroyed()) {
    state.win.webContents.send('install:progress', payload)
  }
}

function loadTerminalLogHistory(terminalId) {
  if (!terminalSupervisor || !terminalRegistry || !terminalRegistry.get(terminalId)) return
  const file = path.join(app.getPath('userData'), 'logs', terminalId, 'launcher.log')
  const runtime = terminalSupervisor.get(terminalId)
  try {
    if (!fs.existsSync(file)) return
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-3000)
    runtime.logs.length = 0
    for (const line of lines) {
      const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\] \[(\w+)\] (.*)$/)
      if (m) runtime.logs.push({ time: m[1], level: m[2], text: m[3], kind: '' })
    }
  } catch { /* 历史日志损坏不阻止终端启动 */ }
}

function initializeTerminalSupervisor() {
  migrateEnvironmentsToRegistry()
  pruneOldLogs()
  // 修正旧版接入记录：外部接入（manual/scanned/attached/filesystem）的 dshHome 应为 DSH 真实 home。
  // 旧版本误存为启动器独立目录，导致 Profile/引擎/会话检测全部落在错误位置。
  //  - 源码形态：真实 home = ~/.dsh
  //  - npm 包形态（启动器一键安装，目录自身就是 home，profiles 在其下）：真实 home = 目录自身
  try {
    const managedPrefix = path.join(app.getPath('userData'), 'terminals').toLowerCase()
    for (const terminal of terminalRegistry.list()) {
      const st = String(terminal.sourceType || '')
      if (st !== 'manual' && st !== 'scanned' && st !== 'attached' && st !== 'filesystem') continue
      const inspected = inspectDshDir(normalizeNpmRoot(terminal.dshDir))
      const real = inspected && inspected.mode === 'npm' ? inspected.dir : resolveHome('')
      const realIsNpx = inspected && (inspected.mode === 'npx' || inspected.mode === 'npm-standalone')
      const old = String(terminal.dshHome || '')
      if (old && old !== real && (old.toLowerCase().startsWith(managedPrefix) || realIsNpx)) {
        terminalRegistry.update(terminal.id, { dshHome: real })
        pushLog('info', `已修正终端「${terminal.name}」的 DSH_HOME → ${real}`)
      }
    }
  } catch { /* 迁移失败不阻断 */ }
  terminalSupervisor = new TerminalSupervisor({
    registry: terminalRegistry,
    intervalMs: 2000,
    // 重启后识别「自己 detach 出去的终端」：用 netstat 查监听端口真实 PID，匹配登记的 managedPid。
    resolvePortPid: async (port) => { const pids = await listPortPids(port); return pids[0] || null },
    // ★ 1.3.1：按进程 cmdline 识别 DSH（HTTP 标记识别不到时兜底，见 terminal-supervisor check）
    identifyHarness: identifyHarnessPid,
  })
  for (const terminal of terminalRegistry.list()) loadTerminalLogHistory(terminal.id)
  for (const terminal of terminalRegistry.list()) {
    if (terminal.activeMs) terminalSupervisor.restoreActiveMs(terminal.id, terminal.activeMs)
  }
  const loggedStates = new Map()
  const rescueBackedUp = new Set() // 已自动备份救援点的终端，避免重复
  terminalSupervisor.on('status', ({ terminalId, runtime }) => {
    // attached 终端正常运行中：若还没有救援点，自动备份当前 profile 为救援点（正常状态 = 好点）。
    // 覆盖"启动器重启后已接入的 attached 终端"场景——接入时的自动备份只在首次接入发生。
    if (runtime && runtime.state === 'attached-running' && runtime.ownership === 'attached' && !rescueBackedUp.has(terminalId)) {
      rescueBackedUp.add(terminalId)
      try {
        const rescueDir = rescue.rescueDirFor(app.getPath('userData'), terminalId)
        if (!rescue.rescueStatus(rescueDir).exists) {
          // ★ 1.0.13：快照前校验——profile 的官方 bundle 若未实装(坏状态),把坏状态当"好点"
          //   会让还原救援点救不回;此时跳过快照,留待正常状态再备份。
          const pPaths = terminalPaths(terminalId)
          const baseOk = fs.existsSync(path.join(pPaths.profileDir, 'node_modules', '@deepseek-ai', 'dsh-base'))
          const webOk = fs.existsSync(path.join(pPaths.profileDir, 'node_modules', '@deepseek-ai', 'dsh-web-app'))
          if (baseOk && webOk) {
            rescue.markCrashRecovered(rescueDir)
            const rescuePoint = rescue.createRescueSnapshot(pPaths.profileDir, rescueDir)
            if (rescuePoint.ok) pushTerminalLog(terminalId, 'info', '已自动创建救援点（当前为正常状态）')
          }
        }
      } catch { /* 快照失败不阻断监控 */ }
    }
    // 监控状态只在发生变化时写一条，避免每 2 秒刷屏；每个 terminalId 写自己的日志。
    if (loggedStates.get(terminalId) !== runtime.state) {
      loggedStates.set(terminalId, runtime.state)
      const terminal = terminalRegistry.get(terminalId)
      const port = terminal ? terminal.port : '?'
      const ownership = runtime.ownership === 'attached' ? '外部接入' : '启动器管理'
      const messages = {
        checking: `开始检查终端 :${port}（${ownership}）`,
        'attached-running': `检测到外部 Harness 正在运行：:${port}（attached-running）`,
        running: `检测到终端正在运行：:${port}`,
        stopped: `终端当前未运行：:${port}`,
        unconfigured: `终端尚未配置 DSH：:${port}`,
        'port-conflict': `端口冲突：:${port} 由非 Harness 服务占用`,
        degraded: `终端状态异常或进程已退出：:${port}`,
        failed: `终端启动失败：:${port}`,
        'waiting-port': `正在等待端口就绪：:${port}`,
        'checking-http': `端口已监听，正在确认 Harness HTTP：:${port}`,
        stopping: `终端正在停止：:${port}`,
      }
      pushTerminalLog(terminalId, ['failed', 'port-conflict', 'degraded'].includes(runtime.state) ? 'error' : 'info', messages[runtime.state] || `状态变为 ${runtime.state}：:${port}`)
    }
    if (terminalId === terminalRegistry.selectedTerminalId) {
      state.status = supervisorStatusForUi(runtime)
      emitStatus()
    }
    emitTerminalSnapshot()
  })
  terminalSupervisor.monitorAll()
}

loadConfig()

function emitStatus() {
  if (state.win && !state.win.isDestroyed()) {
    state.win.webContents.send('status:changed', { ...state.status })
  }
}

function emitSettings() {
  if (state.win && !state.win.isDestroyed()) {
    state.win.webContents.send('settings:changed', { ...state.settings })
  }
}

// ---------------------------------------------------------------------------
// 环境与路径
// ---------------------------------------------------------------------------

function envPaths(env) {
  const e = env || currentEnvObj()
  const home = resolveHome(e.dshHome)
  const dshDir = e.dshDir && e.dshDir.trim() ? e.dshDir.trim() : (CONFIG.dshDir || '')
  const profileDir = path.join(home, 'profiles', e.profileName || 'web')
  const port = e.port || 3080
  return { home, dshDir, profileDir, port, webUrl: `http://127.0.0.1:${port}` }
}

function pathsForRender() {
  const p = envPaths()
  return {
    dshDir: p.dshDir,
    profileDir: p.profileDir,
    webUrl: p.webUrl,
    port: p.port,
  }
}

function terminalPaths(terminalId) {
  const terminal = terminalRegistry && terminalRegistry.get(terminalId)
  if (!terminal) throw new Error('终端不存在')
  const home = resolveHome(terminal.dshHome)
  return {
    terminal,
    home,
    dshDir: terminal.dshDir,
    profileDir: path.join(home, 'profiles', terminal.profileName || 'web'),
    port: terminal.port,
    webUrl: `http://127.0.0.1:${terminal.port}`,
  }
}

// 每个终端独立的「做过什么事」总结记录（时间线），存 userData/activity/<terminalId>.jsonl
function recordActivity(terminalId, summary, detail = '') {
  try {
    terminalActivity.appendActivity(app.getPath('userData'), terminalId, { summary, detail })
  } catch { /* 活动记录失败不阻断主流程 */ }
}

// ---- 实时会话活动流：定时用系统 node（有 zstd）增量解压运行中终端的会话新帧，推送到控制台 ----
// 一轮一轮模型（每次启动终端 = 新一轮，上一轮抛弃，只记本轮）：
//  sessionTailState: `${home}|${sid}` -> { seq, size, mtime }
//    - seq   = 该会话已见最大事件序号（只推送 seq 更大的事件）
//    - size/mtime = 会话文件大小/修改时间（文件没变 → 整轮跳过，不解压不传输）
//  sessionRoundAt: home -> 启动时刻（ms）。新一轮基线：启动时刻之前的历史事件吞掉，
//    启动时刻之后的新事件实时推送（即使 DSH 重启后继续写同一个会话文件）。
const sessionTailState = new Map()
const sessionRoundAt = new Map() // home -> round start ms
// 对话标题（DSH API 权威）：`${home}|${sid}` -> title。
// worker 增量模式只扫头部 100KB + 新帧，重命名事件在文件中部时抓不到；
// DSH 自己的 session.list API 永远返回最新标题（重命名实时反映），用它覆盖。
const apiTitles = new Map()
let sessionTailPolling = false

function workerScriptPath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'scripts', name)
    : path.join(__dirname, 'scripts', name)
}

// 运行中的终端：用 DSH API 刷新对话标题（权威、实时，重命名立即生效）
function refreshApiTitles(terminal, home) {
  if (!terminal || !terminal.port || !home) return
  const rt = terminalSupervisor.get(terminal.id)
  if (!rt || !(rt.state === 'running' || rt.state === 'attached-running')) return
  fetchSessionList(terminal.port, 2500).then(list => {
    if (!list) return
    for (const item of list) {
      if (item.title) apiTitles.set(`${home}|${item.sid}`, String(item.title).trim())
    }
  }).catch(() => { /* API 失败静默（用 worker 标题兜底） */ })
}

function pollSessionActivity() {
  if (sessionTailPolling || !terminalRegistry || !terminalSupervisor) return
  // 只轮询运行中的终端（实时事件流）；对话筛选下拉已移除，不再为未启动终端建对话列表
  const running = terminalRegistry.list().filter(t => {
    const rt = terminalSupervisor.get(t.id)
    return rt.state === 'running' || rt.state === 'attached-running'
  })
  if (!running.length) return
  sessionTailPolling = true
  const nodeExe = findNodeExe()
  const worker = workerScriptPath('session-tail.cjs')
  const homes = running.map(t => resolveHome(t.dshHome))
  // 游标写入临时文件传给 worker（不走命令行参数，防止 PowerShell 对 JSON 引号做转义导致解析失败）
  const seenArg = {}
  let hasSeen = false
  for (const [sid, rec] of sessionTailState) {
    seenArg[sid] = { seq: rec.seq, size: rec.size, mtime: rec.mtime, offset: rec.offset || 0 }
    hasSeen = true
  }
  let seenFile = ''
  if (hasSeen) {
    try {
      seenFile = path.join(app.getPath('userData'), 'session-seen.json')
      fs.writeFileSync(seenFile, JSON.stringify(seenArg), 'utf8')
    } catch { seenFile = '' }
  }
  const workerArgs = seenFile ? [worker, `--seen-file=${seenFile}`, ...homes] : [worker, ...homes]
  // 根修弹窗：worker 也是控制台程序，用隐藏控制台启动（不再弹窗口）
  freshInstall.spawnWithHiddenConsole(nodeExe, workerArgs, { stdio: ['ignore', 'pipe', 'pipe'] }).then(({ child }) => {
    let out = ''
    let done = false
    let workerChild = null
    const finish = () => {
      if (done) return
      done = true
      sessionTailPolling = false
      // ★ 1.0.13：worker 卡死残留——超时退出后强杀进程,避免堆积(每轮泄漏一个)
      try { if (workerChild && workerChild.kill) workerChild.kill() } catch { /* 忽略 */ }
      try {
        const data = JSON.parse(out || '{}')
        for (let i = 0; i < running.length; i++) {
          const terminal = running[i]
          const home = homes[i]
          const perHome = data[home] || {}
          for (const [sid, info] of Object.entries(perHome)) {
            const key = `${home}|${sid}`
            // 会话文件被删除：清理游标
            if (info && info.deleted) {
              sessionTailState.delete(key)
              continue
            }
            const roundAt = sessionRoundAt.get(home) || 0
            const rec = sessionTailState.get(key) || { seq: 0, size: 0, mtime: 0 }
            // 文件变小 = 会话文件被重建（seq 可能重新计数），重置游标后按时间基线重新判断
            const fileShrunk = rec.size > 0 && info.fileSize > 0 && Number(info.fileSize) < rec.size
            if (fileShrunk) rec.seq = 0
            const isNewSession = !rec.seq && !rec.size
            if (Array.isArray(info.events)) {
              for (const ev of info.events) {
                if (!ev || !ev.summary) continue
                const evSeq = Number(ev.seq) || 0
                if (evSeq > rec.seq) rec.seq = evSeq
                // 基线规则：首次见到的会话只吞掉「启动时刻之前」的历史，启动之后的新事件照样推送。
                // 边界保护：最近 30 秒内的事件即使落在基线前也推送——用户刚说的话不能消失
                const evTime = Number(ev.time) || 0
                const show = isNewSession
                  ? ((roundAt > 0 && evTime >= roundAt - 5000) || evTime >= Date.now() - 30000)
                  : true
                if (show) {
                  // 日志带会话标题前缀（同一终端多个对话一眼区分）；
                  // 标题优先用 DSH API 的（重命名实时反映），worker 提取的作兜底；
                  // 用户消息用独立 kind（渲染端高亮，不被工具调用淹没）。
                  const apiTitle = apiTitles.get(key)
                  const convTitle = String(apiTitle || info.title || '').replace(/\s+/g, ' ').trim().slice(0, 14) || '新对话'
                  const evKind = ev.name === 'user-message' ? 'user' : 'session'
                  pushTerminalLog(terminal.id, 'info', `[${convTitle}] ${ev.summary}`, evKind, evKind === 'user' ? '用户消息' : '')
                }
              }
            }
            rec.size = Number(info.fileSize) || rec.size
            rec.mtime = Number(info.fileMtime) || rec.mtime
            rec.offset = Number(info.offset) || rec.offset || 0
            sessionTailState.set(key, rec)
          }
        }
        // 运行中的终端：用 DSH API 刷新对话标题（重命名实时生效）
        for (let i = 0; i < running.length; i++) refreshApiTitles(running[i], homes[i])
      } catch { /* 解析失败忽略 */ }
    }
    child.stdout.on('data', d => { out += d.toString() })
    child.stderr.on('data', () => { /* 忽略 */ })
    workerChild = child
    child.on('error', finish)
    child.on('exit', finish)
    child.on('close', finish)
    setTimeout(finish, 20000)
  }).catch(() => { sessionTailPolling = false })
}

// 终端操作审计：用户点过的按钮/设置/安装等，进实时日志（kind=op）与活动时间线。
// 与参考的多终端启动器一致：任何用户操作都要留痕。
function auditOp(terminalId, summary, detail = '') {
  pushTerminalLog(terminalId, 'info', `[操作] ${summary}`, 'op')
  recordActivity(terminalId, summary, detail)
}

function pushTerminalLog(terminalId, level, text, kind = '', conv = '') {
  const now = new Date()
  const two = value => String(value).padStart(2, '0')
  const entry = {
    time: `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`,
    timestamp: now.toISOString(),
    terminalId,
    level,
    text: String(text),
    kind: String(kind || ''),
    conv: String(conv || ''), // 对话标题：同一终端不同对话靠它区分/筛选
  }
  if (terminalSupervisor) terminalSupervisor.appendLog(terminalId, entry)
  try {
    const dir = path.join(app.getPath('userData'), 'logs', terminalId)
    fs.mkdirSync(dir, { recursive: true })
    const logFile = path.join(dir, 'launcher.log')
    fs.appendFileSync(logFile, `[${entry.timestamp}] [${level}] [${terminalId}] ${entry.text}\n`, 'utf8')
    trimLogFile(logFile)
  } catch { /* terminal logging must not stop lifecycle */ }
  if (terminalRegistry && terminalId === terminalRegistry.selectedTerminalId && state.win && !state.win.isDestroyed()) {
    state.win.webContents.send('log:entry', entry)
  }
  return entry
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

// 工具链执行器缓存：一次自举（node/pnpm/npm/git 全内部），后续所有 git/pnpm 调用复用同一 env。
// 白板原则：启动器所有外部工具调用都走自带工具链，机器预装什么都不依赖。
let toolchainEnvCache = null
let toolchainEnvCacheAt = 0

async function getToolchainEnv(terminalId, onProgress = null) {
  const now = Date.now()
  // 缓存 5 分钟：启动/更新/引擎安装高频调用时不重复自举（自举本身幂等且快，但少跑一次是一次）
  if (toolchainEnvCache && now - toolchainEnvCacheAt < 5 * 60 * 1000) return toolchainEnvCache
  const log = (stage, message) => {
    // ★ 1.4.0（I5）：支持 onProgress 透传——一键安装向导此前在自举阶段（可达数分钟）
    //   完全无进度，用户当卡死强关
    if (onProgress) { try { onProgress(stage, message) } catch { /* 进度失败不阻断 */ } }
    if (terminalId) pushTerminalLog(terminalId, 'info', `[${stage}] ${message}`)
  }
  const toolchain = await freshInstall.ensureUpdateToolchain({
    nodeExe: findNodeExe(),
    toolsDir: path.join(freshInstall.normalToolsDir(), 'zat-tools'),
    onProgress: log,
  })
  // ★ 完整缓存 env + pnpmExe（1.0.13 修复：旧实现只存 env，自举好的 pnpmExe 被丢弃，
  //   所有 toolchainEnv.pnpmExe 取值永远是 undefined → 回退 findPnpm 探测，链路脱节）
  //   nodeExe 一并缓存：无系统 Node 的机器由工具链自举的 node 接续 registry/版本探测。
  // ★ 1.4.0（U16）：关键项（node+pnpm）齐备才缓存 5 分钟；残缺工具链只缓存 30 秒，
  //   避免一次半失败的自举（TEMP 被清/网络抖动）污染后续 5 分钟内的所有调用
  toolchainEnvCache = { env: toolchain.env, pnpmExe: toolchain.pnpmExe || '', nodeExe: toolchain.nodeExe || '' }
  const healthy = !!toolchainEnvCache.nodeExe && !!toolchainEnvCache.pnpmExe
  toolchainEnvCacheAt = now - (healthy ? 0 : 4.5 * 60 * 1000)
  return toolchainEnvCache
}

// 共享工具链执行器：兼容两种调用签名，env 用内部工具链 PATH（git/pnpm/node/npm 全自带）。
//  - run 风格：(file, args, cwd, timeout)
//  - runWithProgress 风格：(description, file, args, cwd, onProgress, timeout, env)
// 所有调用外部 git/pnpm 的地方统一用这个，保证 100% 走内部工具。
// 实现抽到 src/toolchain-execute.js（可单测）：两种签名都归一化 pnpm 的
// { file, args } 对象形态（node <pnpm.cjs>），绝不 execFile .cmd（Node 24 EINVAL）。
function makeToolchainExecute(env) {
  return toolchainExec.makeToolchainExecute(env)
}

// Node 版本必须满足 DSH 要求（package.json engines: ^22.19.0 || >=24.0.0），不满足视为不可用
function nodeSatisfiesDsh(versionText) {
  const m = String(versionText || '').match(/v?(\d+)\.(\d+)\.(\d+)/)
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  if (major === 22) return minor >= 19
  if (major >= 24) return true
  return false
}

function findNodeExe() {
  const candidates = [
    process.env.DSH_NODE_EXE,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
    'node',
  ]
  // ★ 1.4.0（I10）：工具链自举位置纳入候选——无系统 Node 的机器上，一键安装先把 node
  //   自举到 %TEMP%\zat-tools，startTerminal 不该再对 userData/tools 重复下载一份
  try {
    const tools = freshInstall.normalToolsDir()
    candidates.push(path.join(tools, 'zat-tools', 'node.exe'))
  } catch { /* 忽略 */ }
  // 常见开发工具自带的 node（runtime 缓存目录），递归探测不硬编码个人路径。
  // 例：~/.cache/<tool-runtime>/dependencies/node/bin/node.exe
  const findUnderCache = (dir, depth) => {
    if (depth > 5) return null
    for (const sub of ['bin/node.exe', 'node/bin/node.exe', 'dependencies/node/bin/node.exe']) {
      const p = path.join(dir, sub)
      if (fs.existsSync(p)) return p
    }
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name === 'node_modules' || ent.name.startsWith('.')) continue
      const r = findUnderCache(path.join(dir, ent.name), depth + 1)
      if (r) return r
    }
    return null
  }
  try {
    const homeCache = path.join(os.homedir(), '.cache')
    if (fs.existsSync(homeCache)) {
      const cached = findUnderCache(homeCache, 0)
      if (cached) candidates.push(cached)
    }
  } catch { /* 缓存目录不可读则跳过 */ }
  for (const c of candidates) {
    if (!c) continue
    try {
      if (c === 'node') {
        // 只有真实能跑且版本满足 DSH 要求的 node 才算数（DSH engines: ^22.19.0 || >=24.0.0）
        const r = require('node:child_process').execFileSync('node', ['-v'], { stdio: 'pipe', timeout: 5000 })
        if (r && nodeSatisfiesDsh(String(r))) return 'node'
      } else if (fs.existsSync(c)) {
        try {
          const r = require('node:child_process').execFileSync(c, ['-v'], { stdio: 'pipe', timeout: 5000 })
          if (r && nodeSatisfiesDsh(String(r))) return c
        } catch { /* 版本校验失败，继续找下一个 */ }
      }
    } catch { /* 继续尝试 */ }
  }
  return '' // 没有可用的 node：如实返回空，由调用方给出明确提示
}

// 崩溃自动恢复阶梯执行器（1.0.6）：按级别执行对应恢复动作，返回 true = 本级完成可重启。
//   L1 对症修复：配置坏→还原救援点 / 依赖错配→重装依赖 / 插件冲突→排除
//   L2 完整恢复：还原救援点 + 强制重装全部官方依赖（配置与依赖一起回到好状态）
//   L3 工厂重置：备份现有配置 → 重建最小可用 profile（仅官方插件）→ 重装依赖
async function runAutoFixLevel(terminalId, p, issue, level) {
  const rescueDir = rescue.rescueDirFor(app.getPath('userData'), terminalId)
  const logStep = (msg) => pushTerminalLog(terminalId, 'info', `[自动恢复 L${level}] ${msg}`)
  try {
    // L1：对症修复（只处理诊断命中的方向）
    if (level === 1) {
      if (issue.type === 'bad-profile') {
        if (!rescue.rescueStatus(rescueDir).exists) { logStep('配置损坏但无救援点，本级跳过'); return false }
        const r = rescue.restoreRescueSnapshot(p.profileDir, rescueDir)
        if (r.ok) { logStep(`已还原救援点配置（${r.files.join('、')}）`); return true }
        logStep(`还原救援点失败：${r.message}`); return false
      }
      if (issue.type === 'source-deps') {
        // ★ 1.0.13：源码形态缺 devDependency（tsx）——装源码树依赖,不是 profile bundle
        logStep('安装源码依赖（pnpm install）…')
        const r = await installSourceDeps(terminalId, p)
        if (r.ok) { logStep('源码依赖已安装'); return true }
        logStep(`安装源码依赖失败：${r.message}`); return false
      }
      if (issue.type === 'bundle-mismatch') {
        logStep('重装 profile 官方依赖…')
        const r = await reinstallProfileBundles(terminalId, p)
        if (r.ok) { logStep('profile 依赖已重装（与主包版本匹配）'); return true }
        logStep(`重装失败：${r.message}`); return false
      }
      if ((issue.type === 'missing-bundle' || issue.type === 'plugin-failed' || issue.type === 'duplicate-plugin' || issue.type === 'missing-module') && issue.plugin) {
        const r = rescue.excludePlugin(p.profileDir, issue.plugin)
        if (r.ok) { logStep(`已排除插件「${issue.plugin}」（保留其它插件）`); return true }
        logStep(`排除插件「${issue.plugin}」失败：${r.message}`); return false
      }
      // 其它类型（cli-arg/tool-missing/未知）：重启本身即修复，本级视为完成
      return true
    }
    // L2：完整恢复 = 还原救援点（若有）+ 强制重装官方依赖
    if (level === 2) {
      let restored = false
      if (rescue.rescueStatus(rescueDir).exists) {
        const r = rescue.restoreRescueSnapshot(p.profileDir, rescueDir)
        restored = r.ok
        logStep(restored ? `已还原救援点配置（${(r.files || []).join('、')}）` : `还原救援点失败：${r.message}`)
      } else {
        logStep('无救援点，跳过还原配置')
      }
      // ★ 1.0.13：源码形态（apps/cli/src/bin.ts）的依赖在源码树,不是 profile bundle——
      //   必须装源码树依赖,否则 L2 重装 profile 官方依赖对源码缺 tsx 无效。
      const srcBin = path.join(p.dshDir, 'apps', 'cli', 'src', 'bin.ts')
      if (fs.existsSync(srcBin)) {
        logStep('源码形态：安装源码树依赖…')
        const sd = await installSourceDeps(terminalId, p)
        if (!sd.ok) { logStep(`源码依赖安装失败：${sd.message}`); return false }
        logStep('源码依赖已安装')
      }
      logStep('强制重装全部官方依赖…')
      const r = await reinstallProfileBundles(terminalId, p)
      if (r.ok) { logStep('官方依赖已重装'); return true }
      logStep(`重装失败：${r.message}`); return false
    }
    // L3：工厂重置 = 备份现有配置 → 重建最小可用 profile → 重装依赖
    if (level === 3) {
      const backupDir = path.join(app.getPath('userData'), 'rescue', 'factory-backups', terminalId, String(Date.now()))
      const r = rescue.factoryResetProfile(p.profileDir, backupDir)
      if (!r.ok) { logStep(`工厂重置失败：${r.message}`); return false }
      logStep(`已备份原配置到 ${backupDir}`)
      logStep('重装官方依赖…')
      const r2 = await reinstallProfileBundles(terminalId, p)
      if (r2.ok) { logStep('工厂重置完成（最小可用 profile）'); return true }
      logStep(`重装失败：${r2.message}`); return false
    }
    return false
  } catch (e) {
    pushTerminalLog(terminalId, 'warn', `[自动恢复 L${level}] 异常：${friendlyError(e)}`)
    return false
  }
}

// 重装 profile 官方 bundle（force 同步到与主包匹配的版本），复用更新链路主路径
async function reinstallProfileBundles(terminalId, p) {
  const tcEnv = await getToolchainEnv(terminalId)
  const updateExecute = makeToolchainExecute(tcEnv.env)
  // ★ 1.4.0（A6）：bundle 与主包强制同号（主包版本从已装 dshDir/package.json 读取）
  const mainVersion = (() => {
    try {
      const pkgFile = path.join(p.dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      const alt = path.join(p.dshDir, 'package.json')
      const raw = fs.existsSync(pkgFile) ? pkgFile : (fs.existsSync(alt) ? alt : '')
      return raw ? (JSON.parse(fs.readFileSync(raw, 'utf8')).version || '') : ''
    } catch { return '' }
  })()
  return freshInstall.installProfileBundles({
    nodeExe: tcEnv.nodeExe || findNodeExe(),
    profileDir: p.profileDir,
    toolsDir: path.join(freshInstall.normalToolsDir(), 'zat-tools'),
    onProgress: (stage, message) => pushTerminalLog(terminalId, 'info', `[${stage}] ${message}`),
    execute: updateExecute,
    force: true,
    version: mainVersion,
  })
}

// 源码形态装源码树依赖（pnpm install 到 dshDir）：与 rescue:install-source-deps 同一逻辑，
// 供自动恢复阶梯 L1（source-deps）与 L2/L3 复用。返回 { ok, message }。
async function installSourceDeps(terminalId, p) {
  const tcEnv = await getToolchainEnv(terminalId)
  const updateExecute = makeToolchainExecute(tcEnv.env)
  const pnpmExe = freshInstall.executablePnpm(tcEnv.pnpmExe || freshInstall.findPnpm(), tcEnv.nodeExe || findNodeExe())
  if (!pnpmExe) return { ok: false, message: '未找到 pnpm 且无法自举' }
  const r = await updateExecute('安装依赖', pnpmExe, ['install', '--registry', 'https://registry.npmmirror.com/', '--config.dangerously-allow-all-builds=true', '--config.package-import-method=copy'], p.dshDir, undefined, 20 * 60 * 1000)
  if (!r.ok) return { ok: false, message: String(r.err || r.out || '').slice(-300) }
  return { ok: true }
}

// 用 node 直接跑 harness 的 CLI（无需 pnpm）。
// 支持三种形态：npm 预构建包（node_modules/@deepseek-ai/dsh/lib/bin.js）、
// 源码树构建产物（apps/cli/lib/bin.js）、源码树源码模式（apps/cli/src/bin.ts + tsx）。
function dshCommand(dshDir, nodeExe) {
  const resolvedNode = nodeExe || findNodeExe()
  // npm 发行包形态：dshDir 本身就是包根，bin.js 位于 dshDir/lib/bin.js。
  const pkgBin = path.join(dshDir, 'lib', 'bin.js')
  if (fs.existsSync(pkgBin)) return { nodeExe: resolvedNode, cli: pkgBin, built: true }
  // 兼容旧布局：安装根 node_modules/@deepseek-ai/dsh/lib/bin.js
  const npmPkgCli = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (fs.existsSync(npmPkgCli)) return { nodeExe: resolvedNode, cli: npmPkgCli, built: true }
  const builtCli = path.join(dshDir, 'apps', 'cli', 'lib', 'bin.js')
  if (fs.existsSync(builtCli)) return { nodeExe: resolvedNode, cli: builtCli, built: true }
  // 源码模式（apps/cli/src/bin.ts + tsx）：需要 tsx 才能跑。检测依赖缺失：
  // 克隆源码后未 pnpm install 会报 "Cannot find package 'tsx'"（用户反馈）。
  // ★ 1.0.13：检测覆盖 pnpm 11 虚拟 store 布局（.pnpm/tsx@x/node_modules/tsx），
  //   旧逻辑只查 .pnpm/node_modules/tsx（pnpm 11 无此路径）可能误判已装为缺失。
  const srcCli = path.join(dshDir, 'apps', 'cli', 'src', 'bin.ts')
  let depsMissing = false
  if (fs.existsSync(srcCli)) {
    const hasTsx =
      fs.existsSync(path.join(dshDir, 'node_modules', 'tsx')) ||
      fs.existsSync(path.join(dshDir, 'node_modules', '.pnpm', 'node_modules', 'tsx')) ||
      // pnpm 11：.pnpm/tsx@<ver>/node_modules/tsx（扫描任意 tsx@* 目录）
      fs.existsSync(path.join(dshDir, 'node_modules', '.bin', 'tsx.cmd')) ||
      (() => {
        try {
          const pnpm = path.join(dshDir, 'node_modules', '.pnpm')
          if (!fs.existsSync(pnpm)) return false
          return fs.readdirSync(pnpm).some(n => n.startsWith('tsx@') && fs.existsSync(path.join(pnpm, n, 'node_modules', 'tsx')))
        } catch { return false }
      })()
    depsMissing = !hasTsx
  }
  return { nodeExe: resolvedNode, cli: srcCli, built: false, depsMissing }
}

function spawnDshArgs(args, dshDir, envObj, toolchainEnv, nodeExe) {
  const { nodeExe: cmdNode, cli, built } = dshCommand(dshDir, nodeExe)
  // 白板原则：DSH 进程环境 = 启动器自带工具链（node/pnpm/npm 目录注入 PATH），
  // 机器上预装什么都不依赖；DSH 内部所有 subprocess 调用都走启动器自带的。
  const childEnv = toolchainEnv && typeof toolchainEnv === 'object' ? { ...toolchainEnv } : { ...process.env }
  childEnv.DSH_HOME = envObj.dshHome && envObj.dshHome.trim() ? envObj.dshHome.trim() : ''
  // 与插件市场共享工具：把自举的 pnpm 位置通过 PNPM_MJS 注入 DSH 环境，
  // 市场探测到直接用启动器装好的 pnpm（不重复下载）。长路径 + .mjs（内置单文件形态）。
  try {
    const sharedPnpm = path.join(freshInstall.normalToolsDir(), 'zat-tools', 'pnpm.mjs')
    if (fs.existsSync(sharedPnpm)) childEnv.PNPM_MJS = sharedPnpm
  } catch { /* 注入失败不影响启动 */ }
  return {
    file: cmdNode,
    args: built ? [cli, ...args] : ['--import', 'tsx/esm', cli, ...args],
    cwd: dshDir,
    env: childEnv,
  }
}

function tcpPortInUse(port) {
  return probePort(port, '', 600)
}

function listPortPids(port) {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve([])
      resolve(parseNetstatListeningPids(stdout, port))
    })
  })
}

// ★ 1.3.1：按进程 cmdline 识别 DSH（HTTP 标记识别不到时的兜底）。
// 新版 DSH（0.1.2-alpha.1+）的 web 带 token 鉴权：根路径返回 401「dsh web authentication
// required」，HTTP 标记（deepseek/__dsh_boot__/harness）匹配不了 → 旧逻辑把在跑的 DSH
// 误判成"非 Harness 服务占用"（端口冲突刷屏 / 启动 90 秒超时失败）。
// 识别规则：监听进程 cmdline 含 bin.js ... web（源码/npm/全局形态）或 deepseek-harness。
const HARNESS_CMDLINE_RE = /(bin\.[jt]s[\s"']+web(?![\w-])|deepseek[-_]harness|@deepseek-ai[/\\]dsh)/i
// ★ 1.4.0（F08/F11）：identifyHarness 按 pid 做 30 秒 TTL 缓存——进程 cmdline 不变，
//   缓存消除 port-conflict 期间每 2 秒一轮的 powershell 拉起（CPU/能耗 churn）
const harnessPidCache = new Map() // pid -> { ok, at }
function identifyHarnessPid(pid) {
  return new Promise(resolve => {
    if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return resolve(false)
    const cached = harnessPidCache.get(Number(pid))
    if (cached && Date.now() - cached.at < 30000) return resolve(cached.ok)
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      const ok = !error && !!stdout && HARNESS_CMDLINE_RE.test(String(stdout))
      harnessPidCache.set(Number(pid), { ok, at: Date.now() })
      resolve(ok)
    })
  })
}

function killPid(pid) {
  return new Promise((resolve) => {
    if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return resolve(false)
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, error => resolve(!error))
  })
}

// 复制目录树（robocopy，可排除子目录；源保持只读不修改）
function copyDirTree(source, target, excludes = []) {
  return new Promise(resolve => {
    const args = [source, target, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/XD']
    for (const x of excludes) args.push(x)
    execFile('robocopy', args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 60 * 60 * 1000 }, (error) => {
      // robocopy 退出码 0-7 都算成功（8+ 才是错误）
      const code = error && error.code || 0
      resolve({ ok: code < 8 })
    })
  })
}

async function execDsh(args, opts = {}) {
  const p = envPaths()
  // 白板原则：内部 dsh CLI 调用同样注入自带工具链 PATH（node/pnpm/npm/git），不依赖机器预装。
  // ★ 1.0.13：toolchainEnvCache 现在 = { env, pnpmExe }，取 .env；未缓存时手动拼环境。
  let toolchainEnv = toolchainEnvCache ? toolchainEnvCache.env : null
  if (!toolchainEnv) {
    try {
      const nodeExe = findNodeExe()
      if (nodeExe) {
        const dirs = [path.dirname(nodeExe), path.join(freshInstall.normalToolsDir(), 'zat-tools')]
        toolchainEnv = { ...process.env, PATH: [...dirs, process.env.PATH || ''].filter(Boolean).join(';') }
      }
    } catch { /* 注入失败则用系统环境 */ }
  }
  const { file, args: fullArgs, cwd, env } = spawnDshArgs(args, p.dshDir, currentEnvObj(), toolchainEnv, (toolchainEnvCache && toolchainEnvCache.nodeExe) || undefined)
  const timeoutMs = opts.timeout || 120000
  // 根修弹窗：内部 dsh CLI 调用也用隐藏控制台启动（不再弹窗口）
  let child
  try {
    const hidden = await freshInstall.spawnWithHiddenConsole(file, fullArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child = hidden.child
  } catch {
    child = spawn(file, fullArgs, { cwd, env, windowsHide: true, shell: false })
  }
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, code, out, err })
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 忽略 */ }
      finish(-1)
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => {
      finish(-1)
      if (!err) err = String(e && e.message || e)
    })
    child.on('close', (code) => finish(code))
    child.on('exit', (code) => finish(code))
  })
}

async function execDshOk(args, opts) {
  const r = await execDsh(args, opts)
  if (!r.ok) {
    const msg = (r.err || r.out || '').trim()
    pushLog('error', `命令失败(${r.code}): ${msg || args.join(' ')}`)
  }
  return r
}

// ---------------------------------------------------------------------------
// 独立终端生命周期
// ---------------------------------------------------------------------------

// 打开网页统一入口：记录来源（autoOpen/手动/其他），用于排查"打开两个网页"
function openWebPage(url, source, terminalId) {
  try {
    addLog(`[网页] 打开 ${url}（来源：${source}${terminalId ? '，终端 ' + terminalId : ''}）`, 'info')
    console.log(`[网页] ${source} ${url}`)
    shell.openExternal(url)
    return true
  } catch (e) {
    addLog(`[网页] 打开失败 ${url}（${source}）：${String(e.message || e).slice(0, 120)}`, 'error')
    return false
  }
}

// ★ 1.3.1：DSH 启动时从 stdout 捕获「dsh web: http://127.0.0.1:<port>/?token=...」
// 新版 DSH（0.1.2-alpha.1+）web 需 token 鉴权——不带 token 打开会被 401 拒（页面提示
// "reopen the URL printed by dsh web"）。autoOpen / 「打开网页」按钮都用带 token 的地址。
const READY_URL_RE = /dsh web:\s*(https?:\/\/[^\s'\"）>，,]+)/i
const readyUrls = new Map() // terminalId -> 带 token 的完整 URL

async function startTerminal(terminalId, startOptions = {}) {
  if (!terminalRegistry || !terminalSupervisor || !terminalRegistry.get(terminalId)) return { ok: false, message: '终端不存在' }
  const p = terminalPaths(terminalId)
  const runtime = terminalSupervisor.get(terminalId)
  await terminalSupervisor.check(terminalId)
  if (runtime.state === 'running' || runtime.state === 'attached-running') return { ok: true, message: `终端已在运行（端口 ${p.port}）` }
  if (runtime.starting) return { ok: false, message: '该终端正在启动中' }
  if (runtime.portListening && !runtime.harnessConfirmed) return { ok: false, message: `端口 ${p.port} 已被其他程序占用` }
  if (!p.dshDir || !looksLikeDshDir(p.dshDir)) return { ok: false, message: `DSH 目录无效：${p.dshDir || '未设置'}` }
  // ★ 1.4.0（F01）：启动锁立即置位——此前 starting 在全部联网自举（可达数分钟）之后才置位，
  //   期间双击启动按钮/重复 IPC 会并发跑两个 startTerminal，spawn 双 DSH 抢同一端口与 profile
  runtime.starting = true

  // ===== 启动终端 = 重新开始记录（上一个启动周期的实时日志抛弃，UI 面板从本次启动开始） =====
  // ① 清空内存日志（UI 只显示本次启动之后的内容）
  runtime.logs.length = 0
  // ★ 1.4.0（F02）：startLogIndex 必须在清空【之后】捕获——旧代码在清空前捕获，
  //   崩溃时 slice(旧长度) 拿到空数组 → diagnoseCrash 永远空手 → L1-L3 自动恢复阶梯
  //   整体失效（启动器重启后历史预填 3000 条时必然如此）
  const startLogIndex = runtime.logs.length
  // 每次启动重新签发的 token：清掉旧的鉴权地址
  readyUrls.delete(terminalId)
  // ② 重置该终端的会话游标 + 记录启动时刻：只记本次启动之后发生的事
  const roundHome = resolveHome(p.terminal.dshHome)
  const roundAtNow = Date.now()
  sessionRoundAt.set(roundHome, roundAtNow)
  for (const key of [...sessionTailState.keys()]) {
    if (key.startsWith(roundHome + '|')) sessionTailState.delete(key)
  }
  // ③ 通知 UI 清空面板（磁盘 launcher.log 保留一周，按天可查）
  try { if (state.win && !state.win.isDestroyed()) state.win.webContents.send('logs:cleared', { terminalId }) } catch { /* 忽略 */ }
  recordActivity(terminalId, '启动 DSH（端口 ' + p.port + '）', p.webUrl)

  // 确保有可用的 Node.js：探测不到时自动下载便携版（官方 → 国内镜像），普通用户无需预装 Node。
  const nodeInfo = await freshInstall.ensureNodeExe({
    nodeExe: findNodeExe(),
    toolsDir: path.join(app.getPath('userData'), 'tools'),
    onProgress: (stage, message) => pushTerminalLog(terminalId, 'info', `[${stage}] ${message}`),
  })
  if (!nodeInfo.ok) return { ok: false, message: nodeInfo.message }
  const ensuredNode = nodeInfo.nodeExe

  // 启动前自动打"无窗口"补丁（从根上解决弹窗，覆盖任何形态的 DSH——一键安装/手动接入/源码版）：
  // ① DSH 的 subprocess-local（child_process.spawn 加 windowsHide，杜绝 curl/git/powershell 弹窗）
  // ② zat-dsh-engine 的 spawnShell（powershell 加 -WindowStyle Hidden）
  try {
    freshInstall.patchDshSubprocessNoWindow(p.dshDir)
    const engineDir = path.join(p.profileDir, 'node_modules', 'zat-dsh-engine')
    if (fs.existsSync(path.join(engineDir, 'lib', 'index.js'))) engineManager.patchEngineNoWindow(engineDir)
  } catch { /* 补丁失败不阻断启动 */ }

  // 与插件市场共享工具：确保 %TEMP%\zat-tools 有 pnpm.cjs（市场探测位），启动器装的市场直接复用。
  // 有全局 pnpm.cjs 就复制一份过去；没有则自举到共享目录——无论哪种，zat-tools 里始终有。
  try {
    const sharedDir = path.join(freshInstall.normalToolsDir(), 'zat-tools')
    // 清理过期 .cmd 包装残留：仅当内容引用的 node/pnpm 已消失才删（1.4.0 起zat-tools\pnpm.cmd
    // 是刻意生成的构建 shim，供 DSH 构建脚本里的裸 `pnpm` 解析，不能无脑删）。
    // Node 24 无 shell 时 execFile(.cmd) 直接 EINVAL 的约束只作用于启动器自己的 execFile
    // （一律 node <cjs>，不受影响）；DSH 构建脚本经 cmd shell 解析 .cmd 是安全的。
    try {
      const staleShim = path.join(sharedDir, 'pnpm.cmd')
      const shimContent = fs.existsSync(staleShim) ? fs.readFileSync(staleShim, 'utf8') : ''
      const refs = [...shimContent.matchAll(/"([^"]+)"/g)].map(m => m[1])
      if (!shimContent || (refs.length && refs.some(p => !fs.existsSync(p)))) {
        fs.rmSync(staleShim, { force: true })
      }
    } catch { /* 忽略 */ }
    const sharedPnpm = path.join(sharedDir, 'pnpm.cjs')
    if (!fs.existsSync(sharedPnpm)) {
      fs.mkdirSync(sharedDir, { recursive: true })
      const existing = freshInstall.findPnpm()
      if (existing && String(existing).toLowerCase().endsWith('.cjs')) {
        try { fs.copyFileSync(existing, sharedPnpm) } catch { /* 复制失败继续走自举 */ }
      }
      if (!fs.existsSync(sharedPnpm)) {
        await freshInstall.ensurePnpm({
          nodeExe: ensuredNode,
          toolsDir: sharedDir,
          onProgress: (stage, message) => pushTerminalLog(terminalId, 'info', `[${stage}] ${message}`),
        })
      }
    }
  } catch { /* 共享 pnpm 准备失败不阻断启动 */ }

  // 启动前自动检测并补装固定插件商店 zat-dsh-engine：
  //  - 启动器自管终端（fresh-installed/fresh-empty/cloned）：缺包即自动下载 + 注入声明。
  //  - 外部终端（scanned/manual）：仅当已声明但包缺失时补装，绝不擅自改外部 profile 声明。
  const engineProfileDir = p.profileDir
  const managedTerminal = ['fresh-installed', 'fresh-empty', 'cloned'].includes(p.terminal && p.terminal.sourceType)
  const engineInfo = engineProfileDir && fs.existsSync(path.join(engineProfileDir, 'package.json'))
    ? engineManager.detectEngine(engineProfileDir)
    : { mounted: false, installedInNodeModules: false }
  if (managedTerminal || engineInfo.mounted) {
    if (!engineInfo.installedInNodeModules) {
      pushTerminalLog(terminalId, 'info', '检测到插件商店 zat-dsh-engine 未实装，自动下载注入…')
      const engineDir = path.join(engineProfileDir, 'node_modules', 'zat-dsh-engine')
      // 白板原则：引擎下载的 git 调用走内部工具链（系统无 git 也能装）
      let engineExecute = null
      try { engineExecute = makeToolchainExecute((await getToolchainEnv(terminalId)).env) } catch { /* 工具链失败则用系统 git 兜底 */ }
      const dl = await engineManager.downloadEngineTo(engineDir, (stage, message) => pushTerminalLog(terminalId, 'info', `[${stage}] ${message}`), engineExecute)
      if (!dl.ok) {
        pushTerminalLog(terminalId, 'error', `插件商店自动下载失败：${dl.message}`)
        return { ok: false, message: `插件商店自动下载失败：${dl.message}` }
      }
      try { fs.rmSync(path.join(engineDir, '.git'), { recursive: true, force: true }) } catch { /* 忽略 */ }
      engineManager.injectEngine(engineProfileDir)
      const verified = engineManager.verifyEngine(engineProfileDir)
      if (!verified.ok) {
        pushTerminalLog(terminalId, 'error', `插件商店自动安装校验失败：${verified.message || '包结构或依赖缺失'}`)
        return { ok: false, message: `插件商店自动安装校验失败：${verified.message || '包结构或依赖缺失'}` }
      }
      pushTerminalLog(terminalId, 'info', '插件商店已自动安装')
      emitTerminalSnapshot()
    }
  }

  runtime.starting = true
  runtime.stopping = false
  runtime.cancelRequested = false
  runtime.state = 'starting'
  terminalSupervisor.setTransition(terminalId, { state: 'starting', starting: true, stopping: false })
  pushTerminalLog(terminalId, 'info', `正在启动终端 ${p.port}…`)
  // 白板原则：启动 DSH 前确保自带工具链就绪（node/pnpm/npm/git 自举到 %TEMP%\zat-tools），
  // DSH 内部所有 subprocess 调用（git/pnpm/node/npm）都使用启动器自带的，不依赖机器预装。
  let toolchainEnv = null
  try {
    toolchainEnv = await getToolchainEnv(terminalId)
  } catch { /* 工具链自举失败不阻断启动（node 已就绪时 DSH 本身可跑） */ }
  // --no-open：DSH 的 web 命令启动时默认会自己打开默认浏览器（日志：opening the default browser），
  // 加上 launcher 的 autoOpen 就是两个网页。让 DSH 不开，由 launcher 统一控制（只开一个）。
  // 但 npm 预构建包（rc.7 等）的 web 命令不支持 --no-open，传了会 unknown option 启动即退
  // （0.6.21 用户：装好 D:\4 后启动失败 3 次）。启动前实际探测参数兼容性，不支持则省略。
  let noOpen = true
  try { noOpen = await cliProbe.cliNoOpenSupported(p.dshDir, (toolchainEnv && toolchainEnv.nodeExe) || findNodeExe(), { env: toolchainEnv && toolchainEnv.env || undefined }) } catch { noOpen = false }
  if (!noOpen) pushTerminalLog(terminalId, 'info', '当前 DSH 版本不支持 --no-open（已自动省略；浏览器由 DSH 或手动打开）')
  const webArgs = ['web', '--port', String(p.port)]
  if (noOpen) webArgs.splice(1, 0, '--no-open')
  // ★ 源码形态依赖自动检查（1.0.11）：克隆源码未 pnpm install 时缺 tsx → 启动即崩
  //   （"Cannot find package 'tsx'"，用户朋友报错）。启动前检测，缺依赖自动装，绝不裸启动。
  const cmdInfo = dshCommand(p.dshDir)
  if (!cmdInfo.built && cmdInfo.depsMissing) {
    pushTerminalLog(terminalId, 'warn', '检测到源码形态但依赖未安装（缺 tsx），自动安装依赖…')
    try {
      const fi = freshInstall
      // ★ 1.0.13：toolchainEnv 现在 = { env, pnpmExe }，用它自举好的 pnpmExe 和 env
      //    （旧实现 toolchainEnv.pnpmExe 永远 undefined + makeToolchainExecute(null→{}) PATH 全丢）
      const pnpmExe = fi.executablePnpm(toolchainEnv && toolchainEnv.pnpmExe || fi.findPnpm(), (toolchainEnv && toolchainEnv.nodeExe) || findNodeExe()) || null
      if (pnpmExe) {
        const setExec = makeToolchainExecute((toolchainEnv && toolchainEnv.env) || undefined)
        // ★ 1.0.13：与主包/bundle 一致，追加 --config.package-import-method=copy（终端独立拷贝）
        const r = await setExec('安装依赖', pnpmExe, ['install', '--registry', 'https://registry.npmmirror.com/', '--config.dangerously-allow-all-builds=true', '--config.package-import-method=copy'], p.dshDir, undefined, 20 * 60 * 1000)
        if (r.ok) {
          pushTerminalLog(terminalId, 'info', '源码依赖已安装完成，继续启动…')
        } else {
          pushTerminalLog(terminalId, 'error', `源码依赖安装失败：${String(r.err || r.out || '').slice(-300)}`)
          // 依赖没装上启动也是崩，明确报错并中止
          runtime.starting = false
          runtime.state = 'failed'
          terminalSupervisor.setTransition(terminalId, { state: 'failed', starting: false })
          return { ok: false, message: '源码形态依赖安装失败，无法启动（请检查网络后重试）' }
        }
      } else {
        pushTerminalLog(terminalId, 'error', '未找到 pnpm 且自举失败，无法安装源码依赖')
        runtime.starting = false
        runtime.state = 'failed'
        terminalSupervisor.setTransition(terminalId, { state: 'failed', starting: false })
        return { ok: false, message: '未找到 pnpm，无法安装源码形态依赖' }
      }
    } catch (e) {
      pushTerminalLog(terminalId, 'error', `源码依赖自动安装异常：${friendlyError(e)}`)
    }
  }
  // ★ 1.4.0（F04）：预备段（工具链自举/引擎下载可达数分钟）里用户点了停止 → 中止启动。
  //   旧代码无视取消继续 spawn，显式停止被静默吞掉，DSH 照常起来
  if (runtime.cancelRequested || runtime.stopping) {
    runtime.starting = false
    terminalSupervisor.setTransition(terminalId, { state: 'stopped', starting: false })
    return { ok: false, message: '启动已取消' }
  }
  const { file, args, cwd, env } = spawnDshArgs(webArgs, p.dshDir, p.terminal, toolchainEnv && toolchainEnv.env || undefined, (toolchainEnv && toolchainEnv.nodeExe) || undefined)
  // 根修弹窗：启动器无控制台 GUI 直接 spawn 控制台程序会让 Windows 给每个子进程开新可见窗口。
  // 用隐藏控制台启动 DSH（CREATE_NEW_CONSOLE + SW_HIDE），DSH 及其所有子进程继承同一隐藏控制台，
  // 与官方终端启动等效，弹窗从根上消失。失败时自动退回普通 spawn（保底可用）。
  let child
  try {
    const hidden = await freshInstall.spawnWithHiddenConsole(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child = hidden.child
    pushTerminalLog(terminalId, 'info', hidden.hiddenConsole ? '已用隐藏控制台启动（子进程不再弹窗）' : '（隐藏控制台不可用，退回普通启动）')
  } catch {
    child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true })
  }
  const generation = terminalSupervisor.setManagedProcess(terminalId, child)
  try { terminalRegistry.update(terminalId, { managedPid: child.pid }) } catch { /* 持久化 PID 失败不阻断启动 */ }
  pushTerminalLog(terminalId, 'info', `> ${path.basename(file)} ${args.join(' ')}`)

  const streamLines = (stream, level) => {
    let pending = ''
    stream.on('data', chunk => {
      pending += chunk.toString()
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() || ''
      for (const line of lines) {
        const text = line.trim()
        if (!text) continue
        // 捕获新版 DSH 的 token URL（web 鉴权；不带 token 打开会被 401 拒）
        const m = text.match(READY_URL_RE)
        if (m && !readyUrls.get(terminalId)) { readyUrls.set(terminalId, m[1]); pushTerminalLog(terminalId, 'info', `已记录鉴权地址：${m[1].slice(0, 80)}…`) }
        pushTerminalLog(terminalId, level, text)
      }
    })
    stream.on('end', () => { if (pending.trim()) pushTerminalLog(terminalId, level, pending.trim()) })
  }
  streamLines(child.stdout, 'info')
  streamLines(child.stderr, 'error')

  child.on('error', error => {
    const latest = terminalSupervisor.get(terminalId)
    if (latest.generation !== generation || latest.childProcess !== child) return
    pushTerminalLog(terminalId, 'error', `启动失败：${friendlyError(error)}`)
    latest.childProcess = null
    latest.pid = null
    latest.starting = false
    latest.state = 'failed'
    terminalSupervisor.setTransition(terminalId, { state: 'failed', starting: false })
  })
  child.on('exit', code => {
    const latest = terminalSupervisor.get(terminalId)
    if (latest.generation !== generation || latest.childProcess !== child) return
    const unexpected = !latest.stopping && !latest.cancelRequested
    pushTerminalLog(terminalId, 'info', `终端进程退出（code ${code}）`)
    if (unexpected) {
      const crashLines = latest.logs.slice(startLogIndex).map(entry => entry.text || '')
      // 启动失败自适应（双保险）：真实启动报 "unknown option '--no-open'" 时，
      // 探测缓存强制置为不支持，立即用不带 --no-open 的参数重启一次。
      // 探测方法再可靠也可能有版本差异，这条兜底保证最终一定能启动。
      const noOpenCrash = /unknown option ['"]--no-open['"]/i.test(crashLines.join('\n'))
      if (noOpenCrash) {
        cliProbe.forceNoOpenUnsupported(p.dshDir)
        pushTerminalLog(terminalId, 'info', '检测到 --no-open 参数不兼容，已自动修正并重新启动…')
        latest.childProcess = null
        latest.pid = null
        latest.starting = false
        latest.stopping = false
        terminalSupervisor.check(terminalId)
        startTerminal(terminalId, { autoOpen: false }).then(r => {
          if (r.ok) { const rt = terminalSupervisor.get(terminalId); rt.autoRestartCount = 0; rt.autoFixLevel = 0 }
        })
        return
      }
      const diagnosis = rescue.diagnoseCrash(crashLines)
      try {
        rescue.recordCrash(rescue.rescueDirFor(app.getPath('userData'), terminalId), {
          exitCode: code,
          profileDir: p.profileDir,
          dshDir: p.dshDir,
          issues: diagnosis.issues,
          logTail: crashLines.slice(-100),
        })
        recordActivity(terminalId, `DSH 崩溃（code ${code}）`, diagnosis.issues.map(i => i.message).join('；'))
      } catch { /* 事故记录失败不阻断生命周期 */ }
      // 自动恢复阶梯（1.0.6）：小白玩崩后无感自动回到能用状态。
      // 确定性崩溃（配置损坏 / 依赖错配 / 插件冲突）盲目重启多少次都一样崩，
      // 诊断命中 → 逐级自动尝试（每级修完自动重启，成功即无感恢复）：
      //   L1 对症修复：配置坏→还原救援点 / 依赖错配→重装依赖 / 插件冲突→排除
      //   L2 完整恢复：还原救援点 + 强制重装全部官方依赖（配置与依赖一起回到好状态）
      //   L3 工厂重置：备份现有配置 → 重建最小可用 profile（仅官方插件）→ 重装依赖
      // 阶梯全部耗尽仍崩 → 停止自动重启，明确提示（此时多为环境问题，非小白可修）。
      // 任何一级成功后自动刷新救援点并重置阶梯，下次崩溃重新从 L1 走。
      if (diagnosis.issues.length) {
        const issue = diagnosis.issues[0]
        const currentLevel = latest.autoFixLevel || 0
        if (currentLevel >= 3) {
          // 阶梯已耗尽仍崩：停止，交人工
          latest.autoRestartCount = 0
          latest.autoFixLevel = 0
          pushTerminalLog(terminalId, 'error', '自动恢复阶梯已全部尝试（对症修复 / 完整恢复 / 工厂重置），仍无法启动。已停止自动重启，请到「救援」查看详情，或检查网络 / 磁盘空间 / 杀毒软件')
          recordActivity(terminalId, 'DSH 自动恢复阶梯耗尽', '对症修复 / 完整恢复 / 工厂重置均未成功')
          latest.childProcess = null
          latest.pid = null
          latest.starting = false
          latest.stopping = false
          terminalSupervisor.check(terminalId)
          return
        }
        const tryLevel = (level) => {
          latest.autoFixLevel = level
          pushTerminalLog(terminalId, 'warn', `崩溃诊断：${issue.message}`)
          pushTerminalLog(terminalId, 'info', `自动恢复中（第 ${level}/3 级：${['对症修复', '完整恢复', '工厂重置'][level - 1]}），请稍候…`)
          runAutoFixLevel(terminalId, p, issue, level).then(fixOk => {
            latest.childProcess = null
            latest.pid = null
            latest.starting = false
            latest.stopping = false
            if (fixOk) {
              pushTerminalLog(terminalId, 'info', '自动恢复完成，正在重启 DSH…')
              startTerminal(terminalId, { autoOpen: false }).then(r => {
                if (r.ok) { const rt = terminalSupervisor.get(terminalId); rt.autoRestartCount = 0 }
              })
            } else if (level < 3) {
              pushTerminalLog(terminalId, 'warn', `本级恢复未能完成，继续尝试第 ${level + 1} 级…`)
              tryLevel(level + 1)
            } else {
              pushTerminalLog(terminalId, 'error', '自动恢复阶梯已全部尝试（对症修复 / 完整恢复 / 工厂重置），仍无法启动。已停止自动重启，请到「救援」查看详情，或检查网络 / 磁盘空间 / 杀毒软件')
              recordActivity(terminalId, 'DSH 自动恢复阶梯耗尽', '对症修复 / 完整恢复 / 工厂重置均未成功')
              terminalSupervisor.check(terminalId)
            }
          })
        }
        tryLevel(currentLevel + 1)
        return
      }
    }
    latest.childProcess = null
    latest.pid = null
    latest.starting = false
    latest.stopping = false
    // 崩溃自动重启：非主动停止 && 开启自动重启 && 有 DSH，2 秒后自动拉起（连续崩溃上限 3 次）
    if (unexpected && state.settings.autoRestart && p.dshDir) {
      const count = (latest.autoRestartCount || 0) + 1
      latest.autoRestartCount = count
      if (count <= 3) {
        pushTerminalLog(terminalId, 'warn', `终端异常退出，2 秒后自动重启（第 ${count}/3 次）…`)
        recordActivity(terminalId, `DSH 异常退出，自动重启（第 ${count}/3 次）`, `退出码 ${code}`)
        clearTimeout(latest.restartTimer)
        latest.restartTimer = setTimeout(() => {
          latest.restartTimer = null
          startTerminal(terminalId, { autoOpen: false }).then(r => { if (r.ok) { const rt = terminalSupervisor.get(terminalId); rt.autoRestartCount = 0 } })
        }, 2000)
      } else {
        pushTerminalLog(terminalId, 'error', '连续崩溃 3 次，已停止自动重启，请用「救援」排查崩溃原因')
      }
    } else {
      latest.autoRestartCount = 0
    }
    terminalSupervisor.check(terminalId)
  })

  const deadline = Date.now() + (CONFIG.startTimeoutMs || 90000)
  while (Date.now() < deadline) {
    if (runtime.cancelRequested || runtime.generation !== generation) {
      runtime.starting = false
      return { ok: false, message: '启动已取消' }
    }
    const status = await terminalSupervisor.check(terminalId)
    // 就绪必须同时满足：端口是 harness 且本次 spawn 的进程仍存活。
    // check 在 probeInFlight 时返回缓存状态，崩溃循环里可能误报 running——用 childProcess 存活做硬校验。
    if (status.running && status.harnessConfirmed && runtime.childProcess && runtime.childProcess.exitCode === null) {
      const readyUrl = readyUrls.get(terminalId) || p.webUrl
      pushTerminalLog(terminalId, 'info', `终端已就绪：${readyUrl}`)
      // 成功启动 = 新的好状态：重置自动恢复阶梯，下次崩溃重新从 L1 走；同时自动刷新救援点
      runtime.autoFixLevel = 0
      runtime.autoRestartCount = 0
      // DSH 成功启动 = 一个"好点"：自动更新本终端救援点（快照当前 profile，含所有好插件）。
      // 装坏插件导致启动失败时不会走到这里，救援点仍停在"装坏插件之前"的好状态。
      try {
        rescue.markCrashRecovered(rescue.rescueDirFor(app.getPath('userData'), terminalId))
        const rescuePoint = rescue.createRescueSnapshot(p.profileDir, rescue.rescueDirFor(app.getPath('userData'), terminalId))
        if (rescuePoint.ok) emitTerminalSnapshot()
      } catch { /* 快照失败不阻断就绪结果 */ }
      if (state.settings.autoOpen && startOptions.autoOpen !== false && noOpen) {
        // 只对「用户主动启动」自动开网页；崩溃自动重启等后台拉起不重复弹网页。
        // noOpen=false（DSH 不支持 --no-open）时 DSH 可能自己开浏览器，跳过 autoOpen 防双开。
        openWebPage(readyUrls.get(terminalId) || p.webUrl, 'autoOpen', terminalId)
      }
      recordActivity(terminalId, `启动 DSH（端口 ${p.port}）`, readyUrls.get(terminalId) || p.webUrl)
      return { ok: true, message: `终端已就绪：${p.webUrl}` }
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  runtime.starting = false
  terminalSupervisor.setTransition(terminalId, { state: 'failed', starting: false })
  recordActivity(terminalId, `启动失败：等待端口 ${p.port} 就绪超时`)
  return { ok: false, message: `等待端口 ${p.port} 就绪超时` }
}

async function stopTerminal(terminalId, options = {}) {
  if (!terminalRegistry || !terminalSupervisor || !terminalRegistry.get(terminalId)) return { ok: false, message: '终端不存在' }
  const p = terminalPaths(terminalId)
  const runtime = terminalSupervisor.get(terminalId)
  if (runtime.stopping) return { ok: false, message: '该终端正在停止中' }
  if (runtime.ownership === 'attached' && runtime.harnessConfirmed && options.confirmAttached !== true) {
    return { ok: false, requiresConfirmation: true, message: '这是外部启动的 Harness，必须明确确认后才能停止' }
  }
  // 端口已空闲 = 本就未运行：幂等返回成功，避免走进杀进程逻辑误报「未能完全停止」
  if (!(await tcpPortInUse(p.port))) {
    runtime.childProcess = null
    runtime.pid = null
    runtime.recognizedOwnPid = null
    runtime.state = 'stopped'
    terminalSupervisor.setTransition(terminalId, { state: 'stopped', stopping: false })
    return { ok: true, message: `终端 ${p.port} 已停止` }
  }
  runtime.cancelRequested = true
  runtime.stopping = true
  runtime.starting = false
  terminalSupervisor.setTransition(terminalId, { state: 'stopping', starting: false, stopping: true })
  pushTerminalLog(terminalId, 'info', `正在停止终端 ${p.port}…`)
  const ownedPid = runtime.childProcess && runtime.childProcess.pid
  let killSucceeded = true
  if (ownedPid) {
    killSucceeded = await killPid(ownedPid)
  } else {
    // 无 live 句柄（重启后经 managedPid 识别的自有进程，或外部接入）：
    // 杀前重新确认端口上仍是 Harness，再按监听端口 PID 杀，避免误杀无关进程。
    const verified = await terminalSupervisor.check(terminalId)
    if (!verified.harnessConfirmed) killSucceeded = false
    else {
      const pids = await listPortPids(p.port)
      killSucceeded = pids.length > 0
      for (const pid of pids) killSucceeded = await killPid(pid) && killSucceeded
    }
  }
  const deadline = Date.now() + 10000
  while (Date.now() < deadline && await tcpPortInUse(p.port)) await new Promise(resolve => setTimeout(resolve, 300))
  const stillListening = await tcpPortInUse(p.port)
  runtime.stopping = false
  if (!killSucceeded || stillListening) {
    runtime.state = 'degraded'
    terminalSupervisor.setTransition(terminalId, { state: 'degraded', stopping: false })
    pushTerminalLog(terminalId, 'error', `终端 ${p.port} 未能完全停止`)
    return { ok: false, message: `终端 ${p.port} 仍在运行或停止失败` }
  }
  runtime.childProcess = null
  runtime.pid = null
  runtime.state = 'stopped'
  terminalSupervisor.setTransition(terminalId, { state: 'stopped', stopping: false })
  const settledMs = terminalSupervisor.settleActive(terminalId)
  try { terminalRegistry.update(terminalId, { managedPid: null, activeMs: settledMs }) } catch { /* 持久化失败不阻断 */ }
  pushTerminalLog(terminalId, 'info', '终端已停止')
  recordActivity(terminalId, '停止 DSH（端口 ' + p.port + '）', `运行 ${formatActiveMs(settledMs)}`)
  return { ok: true, message: `终端 ${p.port} 已停止` }
}

// 毫秒 → 人类可读时长（天/时/分/秒）
function formatActiveMs(ms) {
  const n = Number(ms) || 0
  if (n <= 0) return ''
  const s = Math.floor(n / 1000)
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60
  if (d > 0) return `${d}天${h}小时`
  if (h > 0) return `${h}小时${m}分`
  if (m > 0) return `${m}分${sec}秒`
  return `${sec}秒`
}

// ---------------------------------------------------------------------------
// 环境检测 / 修复
// ---------------------------------------------------------------------------

// 环境检测：作用域 = 当前选中的终端（不再是全局 CONFIG），切换终端后显示对应内容
function envCheckItems() {
  const terminal = terminalRegistry && terminalRegistry.get(terminalRegistry.selectedTerminalId)
  const p = terminal ? terminalPaths(terminal.id) : envPaths()
  const runtime = terminal && terminalSupervisor ? terminalSupervisor.publicRuntime(terminal.id) : state.status
  const items = []
  // Node（findNodeExe 只返回真实可运行的 node；空 = 真找不到）
  const nodeExe = findNodeExe()
  if (nodeExe) {
    items.push({ status: 'ok', label: 'Node', detail: nodeExe === 'node' ? 'PATH 上的 node' : nodeExe })
  } else {
    items.push({ status: 'error', label: 'Node', detail: '未找到可用的 node（需安装 Node.js 或提供缓存目录）' })
  }
  // pnpm（此处用 node 直跑，等价满足）
  items.push({ status: 'ok', label: 'pnpm', detail: '启动器使用 node 直跑 dsh CLI，无需 pnpm' })
  // DSH 目录（当前终端自己的，独立显示）
  if (p.dshDir && fs.existsSync(p.dshDir)) {
    items.push({ status: 'ok', label: 'DSH 目录', detail: p.dshDir })
  } else {
    items.push({ status: 'error', label: 'DSH 目录', detail: p.dshDir ? `不存在：${p.dshDir}` : '未配置（新终端尚未接入源码）' })
  }
  // profile（当前终端自己的）
  if (fs.existsSync(path.join(p.profileDir, 'package.json'))) {
    items.push({ status: 'ok', label: 'Profile', detail: p.profileDir })
  } else {
    items.push({ status: 'warn', label: 'Profile', detail: `尚未初始化：${p.profileDir}` })
  }
  // 端口（当前终端自己的运行状态）
  const running = !!(runtime && (runtime.running || runtime.state === 'attached-running'))
  items.push({ status: running ? 'ok' : 'warn', label: `端口 ${p.port}`, detail: running ? '已监听（DSH 在运行）' : '空闲（未运行）' })
  return items
}

async function repairEnv() {
  const items = envCheckItems()
  const terminal = terminalRegistry && terminalRegistry.get(terminalRegistry.selectedTerminalId)
  const p = terminal ? terminalPaths(terminal.id) : envPaths()
  const problems = items.filter((i) => i.status === 'error')
  if (problems.length === 0) {
    return { ok: true, message: '环境正常，无需修复', items }
  }
  const log = (m) => { try { pushTerminalLog(terminal ? terminal.id : '', 'info', m) } catch { /* 无终端时静默 */ } }
  let fixed = 0
  // 1) Node 缺失:自举(工具链 ensureNodeExe 会自动下载便携版)
  const nodeItem = items.find(i => i.label === 'Node' && i.status === 'error')
  if (nodeItem) {
    log('Node 缺失,正在自举 Node.js…')
    try {
      const info = await freshInstall.ensureNodeExe({ nodeExe: '', toolsDir: path.join(freshInstall.normalToolsDir(), 'zat-tools') })
      if (info.ok) { fixed++; log(`Node 已自举: ${info.nodeExe}`) }
    } catch (e) { log(`Node 自举失败: ${friendlyError(e)}`) }
  }
  // 2) DSH 目录不存在:提示用户在环境页选择(无法自动修复,但明确说明)
  const dshItem = items.find(i => i.label === 'DSH 目录' && i.status === 'error')
  if (dshItem) {
    log(`DSH 目录不存在(${p.dshDir || '未配置'}),请在「环境」页点「选择 DSH 目录」`)
  }
  // 3) Profile 未初始化(警告):创建基础 profile(bundle 声明)
  const profItem = items.find(i => i.label === 'Profile' && i.status === 'warn')
  if (profItem) {
    try {
      fs.mkdirSync(p.profileDir, { recursive: true })
      const pkgFile = path.join(p.profileDir, 'package.json')
      if (!fs.existsSync(pkgFile)) {
        fs.writeFileSync(pkgFile, JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2), 'utf8')
        fs.writeFileSync(path.join(p.profileDir, 'cordis.yml'), '[]\n', 'utf8')
        fs.writeFileSync(path.join(p.profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')
        fixed++
        log('Profile 已初始化(基础 bundle 声明)')
      }
    } catch (e) { log(`Profile 初始化失败: ${friendlyError(e)}`) }
  }
  return { ok: fixed > 0, message: fixed > 0 ? `环境已修复(${fixed} 项)` : '存在无法自动修复的问题,已在日志说明原因', items: envCheckItems() }
}

// ---------------------------------------------------------------------------
// 环境管理
// ---------------------------------------------------------------------------

function envList() {
  return { ok: true, environments: ENVIRONMENTS.map((e) => envPayload(e)), currentEnv: currentEnvId }
}

function environmentFromTerminal(terminal) {
  return {
    id: terminal.id,
    name: terminal.name,
    dshHome: terminal.dshHome,
    dshDir: terminal.dshDir,
    profileName: terminal.profileName || 'web',
    port: terminal.port,
    mirror: 'https://gh-proxy.com/',
    fallbackMirror: 'https://ghfast.top/',
    manual: terminal.sourceType !== 'scanned',
  }
}

function envSwitch(id) {
  const key = String(id || '')
  let env = ENVIRONMENTS.find((e) => e.id === key)
  // Registry is authoritative for terminal switching. Legacy ENVIRONMENTS may lag behind.
  const registered = terminalRegistry && terminalRegistry.get(key)
  if (!env && registered) {
    env = environmentFromTerminal(registered)
    ENVIRONMENTS.push(env)
  }
  if (!env || !registered) return { ok: false, message: '终端不存在' }
  const r = applyEnvironment(key)
  terminalRegistry.select(key)
  if (terminalSupervisor) {
    state.status = supervisorStatusForUi(terminalSupervisor.publicRuntime(key))
    terminalSupervisor.check(key)
    emitStatus()
    emitTerminalSnapshot()
  }
  return r
}

async function allocateTerminalPort(reservedPorts = []) {
  const reserved = new Set((reservedPorts || []).map(Number))
  for (let port = 3080; port <= 65535; port++) {
    if (reserved.has(port)) continue
    if (terminalRegistry && terminalRegistry.hasPort(port)) continue
    if (!await probePort(port, '', 350)) return port
  }
  throw new Error('没有可用端口')
}

// 扫描到但尚未接入的 Harness 端口；分配新端口时避开，防止抢走运行中实例的端口
async function scannedReservedPorts() {
  try {
    const scanned = await scanDshInstallations({})
    const registeredDirs = new Set((terminalRegistry ? terminalRegistry.list() : []).map(t => normalizeDshPath(normalizeNpmRoot(t.dshDir))))
    return scanned
      .filter(item => item.source === 'running-process' && item.port && !registeredDirs.has(normalizeDshPath(normalizeNpmRoot(item.dir))))
      .map(item => item.port)
  } catch { return [] }
}

async function connectDshDirectory(dshDirInput, sourceType = 'manual', options = {}) {
  // npm 包形态可能传入包根（旧版登记格式/手动选到包目录），统一归一化到项目根（DSH_HOME）
  let dshDir = normalizeNpmRoot(String(dshDirInput || '').trim())
  let inspected = inspectDshDir(dshDir)
  let explicitHome = ''
  // 用户选的不一定是根目录：先在自己的子目录里找（用户愿意安哪就安哪），
  // 再认 DSH_HOME（默认 ~/.dsh，官方 npx 方式根本没有项目根）。
  if (!inspected) {
    inspected = findDshRootNear(dshDir)
    if (inspected) dshDir = inspected.dir
  }
  if (!inspected && isDshHomeDir(dshDir)) {
    explicitHome = dshDir
    inspected = findDshPackageRoots().map(r => inspectDshDir(r)).find(Boolean) || null
    if (inspected) dshDir = inspected.dir
  }
  if (!inspected) return { ok: false, message: '所选目录不是有效的 DeepSeek Harness 根目录' }
  if (terminalRegistry) {
    const existing = findRegisteredByDshDir(inspected.dir, terminalRegistry.list())
    if (existing) return { ok: false, duplicate: true, terminalId: existing.id, message: `该 DSH 已接入：${existing.name} · :${existing.port}` }
  }
  // 复用同目录的空终端登记（用户先按加号选了目录 → 空终端，现在目录里有 DSH 转为接入），
  // 避免留下"fresh-empty 与已接入"两条同目录记录。
  const emptyTwin = terminalRegistry && terminalRegistry.list().find(t =>
    !t.dshDir && (t.sourceType === 'fresh-empty' || t.sourceType === 'fresh-installed-empty') &&
    normalizeDshPath(normalizeNpmRoot(t.dshHome || '')) === normalizeDshPath(explicitHome || inspected.dir))
  let port = null
  let runningPid = null
  // 一次全量扫描同时完成两件事：① 判断用户选的 DSH 是否正在运行（外部启动 → 直接接管其端口）；
  // ② 收集其他运行中实例的端口用于避让。避免两次扫描（首次进程探测较慢，合并后等待减半）。
  let scanned = []
  try { scanned = await scanDshInstallations({}) } catch { scanned = [] }
  let match = scanned.find(item =>
    item.source === 'running-process' &&
    normalizeDshPath(item.dir) === normalizeDshPath(inspected.dir) &&
    item.port)
  // 防误登记：进程探测偶发失败（超时）会把运行中的实例当成新终端分走端口（曾把 3080 误成 3081）。
  // 首次没匹配到运行实例时，立刻重试一次进程扫描再下结论。
  if (!match && !options.port) {
    try {
      const retried = await scanDshInstallations({ processEntries: await processEntries() })
      match = retried.find(item =>
        item.source === 'running-process' &&
        normalizeDshPath(item.dir) === normalizeDshPath(inspected.dir) &&
        item.port)
      if (match) scanned = retried
    } catch { /* 重试失败按原路径走 */ }
  }
  if (match) { port = match.port; runningPid = match.pid || null }
  if (emptyTwin) port = Number(emptyTwin.port) || port
  if (options.port) {
    port = Number(options.port)
    if (terminalRegistry && terminalRegistry.hasPort(port) && !(emptyTwin && port === Number(emptyTwin.port))) return { ok: false, message: `端口 ${port} 已被其他终端登记` }
  } else if (port === null) {
    const registeredDirs = new Set((terminalRegistry ? terminalRegistry.list() : []).map(t => normalizeDshPath(normalizeNpmRoot(t.dshDir))))
    const reservedPorts = scanned
      .filter(item => item.source === 'running-process' && item.port && !registeredDirs.has(normalizeDshPath(normalizeNpmRoot(item.dir))))
      .map(item => item.port)
    port = await allocateTerminalPort(reservedPorts)
  }
  const id = emptyTwin ? emptyTwin.id : `terminal-${crypto.randomUUID()}`
  // 外部接入（manual/attached/scanned/filesystem 都是接入已存在的 DSH）：
  //  - npm 包形态（node_modules/@deepseek-ai/dsh）：目录自身就是 DSH_HOME（profiles 在其下），
  //    必须指向它自己，否则 Profile/引擎/会话检测会全部落空（启动器自己一键装的 D:\2 就是这种）。
  //  - 源码形态：DSH_HOME 指向其真实 home（默认 ~/.dsh）。
  // launcher 独立 home 只用于自建终端。
  const inspectedMode = inspected.mode || 'source'
  const dshHome = explicitHome
    ? explicitHome
    : inspectedMode === 'npm'
    ? inspected.dir
    : (inspectedMode === 'npx' || inspectedMode === 'npm-standalone' || sourceType === 'manual' || sourceType === 'attached' || sourceType === 'scanned' || sourceType === 'filesystem')
      ? resolveHome('')
      : path.join(app.getPath('userData'), 'terminals', id, 'dsh-home')
  fs.mkdirSync(dshHome, { recursive: true })
  // 终端名 = 文件夹名，绝不带端口后缀
  const name = explicitHome ? (path.basename(explicitHome) || 'DSH') : inspected.name
  const env = { id, name, dshHome, dshDir: inspected.dir, profileName: 'web', port, mirror: 'https://gh-proxy.com/', fallbackMirror: 'https://ghfast.top/', manual: true }
  if (emptyTwin) {
    const idx = ENVIRONMENTS.findIndex(item => item.id === id)
    if (idx >= 0) ENVIRONMENTS[idx] = env; else ENVIRONMENTS.push(env)
  } else {
    ENVIRONMENTS.push(env)
  }
  // 空终端复用：更新已有登记（保留其 id/port/activeMs 历史）；否则新增登记
  const terminal = emptyTwin
    ? terminalRegistry.update(id, { name, port, dshHome, dshDir: inspected.dir, profileName: 'web', sourceType })
    : terminalRegistry.add({ id, name, port, dshHome, dshDir: inspected.dir, profileName: 'web', sourceType })
  terminalSupervisor.startMonitoring(id)
  currentEnvId = id
  terminalRegistry.select(id)
  applyEnvironment(id)
  saveUserConfig()
  const runtime = await terminalSupervisor.check(id)
  emitTerminalSnapshot()
  const attachedNow = runtime && runtime.state === 'attached-running' && runtime.ownership === 'attached'
  // 接入的是运行中的正常 DSH：自动备份当前 profile 作为救援点（正常状态 = 好点）。
  // 由启动器启动的终端在每次成功启动时自动更新救援点；attached 接入不经过启动流程，这里补上。
  if (attachedNow) {
    try {
      rescue.markCrashRecovered(rescue.rescueDirFor(app.getPath('userData'), id))
      const rescuePoint = rescue.createRescueSnapshot(terminalPaths(id).profileDir, rescue.rescueDirFor(app.getPath('userData'), id))
      if (rescuePoint.ok) emitTerminalSnapshot()
    } catch { /* 快照失败不阻断接入 */ }
  }
  return {
    ok: true,
    message: `已接入 ${name} · :${port}${attachedNow ? '（运行中实例已识别，立即进入 attached-running）' : '，等待用户启动'}`,
    terminal: { ...terminal, runtime },
    selectedTerminalId: id,
  }
}

function envAdd(input) {
  const str = String(input || '').trim()
  if (!str) return { ok: false, message: '请输入 DSH_HOME 路径' }
  const id = str.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[-.]+/, '') || `env-${Date.now()}`
  const home = path.resolve(str)
  const usedPorts = new Set(ENVIRONMENTS.map((e) => e.port))
  let port = 3080
  while (usedPorts.has(port)) port += 1
  const env = { id, name: id, dshHome: home, dshDir: '', profileName: 'web', port, mirror: 'https://gh-proxy.com/', fallbackMirror: 'https://ghfast.top/', manual: true }
  ENVIRONMENTS.push(env)
  if (terminalRegistry) {
    terminalRegistry.add({ id, name: id, port, dshHome: home, dshDir: '', profileName: 'web', sourceType: 'manual' })
    if (terminalSupervisor) terminalSupervisor.startMonitoring(id)
  }
  saveUserConfig()
  emitTerminalSnapshot()
  return { ok: true, message: `已添加环境 ${id}（端口 ${port}）`, environment: envPayload(env) }
}

// 删除单个路径（原生设计 = 删干净才返回）：Windows 句柄释放有延迟
// （pnpm 硬链接到全局 store、sharp 原生模块曾被 DSH 加载），
// 失败自动重试（间隔 5s，最多 12 次 ≈60s），每次尝试 fsp.rm + cmd rd 双管齐下。
// 快速真实删除（0.6.29 实测定稿）：DSH 目录 6.7 万文件，Windows 物理删除
// 串行 17s / 并行 unlink 15s——NTFS 极限。绝不 rename 糊弄：
// walk 收集 → 300 并发 unlink（进度回调）→ 占用文件重试 → 目录倒序删除。
// 返回 { ok, files, remain }；remain 为仍被占用的文件（调用方杀进程后再删）。
async function fastDelete(p, onProgress, concurrency = 300) {
  const files = []
  const dirs = []
  const walk = dir => {
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { dirs.push(full); walk(full) } else files.push(full)
    }
  }
  walk(p)
  const total = files.length
  let done = 0
  let i = 0
  let failed = []
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < files.length) {
      const f = files[i++]
      try { await fsp.unlink(f) } catch { failed.push(f) }
      done++
      if (onProgress && done % 5000 === 0) onProgress(done, total)
    }
  })
  await Promise.all(workers)
  // 被占用文件重试一轮
  if (failed.length) {
    const retry = [...failed]
    failed = []
    for (const f of retry) { try { await fsp.unlink(f) } catch { failed.push(f) } }
  }
  if (onProgress) onProgress(total, total)
  dirs.sort((a, b) => b.length - a.length)
  for (const d of dirs) { try { await fsp.rmdir(d) } catch { /* 目录残留交给外层 */ } }
  try { await fsp.rmdir(p) } catch { /* 同上 */ }
  return { ok: !fs.existsSync(p), files: total, remain: failed }
}

// 删除前清杀仍持有目标目录句柄的进程（DSH 停止后子进程可能短暂残留）。
// 用 PowerShell 一次枚举全部进程命令行（比逐进程读 PEB 快且全），匹配即杀进程树。
async function killProcessesUsing(roots) {
  try {
    const r = await new Promise(resolve => {
      const ps = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }'
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 6000 }, (error, stdout) => resolve({ ok: !error, out: String(stdout || '') }))
    })
    if (!r.ok) return
    for (const line of r.out.split(/\r?\n/)) {
      const idx = line.indexOf('|')
      if (idx <= 0) continue
      const pid = Number(line.slice(0, idx))
      const cmd = line.slice(idx + 1)
      if (!cmd) continue
      // ★ 1.4.0（F12）：子串匹配会误伤——root='...t1' 命中 '...t10'。改为「root 后必须跟
      //   路径分隔符/引号/行尾」的边界匹配，t1 不再命中 t10；前缀匹配保持宽容以保证删除可靠
      const hit = roots.some(root => {
        if (!root) return false
        const esc = String(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return new RegExp(`${esc}([\\\\/'"]|$)`, 'i').test(cmd)
      })
      if (hit) {
        try { await killPid(pid) } catch { /* 忽略 */ }
      }
    }
  } catch { /* 清杀失败不阻断删除 */ }
}

async function envRemove(id) {
  if (!terminalRegistry || !terminalSupervisor || !terminalRegistry.get(id)) return { ok: false, message: '终端不存在' }
  const terminal = terminalRegistry.get(id)
  const runtime = terminalSupervisor.publicRuntime(id)
  // 运行中/启动中：先停止再删除（删除 = 彻底清理：登记 + 进程 + 文件夹 + 日志）。
  // 不再有「至少保留一个终端」的限制——用户有权删光（每个终端都是独立环境）。
  if (runtime.running || runtime.starting || runtime.stopping) {
    const stopped = await stopTerminal(id, { confirmAttached: true })
    if (!stopped.ok && runtime.running) return { ok: false, message: `删除前停止终端失败：${stopped.message}` }
  }
  const others = terminalRegistry.list().filter(item => item.id !== id)
  const plan = planTerminalDeletion(terminal, others, app.getPath('userData'))
  if (plan.blocked) return { ok: false, message: '该终端路径与其他终端存在共享或父子关系，为保护其他终端未删除文件' }

  // 先删除登记，避免文件删除中途失败造成“文件已部分删除、终端仍登记”的半完成状态。
  terminalSupervisor.stopMonitoring(id)
  terminalRegistry.remove(id)
  ENVIRONMENTS = ENVIRONMENTS.filter((item) => item.id !== id)
  // ★ 1.4.0（F15）：清掉该终端的鉴权地址/会话游标等内存态，防泄漏
  readyUrls.delete(id)
  try {
    const key = `${resolveHome(terminal.dshHome)}|`
    for (const k of [...sessionTailState.keys()]) if (k.startsWith(key)) sessionTailState.delete(k)
  } catch { /* 清理失败不阻断 */ }

  // 删除文件（0.6.29 实测定稿：DSH 目录 6.7 万文件，Windows 物理删除 15-17 秒，
  // 这是 NTFS 极限。做法：真实并行删除 + 实时进度 + 删干净才提示成功——
  // 绝不 rename 糊弄、绝不假成功、绝不报错甩给用户。占用文件杀进程后重试直到删净。）
  sendDeletingState(id, true, '正在删除…')
  try {
    // 1) 清杀仍持有句柄的进程（只杀命令行含目标路径的，绝不碰其它终端/3080）
    await killProcessesUsing(plan.roots)
    await new Promise(r => setTimeout(r, 1200))
    // 2) 逐根真实删除：每根最多 4 轮（每轮杀进程+并行删除），删干净为止
    for (const value of plan.roots) {
      if (!fs.existsSync(value)) continue
      for (let round = 0; round < 4 && fs.existsSync(value); round++) {
        if (round > 0) {
          sendDeletingState(id, true, `仍有文件被占用，正在清理进程并重试（第 ${round}/3 轮）…`)
          await killProcessesUsing([value])
          await new Promise(r => setTimeout(r, 1500))
        }
        const r = await fastDelete(value, (done, total) => {
          sendDeletingState(id, true, `正在删除 ${value}（已删除 ${done}/${total} 个文件）…`)
        })
        if (!r.ok && r.remain && r.remain.length && round === 3) {
          // 4 轮后仍有占用文件：启动器兜底保证（内部队列），但绝不假报成功——
          // 提示真实状态并让用户知道可重启后自动清完
          enqueuePendingDeletes([value], id, terminal.name || id)
        }
      }
    }

    // 该终端在启动器 userData 下的全部数据：日志 / 救援点快照 / 更新前快照 / 活动记录，
    // 一起删干净——删除后重建同名端口终端绝不残留旧对话、旧日志、旧快照。
    for (const sub of ['logs', 'rescue', 'snapshots']) {
      try { await fsp.rm(path.join(app.getPath('userData'), sub, id), { recursive: true, force: true }) } catch { /* ignore */ }
    }
    try { await fsp.rm(terminalActivity.activityFileFor(app.getPath('userData'), id), { force: true }) } catch { /* ignore */ }
  } finally {
    sendDeletingState(id, false)
  }

  const next = terminalRegistry.list()[0]
  if (next) {
    currentEnvId = next.id
    terminalRegistry.select(next.id)
    applyEnvironment(next.id)
  }
  saveUserConfig()
  emitTerminalSnapshot()
  const remain = plan.roots.filter(v => fs.existsSync(v))
  const message = remain.length
    ? `终端已删除，但 ${remain.length} 个目录仍被系统进程占用（如杀毒软件扫描）。已安排后台持续清理，重启启动器后必清`
    : '已删除终端及其全部文件'
  return { ok: !remain.length, message, selectedTerminalId: next && next.id || '' }
}

// 删除进度通知：阶段消息实时推给界面（"正在删除…"），删除期间用户知道在干什么。
function sendDeletingState(terminalId, deleting, message) {
  try { state.win && state.win.webContents.send('terminal:deleting', { terminalId, deleting, message: message || '', at: Date.now() }) } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 静默清理队列：极端情况下（系统进程瞬时占用）5 秒内删不掉的残留，
// 绝不报错给用户——登记后启动器后台每 30 秒重试 + 下次启动补删，直到删干净。
// ---------------------------------------------------------------------------
function pendingDeletesFile() {
  return path.join(app.getPath('userData'), 'pending-deletes.json')
}
function readPendingDeletes() {
  try { return JSON.parse(fs.readFileSync(pendingDeletesFile(), 'utf8')) || [] } catch { return [] }
}
function writePendingDeletes(list) {
  try { fs.writeFileSync(pendingDeletesFile(), JSON.stringify(list.filter(Boolean), null, 2), 'utf8') } catch { /* 持久化失败不阻断 */ }
}
function enqueuePendingDeletes(roots, terminalId, terminalName) {
  const pending = readPendingDeletes()
  for (const value of roots) {
    if (fs.existsSync(value) && !pending.some(item => item.path === value)) {
      pending.push({ path: value, terminalId, terminalName, at: Date.now(), attempts: 0 })
    }
  }
  writePendingDeletes(pending)
  schedulePendingDeleteRetry()
}
let pendingDeleteTimer = null
function schedulePendingDeleteRetry() {
  if (pendingDeleteTimer) return
  pendingDeleteTimer = setInterval(() => { runPendingDeleteRound() }, 30000)
}
async function runPendingDeleteRound() {
  try {
    const list = readPendingDeletes()
    if (!list.length) { if (pendingDeleteTimer) { clearInterval(pendingDeleteTimer); pendingDeleteTimer = null }; return }
    const remain = []
    for (const item of list) {
      if (!fs.existsSync(item.path)) continue
      try { await killProcessesUsing([item.path]) } catch { /* 忽略 */ }
      await new Promise(r => setTimeout(r, 800))
      try { await fsp.rm(item.path, { recursive: true, force: true }) } catch { /* 交 cmd 兜底 */ }
      if (fs.existsSync(item.path)) {
        try { await new Promise(resolve => execFile('cmd.exe', ['/c', 'rd', '/s', '/q', `"${item.path}"`], { windowsHide: true, timeout: 30000 }, () => resolve())) } catch { /* 忽略 */ }
      }
      if (fs.existsSync(item.path)) remain.push({ ...item, attempts: (item.attempts || 0) + 1 })
    }
    writePendingDeletes(remain)
  } catch { /* 清理轮失败不影响其它功能 */ }
}
// 启动时补删一轮（进程最少、占用概率最低）
async function flushPendingDeletes() {
  try {
    if (!readPendingDeletes().length) return
    await runPendingDeleteRound()
  } catch { /* 补删失败不影响启动 */ }
}

// ---------------------------------------------------------------
// 一键全新安装：独立源码目录 + 独立 DSH_HOME + 注入 zat-dsh-engine
// 快路：git clone 官方/镜像（3 秒源探测切换）→ pnpm install（本机 store 缓存命中，秒级）→ 注入引擎
// ---------------------------------------------------------------

// 全新安装失败清理：只删启动器自己创建的安装产物，绝不动用户文件夹里的其他内容。
// （教训：之前失败时 fs.rmSync(root) 会递归删除用户选择的整个文件夹——若里面混有
// 用户自己的文件会被一并误删。）
// ★ 1.4.0（A3）：传入安装前目录快照 preExisting——安装前就存在的同名条目（用户自己的
// package.json/.npmrc/profiles/zat-* 等）一律跳过不删，彻底杜绝误删用户数据。
const INSTALL_ARTIFACTS = ['node_modules', '.tools', 'profiles', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', '.npmrc', 'pnpm-workspace.yaml', 'cordis.yml', 'zat-*']
function cleanInstallArtifacts(root, preExisting = null) {
  for (const rel of INSTALL_ARTIFACTS) {
    try {
      if (rel.includes('*')) {
        for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
          if (ent.name.startsWith('zat-') && !(preExisting && preExisting.has(ent.name))) fs.rmSync(path.join(root, ent.name), { recursive: true, force: true })
        }
      } else {
        if (preExisting && preExisting.has(rel)) continue // 安装前已存在 = 用户的东西，绝不删
        fs.rmSync(path.join(root, rel), { recursive: true, force: true })
      }
    } catch { /* ignore */ }
  }
}

async function installFreshTerminal(options = {}) {
  const onProgress = (stage, message) => emitInstallProgress({ kind: 'install', terminalId: '', stage, message, at: Date.now() })
  if (!terminalRegistry || !terminalSupervisor) return { ok: false, message: '终端系统未就绪' }
  const target = options.terminalId ? terminalRegistry.get(String(options.terminalId)) : null
  if (options.terminalId && !target) return { ok: false, message: '目标终端不存在' }
  if (target && target.dshDir) return { ok: false, message: '当前终端已经安装或接入 DSH' }
  const id = target ? target.id : `terminal-${crypto.randomUUID()}`
  let port
  if (target) {
    port = target.port
  } else {
    const reservedPorts = await scannedReservedPorts()
    try { port = await allocateTerminalPort(reservedPorts) } catch (err) { return { ok: false, message: friendlyError(err) } }
  }
  // 空终端：用户选择的文件夹就是 root/DSH_HOME；新建兜底才使用 userData/terminals/<id>。
  const root = target ? path.resolve(target.dshHome) : path.join(app.getPath('userData'), 'terminals', id)
  const dshDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh')
  const dshHome = root
  const profileDir = path.join(dshHome, 'profiles', 'web')
  const detectedNodeExe = findNodeExe()
  // ★ 1.4.0（A3）：记录安装前已存在的条目——失败清理只删【本次安装创建的】产物，
  //   用户原有的同名文件（自己的 package.json/.npmrc/profiles 等）绝不删（数据安全）
  const preExisting = new Set(fs.existsSync(root) ? fs.readdirSync(root) : [])
  // ★ 1.4.0（A3）：目录里已有 package.json 但没有 node_modules = 疑似用户自己的 Node 项目
  //   （一键安装会改写其 package.json/生成 lockfile；失败清理会误删）——直接拒绝，保护数据
  if (preExisting.has('package.json') && !preExisting.has('node_modules')) {
    return { ok: false, message: `所选目录已有 package.json（疑似你自己的项目），为保护数据不在此安装。请选择空文件夹或新建目录` }
  }
  // 白板原则：一键安装/部署全部使用启动器内置工具链（node/pnpm/npm/git 自举到 zat-tools），
  // 不依赖机器预装。先自举工具链，后续 installOfficialPackage / downloadEngineTo /
  // installProfileBundles 的 pnpm/npm/git 调用全部走内置工具。
  // ★ 1.4.0（I4/I5）：自举移入 try 且进度透传到向导——旧实现自举抛错=IPC reject（向导
  //   永远停在"准备开始…"无提示）；自举数分钟无进度被用户当卡死强关
  let installTcEnv
  try {
    installTcEnv = await getToolchainEnv('', onProgress)
  } catch (err) {
    return { ok: false, message: `工具链自举失败：${friendlyError(err)}` }
  }
  // 工具链自举返回的 nodeExe 优先：无系统 Node 的机器也用它做后续 registry/版本探测
  const nodeExe = installTcEnv.nodeExe || detectedNodeExe
  const installExecute = makeToolchainExecute(installTcEnv.env)
  onProgress('准备', `端口 ${port} 已安全分配，安装到独立目录 ${root}（与 3080 完全隔离）`)
  try {
    // ★ 主路径：下载官方预构建包（镜像优先/官方回退，自带前端 dist，即装即跑，零编译）
    // 显式传入工具链自举好的 pnpmExe：不依赖 installOfficialPackage 内部二次探测
    // （findPnpm 可能因缓存文件名/路径差异返回空，导致误走 npm 回退 —— 1.0.9 修复）。
    // toolsDir 统一为共享 %TEMP%\zat-tools（1.0.11）：绝不 per 终端自举工具，
    // 保证"第一个"和"第二个"安装走完全相同的共享工具链（避免 root/.tools 分支不一致）。
    const dl = await freshInstall.installOfficialPackage({
      nodeExe,
      toolsDir: path.join(freshInstall.normalToolsDir(), 'zat-tools'),
      targetDir: root,
      onProgress,
      execute: installExecute,
      pnpmExe: installTcEnv.pnpmExe || '',
    })
    if (!dl.ok) { cleanInstallArtifacts(root, preExisting); return { ok: false, message: dl.message } }
    if (!fs.existsSync(path.join(dshDir, 'lib', 'bin.js'))) {
      cleanInstallArtifacts(root, preExisting)
      return { ok: false, message: '安装完成但缺少 dsh 可执行入口，已清理' }
    }
    // 安装完成即打"无窗口"补丁（subprocess windowsHide），启动时也会再校验一次
    try { freshInstall.patchDshSubprocessNoWindow(root) } catch { /* 补丁失败不阻断安装 */ }
    // 2) 初始化独立 profile 并注入 zat-dsh-engine（bundle 声明指向官方包，profile 保持独立）
    fs.mkdirSync(profileDir, { recursive: true })
    const profilePkg = path.join(profileDir, 'package.json')
    if (!fs.existsSync(profilePkg)) {
      fs.writeFileSync(profilePkg, JSON.stringify({
        name: 'dsh-profile-web', private: true, dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'zat-dsh-engine'] } },
      }, null, 2), 'utf8')
      fs.writeFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')
    }
    fs.writeFileSync(path.join(profileDir, 'cordis.yml'), '[]\n', 'utf8')
    onProgress('引擎', '注入 zat-dsh-engine（bundle 声明）…')
    const injected = engineManager.injectEngine(profileDir)
    if (!injected.ok) return { ok: false, message: injected.message }
    // ★ 关键：bundle 声明之外，还必须真实下载引擎包到 profile 的 node_modules，
    // 否则 dsh-app-boot 的 resolveBundleDir 无法解析 zat-dsh-engine，启动时报
    // "cannot resolve profile bundle" 并超时。引擎仓库自带预构建 lib + cordis.patch.yml，零编译。
    onProgress('引擎', '下载 zat-dsh-engine（git 浅克隆，官方优先/镜像回退）…')
    const engineDir = path.join(profileDir, 'node_modules', 'zat-dsh-engine')
    const engine = await engineManager.downloadEngineTo(engineDir, onProgress, installExecute)
    if (!engine.ok) return { ok: false, message: `引擎下载失败：${engine.message}` }
    try { fs.rmSync(path.join(engineDir, '.git'), { recursive: true, force: true }) } catch { /* 忽略 */ }
    onProgress('引擎', '校验 zat-dsh-engine…')
    const verified = engineManager.verifyEngine(profileDir)
    if (!verified.ok) { engineManager.restoreEngine(profileDir); return { ok: false, message: `引擎注入验证失败（${verified.message || '包结构或依赖缺失'}），已回滚` } }
    // ★ profile 的官方 bundle 依赖（dsh-base/dsh-web-app）必须实装到 profile/node_modules，
    // 否则 dsh-app-boot 的 resolveBundleDir 无法解析 bundle，启动时报 "cannot resolve profile bundle"。
    onProgress('依赖', '安装 profile 官方 bundle（dsh-base / dsh-web-app）…')
    const bundlesOk = await freshInstall.installProfileBundles({
      nodeExe,
      profileDir,
      toolsDir: path.join(freshInstall.normalToolsDir(), 'zat-tools'),
      onProgress,
      execute: installExecute,
      // ★ 1.4.0（A6）：bundle 与主包强制同号——错位即 "Unknown file extension .css" 启动崩
      version: (() => { try { return JSON.parse(fs.readFileSync(path.join(dshDir, 'package.json'), 'utf8')).version || '' } catch { return '' } })(),
    })
    if (!bundlesOk.ok) {
      cleanInstallArtifacts(root, preExisting)
      return { ok: false, message: bundlesOk.message }
    }
    // 3) 填充当前空终端；只有没有目标空终端时才新增记录。
    fs.mkdirSync(dshHome, { recursive: true })
    const name = target ? target.name : (options.name || '新环境')
    let terminal
    if (target) {
      terminal = terminalRegistry.update(id, { dshHome, dshDir, sourceType: 'fresh-installed' })
      const env = ENVIRONMENTS.find(item => item.id === id)
      if (env) { env.dshHome = dshHome; env.dshDir = dshDir; env.manual = true }
    } else {
      const env = { id, name, dshHome, dshDir, profileName: 'web', port, mirror: 'https://gh-proxy.com/', fallbackMirror: 'https://ghfast.top/', manual: true }
      ENVIRONMENTS.push(env)
      terminal = terminalRegistry.add({ id, name, port, dshHome, dshDir, profileName: 'web', sourceType: 'fresh-installed' })
      terminalSupervisor.startMonitoring(id)
    }
    currentEnvId = id
    terminalRegistry.select(id)
    applyEnvironment(id)
    saveUserConfig()
    await terminalSupervisor.check(id)
    emitTerminalSnapshot()
    onProgress('完成', `全新安装完成：${name} · :${port}，zat-dsh-engine 已注入，正在自动启动…`)
    // 用户期望：安装完成 = 直接能用，不手动点启动（0.6.24）。
    // 启动走完整链路：--no-open 兼容性探测 + 隐藏控制台 + 端口就绪等待。
    // autoOpen:false = 启动后不自动开网页（用户手动打开，0.6.26 用户要求）。
    const start = await startTerminal(id, { autoOpen: false })
    return {
      ok: true,
      message: start.ok ? `全新安装完成并已启动：${name} · :${port}（可点「打开网页」访问）` : `全新安装完成，但自动启动失败：${start.message}（可在救援中一键检测修复）`,
      terminal: { ...terminal, runtime: terminalSupervisor.publicRuntime(id) },
      selectedTerminalId: id,
      startOk: start.ok,
    }
  } catch (err) {
    cleanInstallArtifacts(root, preExisting)
    return { ok: false, message: `全新安装失败，已清理半成品：${friendlyError(err)}` }
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function ok(payload, message) {
  return { ok: true, message: message || 'ok', ...payload }
}

function registerIpc() {
  ipcMain.handle('state:get', () => {
    return ok({
      version: APP_VERSION,
      settings: { ...state.settings },
      paths: pathsForRender(),
      status: { ...state.status },
      logs: terminalSupervisor && terminalRegistry && terminalRegistry.selectedTerminalId
        ? [...terminalSupervisor.get(terminalRegistry.selectedTerminalId).logs].slice(-300)
        : state.logs.slice(-300),
      environments: ENVIRONMENTS.map((e) => envPayload(e)),
      currentEnv: currentEnvId,
      terminalRegistry: terminalRegistry ? {
        selectedTerminalId: terminalRegistry.selectedTerminalId,
        terminals: terminalRegistry.list().map(terminal => ({ ...terminal, rescue: terminalRescueStatus(terminal.id), runtime: terminalSupervisor ? terminalSupervisor.publicRuntime(terminal.id) : null })),
      } : { selectedTerminalId: '', terminals: [] },
    })
  })

  ipcMain.handle('settings:set', (_e, patch) => {
    Object.assign(state.settings, patch || {})
    try {
      const p = configUserPath()
      fs.mkdirSync(path.dirname(p), { recursive: true })
      const cfg = readJsonFile(p, {})
      cfg.settings = { ...state.settings }
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
    } catch { /* 忽略 */ }
    emitSettings()
    const id = terminalRegistry ? terminalRegistry.selectedTerminalId : ''
    if (id) auditOp(id, `修改设置：${Object.keys(patch || {}).join('、') || '（空）'}`)
    return ok({}, '设置已保存')
  })

  ipcMain.handle('logs:clear', (_e, terminalId) => {
    const id = String(terminalId || '')
    if (!terminalRegistry || !terminalSupervisor || !terminalRegistry.get(id)) return { ok: false, message: '必须指定有效终端' }
    terminalSupervisor.get(id).logs.length = 0
    try {
      const file = path.join(app.getPath('userData'), 'logs', id, 'launcher.log')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, '', 'utf8')
    } catch (err) {
      return { ok: false, message: `内存日志已清空，但磁盘日志清理失败：${friendlyError(err)}` }
    }
    if (state.win && !state.win.isDestroyed()) state.win.webContents.send('logs:cleared', { terminalId: id })
    auditOp(id, '清空终端日志')
    return ok({}, '日志已清空')
  })

  const requireTerminalId = terminalId => {
    const id = String(terminalId || '')
    if (!id || !terminalRegistry || !terminalRegistry.get(id)) return ''
    return id
  }
  ipcMain.handle('dsh:start', (_e, terminalId) => {
    const id = requireTerminalId(terminalId)
    if (id) auditOp(id, '启动终端')
    return id ? startTerminal(id) : { ok: false, message: '必须指定有效终端' }
  })
  ipcMain.handle('dsh:stop', (_e, terminalId, options) => {
    const id = requireTerminalId(terminalId)
    if (id) auditOp(id, '停止终端')
    return id ? stopTerminal(id, options || {}) : { ok: false, message: '必须指定有效终端' }
  })
  ipcMain.handle('dsh:restart', async (_e, terminalId, options) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    auditOp(id, '重启终端')
    const stopped = await stopTerminal(id, options || {})
    if (!stopped.ok) return stopped
    return startTerminal(id)
  })
  ipcMain.handle('dsh:open-web', async (_e, terminalId) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    const p = terminalPaths(id)
    // ★ 1.3.1：新版 DSH 的 web 需 token 鉴权——优先打开启动时捕获的带 token 地址
    const url = readyUrls.get(id) || p.webUrl
    shell.openExternal(url)
    return ok({}, `已打开 ${url}`)
  })

  ipcMain.handle('harness:info', async (_e, terminalId) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    return harnessLocalInfo(terminalPaths(id).dshDir)
  })
  ipcMain.handle('harness:check-update', async (_e, terminalId) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    // ★ 1.0.13：git 形态更新检查必须走工具链 execute（自举 git），
    //   旧实现传 undefined → 默认 run（系统 git）→ 无系统 git 的机器检查永远失败。
    let execute = undefined
    let tcEnv = null
    try { tcEnv = await getToolchainEnv(id); execute = makeToolchainExecute(tcEnv.env) } catch { /* 工具链失败时用默认（系统 git 兜底） */ }
    return checkHarnessUpdate(terminalPaths(id).dshDir, execute, harnessUpdate.npmLatestProbe((tcEnv && tcEnv.nodeExe) || findNodeExe()))
  })
  ipcMain.handle('harness:install-update', async (_e, terminalId) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    // 不预设「必须停止」：运行中直接尝试更新（官方可能支持热更新，文件替换是否被占用跑了才知道）。
    // 若依赖替换因文件锁失败，installUpdate 会回滚并在错误信息里说明。
    const p = terminalPaths(id)
    const runtime = await terminalSupervisor.check(id)
    const wasRunning = runtime.state === 'running' || runtime.state === 'attached-running'
    if (runtime.state === 'starting' || runtime.state === 'stopping') return { ok: false, message: '终端正在启动/停止中，请稍后再试' }
    if (wasRunning) pushTerminalLog(id, 'info', '终端运行中：直接尝试安装更新（不停止终端）…')
    auditOp(id, '安装 Harness 更新', `dshDir=${p.dshDir}`)
    const snapshotDir = path.join(app.getPath('userData'), 'snapshots', id, `pre-update-${Date.now()}`)
    pushTerminalLog(id, 'info', '正在准备更新工具链（node/pnpm/npm/git 自动自举，无需预装）…')
    // 白板原则：更新/构建链路需要的 node/pnpm/npm/git 全部自动自举并注入 PATH
    // （DSH 依赖 postinstall 执行 `node`、build 脚本执行 `npm`/`pnpm`）。
    const tcEnv = await getToolchainEnv(id)
    const updateExecute = makeToolchainExecute(tcEnv.env)
    pushTerminalLog(id, 'info', '正在检查并安装 Harness 更新…')
    // ★ 用工具链已自举的 pnpmExe，绝不重新探测（findPnpm 可能因缓存路径差异返回空 →
    //   更新链路 pnpm 为空导致依赖安装失败。1.0.10 修复）。
    const pnpmExe = freshInstall.executablePnpm(tcEnv.pnpmExe || freshInstall.findPnpm(), tcEnv.nodeExe || findNodeExe()) || null
    const result = await installHarnessUpdate(p.dshDir, snapshotDir, updateExecute, {
      pnpmExe,
      probeLatest: harnessUpdate.npmLatestProbe(tcEnv.nodeExe || findNodeExe()),
      onStep: (msg) => pushTerminalLog(id, 'info', `[更新] ${msg}`),
      // ★ 1.4.0（U12）：回滚前先停终端——运行中的 DSH 持有 lib/node_modules 文件句柄，
      //   不停就回滚必然 EPERM/EBUSY，"绝不留半更新状态"的承诺在运行中场景才真正可达
      beforeRestore: async () => {
        if (wasRunning) {
          pushTerminalLog(id, 'warn', '回滚前先停止终端（运行中文件被锁，否则恢复必失败）…')
          await stopTerminal(id, { confirmAttached: true, silent: true })
        }
      },
      npmUpdater: async () => {
        // 更新主包（npm 包形态），成功后再强制同步 profile bundle 到 @next：
        // 主包升级后 bundle 不跟上的话，rc 错配导致启动崩溃（Unknown file extension .css）。
        const up = await freshInstall.updateNpmPackage({
          nodeExe: tcEnv.nodeExe || findNodeExe(),
          targetDir: p.home,
          toolsDir: path.join(freshInstall.normalToolsDir(), 'zat-tools'),
          pnpmExe: tcEnv.pnpmExe || '',
          onProgress: (stage, message) => pushTerminalLog(id, 'info', `[${stage}] ${message}`),
        })
        if (!up.ok) return up
        pushTerminalLog(id, 'info', '主包已更新，正在同步 profile 插件（dsh-base / dsh-web-app）…')
        const bundles = await freshInstall.installProfileBundles({
          nodeExe: tcEnv.nodeExe || findNodeExe(),
          profileDir: p.profileDir,
          toolsDir: path.join(freshInstall.normalToolsDir(), 'zat-tools'),
          onProgress: (stage, message) => pushTerminalLog(id, 'info', `[${stage}] ${message}`),
          execute: updateExecute,
          force: true,
          // ★ 1.4.0（A6）：bundle 与新主包强制同号
          version: up.version || '',
        })
        if (!bundles.ok) return { ok: false, message: `主包已更新，但 profile 插件同步失败：${bundles.message}` }
        return { ...up, message: `${up.message}；profile 插件已同步` }
      },
    })
    pushTerminalLog(id, result.ok ? 'info' : 'error', result.message)
    // 更新成功 → 自动重启生效：用户点完「安装更新」就完事，不用再手动启动。
    // 无论更新前是否在运行，新版本都要重启进程才加载（旧进程仍是旧代码）。
    if (result.ok) {
      pushTerminalLog(id, 'info', '更新完成，自动重启终端使新版本生效…')
      const stopped = await stopTerminal(id, { confirmAttached: true, silent: true })
      if (!stopped.ok && stopped.message) pushTerminalLog(id, 'warn', `停止旧进程：${stopped.message}`)
      const start = await startTerminal(id, { autoOpen: false })
      if (start.ok) {
        pushTerminalLog(id, 'info', `已自动重启：${start.message}`)
        return { ...result, ok: true, message: `${result.message}；已自动重启生效` }
      }
      pushTerminalLog(id, 'error', `更新完成但自动重启失败：${start.message}`)
      return { ...result, ok: false, message: `更新完成，但自动重启失败：${start.message}` }
    }
    return result
  })

  // 启动器自身更新检查：更新源在 config.json 的 updaterUrl 配置，支持多个候选 URL
  // （逗号/空格分隔，如 https://a.com/version.json https://mirror.b.com/version.json），
  // 每个候选 3 秒超时，按顺序快速切换（直连 → CDN → 镜像），全部失败才提示检查失败。
  // JSON 格式：{ version, url, notes }。未配置时默认使用仓库 launcher-version.json
  // （官方 raw → jsDelivr CDN → ghfast 镜像）。
  ipcMain.handle('launcher:update-check', async () => {
    try {
      const cfg = readJsonFile(configUserPath(), {})
      const raw = String(cfg.updaterUrl || '').trim()
      let urls = raw.split(/[,，\s]+/).map(u => u.trim()).filter(Boolean)
      if (!urls.length) {
        urls = [
          'https://raw.githubusercontent.com/mishibeikejie/zat-dsh-launcher/main/launcher-version.json',
          'https://cdn.jsdelivr.net/gh/mishibeikejie/zat-dsh-launcher@main/launcher-version.json',
          'https://ghfast.top/https://raw.githubusercontent.com/mishibeikejie/zat-dsh-launcher/main/launcher-version.json',
          'https://ghproxy.net/https://raw.githubusercontent.com/mishibeikejie/zat-dsh-launcher/main/launcher-version.json',
          'https://gh.llkk.cc/https://raw.githubusercontent.com/mishibeikejie/zat-dsh-launcher/main/launcher-version.json',
        ]
      }
      let data = null
      for (const url of urls) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 3000)
        try {
          const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
          if (res && res.ok) { data = await res.json(); break }
        } catch { /* 尝试下一个候选源 */ }
        finally { clearTimeout(timer) }
      }
      if (!data) return { ok: false, checkFailed: true, version: APP_VERSION }
      const remote = String(data.version || '').trim()
      const updateAvailable = !!remote && remote !== APP_VERSION && harnessUpdate.compareVersions(remote, APP_VERSION) > 0
      return {
        ok: true,
        updateAvailable,
        version: APP_VERSION,
        remoteVersion: remote,
        url: String(data.url || ''),
        notes: String(data.notes || ''),
      }
    } catch {
      return { ok: false, checkFailed: true, version: APP_VERSION }
    }
  })

  ipcMain.handle('terminals:sessions', (_e, terminalId) => {
    try {
      const id = requireTerminalId(terminalId)
      if (!id) return { ok: false, message: '必须指定有效终端' }
      const terminal = terminalRegistry.get(id)
      const home = resolveHome(terminal.dshHome)
      const sessions = sessionActivity.readSessions(home)
      return ok({ sessions, home }, sessions.length ? `该终端 DSH 有 ${sessions.length} 个会话` : '该终端还没有会话记录')
    } catch (err) {
      return { ok: false, message: `会话读取失败：${friendlyError(err)}` }
    }
  })

  ipcMain.handle('terminals:list', () => ok({
    selectedTerminalId: terminalRegistry ? terminalRegistry.selectedTerminalId : '',
    terminals: terminalRegistry ? terminalRegistry.list().map(terminal => ({ ...terminal, rescue: terminalRescueStatus(terminal.id), runtime: terminalSupervisor.publicRuntime(terminal.id) })) : [],
  }))
  ipcMain.handle('terminals:select', (_e, terminalId) => {
    const result = envSwitch(String(terminalId || ''))
    if (!result.ok || !terminalRegistry || !terminalSupervisor) return result
    const id = terminalRegistry.selectedTerminalId
    return { ...result, terminalId: id, logs: [...terminalSupervisor.get(id).logs], paths: terminalPaths(id), runtime: terminalSupervisor.publicRuntime(id) }
  })
  ipcMain.handle('terminals:status', async (_e, terminalId) => {
    if (!terminalRegistry || !terminalSupervisor || !terminalRegistry.get(terminalId)) return { ok: false, message: '终端不存在' }
    const runtime = await terminalSupervisor.check(terminalId)
    return ok({ terminalId, runtime })
  })

  ipcMain.handle('terminals:scan', async () => {
    const current = terminalRegistry && (terminalRegistry.get(terminalRegistry.selectedTerminalId) || terminalRegistry.list()[0])
    const explicit = current && current.dshDir ? [current.dshDir] : []
    try {
      const results = await scanDshInstallations({ explicit })
      // ★ 1.4.0（S8）：判重键套 normalizeNpmRoot——旧版以包根登记的终端不再被标成"未登记"
      const registered = new Map((terminalRegistry ? terminalRegistry.list() : []).map(t => [normalizeDshPath(normalizeNpmRoot(t.dshDir || '')), t]))
      const enriched = results.map(item => {
        const existing = registered.get(normalizeDshPath(item.dir))
        return { ...item, registered: !!existing, terminalId: existing ? existing.id : '' }
      })
      return ok({ results: enriched }, `扫描到 ${enriched.length} 个 DSH 安装`)
    } catch (err) {
      return { ok: false, message: friendlyError(err) }
    }
  })

  ipcMain.handle('terminals:choose-directory', async () => {
    // Playwright 视觉检查环境：跳过原生系统对话框，从环境变量取 DSH 目录（白板：不硬编码任何路径）
    if (process.env.DSH_LAUNCHER_VISUAL_CHECK === '1') {
      const testDir = String(process.env.DSH_VISUAL_DIR || '').trim()
      const inspected = testDir ? inspectDshDir(testDir) : null
      if (inspected) return ok({ inspected }, '目录有效（视觉检查模式）')
      return { ok: false, message: '视觉检查目录无效（请设置 DSH_VISUAL_DIR）' }
    }
    const r = await dialog.showOpenDialog(state.win, { properties: ['openDirectory'], title: '选择 DSH 安装目录' })
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true, message: '已取消' }
    const inspected = inspectDshDir(r.filePaths[0])
    if (inspected) return ok({ inspected }, '目录有效')
    // ★ 1.4.0（B1）：选的不一定是根目录——向下自动查找（旧实现直接报"无效"，
    //   findDshRootNear 的下钻能力在手动接入路径根本不可达，用户唯一的出路断头）
    const near = findDshRootNear(r.filePaths[0])
    if (near) return ok({ inspected: near }, `已在所选目录内找到 DSH：${near.dir}`)
    return { ok: false, message: '所选目录（含其 4 层内子目录）都不是有效的 DeepSeek Harness 根目录' }
  })

  ipcMain.handle('terminals:connect-directory', async (_e, dshDirInput, options) => {
    const opts = options && typeof options === 'object' ? options : {}
    const result = await connectDshDirectory(dshDirInput, opts.sourceType || 'manual', opts)
    if (result.ok && result.terminal && result.terminal.id) auditOp(result.terminal.id, `接入 DSH 目录：${dshDirInput}`)
    return result
  })

  // 复制已有 DSH：废案（用户明确移除），保留 choose-directory 供手动接入

  // 点加号 → 让用户选/新建一个文件夹作为新终端环境目录。
  // 若所选目录里已经装有 DSH（源码形态或 npm 包形态），直接接入为已有终端，
  // 而不是登记成空终端——否则用户选 D:\2 这种已装目录会得到"里面没有终端"。
  ipcMain.handle('terminals:create-empty', async () => {
    if (!terminalRegistry || !terminalSupervisor) return { ok: false, message: '终端系统未就绪' }
    let dir = ''
    if (process.env.DSH_LAUNCHER_VISUAL_CHECK === '1') {
      dir = path.join(app.getPath('userData'), 'create-test-target')
      fs.mkdirSync(dir, { recursive: true })
    } else {
      const r = await dialog.showOpenDialog(state.win, { properties: ['openDirectory', 'createDirectory'], title: '选择终端环境目录（可新建文件夹）' })
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true, message: '已取消' }
      dir = r.filePaths[0]
      // ★ 1.4.0（A4 数据安全）：拒绝把终端建在删除时会连累用户数据的目录——
      //   用户主目录本身、其一级子目录（Desktop/Documents/Downloads 等）、~/.dsh（真实 DSH 数据）、
      //   盘根。这些目录一旦登记为 fresh-empty，删除终端 = 整棵物理删除且无回收站。
      try {
        const resolved = path.resolve(dir)
        const homeNorm = path.resolve(os.homedir()).toLowerCase()
        const rel = path.relative(homeNorm, resolved)
        const firstLevel = rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep).filter(Boolean).length <= 1
        const isHomeOrLevel1 = resolved.toLowerCase() === homeNorm || firstLevel
        const isDshHome = /(^|[\\/])\.dsh($|[\\/])/i.test(resolved)
        const isDriveRoot = /^[A-Z]:\\?$/i.test(resolved)
        if (isHomeOrLevel1 || isDshHome || isDriveRoot) {
          return { ok: false, message: '该目录包含系统/DSH 数据，删除终端时会一并清掉，请选择一个专用的新文件夹（如在 D 盘新建）' }
        }
      } catch { /* 校验失败不阻断 */ }
    }
    // 目录里已有 DSH：转为接入（manual 语义：真实 home），端口从扫描结果继承
    const existingDsh = inspectDshDir(normalizeNpmRoot(dir))
    if (existingDsh) {
      const connected = await connectDshDirectory(dir, 'manual')
      if (connected.ok) return { ...connected, existingDsh: true }
      return connected
    }
    const id = `terminal-${crypto.randomUUID()}`
    const reservedPorts = await scannedReservedPorts()
    let port
    try { port = await allocateTerminalPort(reservedPorts) } catch (err) { return { ok: false, message: friendlyError(err) } }
    const dshHome = path.resolve(dir)
    fs.mkdirSync(dshHome, { recursive: true })
    const folderName = path.basename(dshHome) || '新终端'
    const name = folderName
    const env = { id, name, dshHome, dshDir: '', profileName: 'web', port, mirror: 'https://gh-proxy.com/', fallbackMirror: 'https://ghfast.top/', manual: true }
    ENVIRONMENTS.push(env)
    const terminal = terminalRegistry.add({ id, name, port, dshHome, dshDir: '', profileName: 'web', sourceType: 'fresh-empty' })
    terminalSupervisor.startMonitoring(id)
    currentEnvId = id
    terminalRegistry.select(id)
    applyEnvironment(id)
    saveUserConfig()
    await terminalSupervisor.check(id)
    emitTerminalSnapshot()
    auditOp(id, `创建新终端环境 ${name} · :${port}`)
    return {
      ok: true,
      message: `已创建新终端环境 ${name} · :${port}（目录 ${dir}）`,
      terminal: { ...terminal, runtime: terminalSupervisor.publicRuntime(id) },
      selectedTerminalId: id,
    }
  })

  // 一键全新安装（阶段 4）：独立目录下载/构建 + 引擎注入，进度经 install:progress 推送
  ipcMain.handle('terminals:install-fresh', async (_e, options) => {
    const opts = options && typeof options === 'object' ? options : {}
    const result = await installFreshTerminal(opts)
    if (result.ok && result.terminal && result.terminal.id) auditOp(result.terminal.id, '一键全新安装 DSH + 引擎')
    return result
  })

  // zat-dsh-engine 状态 / 注入 / 回滚（作用域 = 指定 terminalId 的 profile）
  ipcMain.handle('engine:status', (_e, terminalId) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    const terminal = terminalRegistry.get(id)
    const profileDir = path.join(terminal.dshHome || resolveHome(terminal.dshHome), 'profiles', terminal.profileName || 'web')
    return ok(engineManager.detectEngine(profileDir))
  })
  // 引擎更新检查：本地实装版本 vs GitHub 远端最新（raw 直连 → ghfast → gh-proxy，每源 3s 快速切换）
  ipcMain.handle('engine:check-update', async (_e, terminalId) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    const terminal = terminalRegistry.get(id)
    const profileDir = path.join(terminal.dshHome || resolveHome(terminal.dshHome), 'profiles', terminal.profileName || 'web')
    return engineManager.checkEngineUpdate(profileDir, engineManager.probeEngineRemoteVersion())
  })
  ipcMain.handle('engine:inject', (_e, terminalId) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    const terminal = terminalRegistry.get(id)
    const profileDir = path.join(terminal.dshHome || resolveHome(terminal.dshHome), 'profiles', terminal.profileName || 'web')
    const result = engineManager.injectEngine(profileDir)
    if (result.ok) {
      emitTerminalSnapshot()
      auditOp(id, '注入 zat-dsh-engine 引擎')
    }
    return result
  })
  ipcMain.handle('engine:rollback', (_e, terminalId) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    const terminal = terminalRegistry.get(id)
    const profileDir = path.join(terminal.dshHome || resolveHome(terminal.dshHome), 'profiles', terminal.profileName || 'web')
    const result = engineManager.restoreEngine(profileDir)
    if (result.ok) auditOp(id, '回滚 zat-dsh-engine 引擎')
    return result
  })
  // 真实下载/安装 zat-dsh-engine 到当前终端的 profile（bundle 声明之外，必须实装包，
  // 否则 dsh-app-boot 无法解析 bundle 导致启动超时）。也可用于修复已装但缺引擎的终端。
  ipcMain.handle('engine:install', async (_e, terminalId) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    const terminal = terminalRegistry.get(id)
    const profileDir = path.join(terminal.dshHome || resolveHome(terminal.dshHome), 'profiles', terminal.profileName || 'web')
    const onProgress = (stage, message) => emitInstallProgress({ kind: 'engine', terminalId: id, stage, message, at: Date.now() })
    const engineDir = path.join(profileDir, 'node_modules', 'zat-dsh-engine')
    // 更新/修复场景（目录已存在）必须强制重新克隆覆盖——旧逻辑"已存在就跳过"导致
    // 点更新显示成功但版本不变（用户反馈）。force=true 始终拉最新。
    const forceEngine = fs.existsSync(engineDir)
    onProgress('引擎', forceEngine ? '检测到已有引擎，强制重新下载最新版…' : '下载 zat-dsh-engine（git 浅克隆，官方优先/镜像回退）…')
    // 白板原则：引擎下载的 git 调用走内部工具链（系统无 git 也能装）
    let engineExecute = null
    try { engineExecute = makeToolchainExecute((await getToolchainEnv(id)).env) } catch { /* 工具链失败则用系统 git 兜底 */ }
    const engine = await engineManager.downloadEngineTo(engineDir, onProgress, engineExecute, { force: forceEngine })
    if (!engine.ok) return { ok: false, message: `引擎下载失败：${engine.message}` }
    try { fs.rmSync(path.join(engineDir, '.git'), { recursive: true, force: true }) } catch { /* 忽略 */ }
    engineManager.injectEngine(profileDir)
    const verified = engineManager.verifyEngine(profileDir)
    if (!verified.ok) return { ok: false, message: `引擎安装校验失败（${verified.message || '包结构或依赖缺失'}）` }
    const info = engineManager.detectEngine(profileDir)
    emitTerminalSnapshot()
    auditOp(id, `安装/更新 zat-dsh-engine 到 ${info.installedVersion || '最新'}`)
    return ok({ mounted: verified.mounted, rootValid: verified.rootValid, installedInNodeModules: verified.installedInNodeModules, installedVersion: info.installedVersion }, `zat-dsh-engine 已更新到 ${info.installedVersion || '最新'}，重启 DSH 后生效`)
  })

  // ---------------------------------------------------------------------------
  // 救援系统：每个终端独立 —— 救援点/诊断/排除都只作用于该终端自己的 profile 与日志
  // ---------------------------------------------------------------------------
  // 对已接入的外部 DSH 做只读诊断探测：用 --dump-default-config 在不启动 Web 的情况下
  // 尝试解析 profile/bundle/依赖，把 stderr 交给崩溃诊断。刚接入、从未经启动器启动的
  // 坏 DSH 也能直接扫出问题，不需要先有一次“启动失败”的日志。
  async function runDiagnosticProbe(terminalId, p) {
    if (!p || !p.dshDir) return { ok: false, output: '' }
    let toolchainEnv = null
    try { toolchainEnv = await getToolchainEnv(terminalId) } catch { toolchainEnv = null }
    const nodeExe = (toolchainEnv && toolchainEnv.nodeExe) || findNodeExe()
    if (!nodeExe) return { ok: false, output: '' }
    let cmdInfo = null
    try { cmdInfo = dshCommand(p.dshDir, nodeExe) } catch { return { ok: false, output: '' } }
    if (!cmdInfo || !cmdInfo.cli) return { ok: false, output: '' }
    const env = {
      ...(toolchainEnv && toolchainEnv.env ? toolchainEnv.env : process.env),
      DSH_HOME: p.home || '',
    }
    const profileName = p.terminal && p.terminal.profileName || 'web'
    const args = cmdInfo.built
      ? [cmdInfo.cli, '--profile', profileName, '--dump-default-config']
      : ['--import', 'tsx/esm', cmdInfo.cli, '--profile', profileName, '--dump-default-config']
    return new Promise(resolve => {
      let child
      try {
        child = spawn(nodeExe, args, { cwd: p.dshDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
      } catch { return resolve({ ok: false, output: '' }) }
      let stdout = ''
      let stderr = ''
      let settled = false
      const done = (ok, output) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { child.kill() } catch { /* 已退出 */ }
        resolve({ ok, output })
      }
      const timer = setTimeout(() => done(false, '诊断探测超时（30 秒），已终止；通常是配置/依赖卡死'), 30000)
      child.stdout.on('data', d => { stdout += String(d) })
      child.stderr.on('data', d => { stderr += String(d) })
      child.on('error', () => done(false, ''))
      child.on('exit', code => {
        const output = stderr || stdout
        done(code === 0, output)
      })
    })
  }
  const terminalRescueDir = (terminalId) => rescue.rescueDirFor(app.getPath('userData'), terminalId)
  const terminalProfileDir = (terminalId) => {
    const terminal = terminalRegistry.get(terminalId)
    return path.join(terminal.dshHome || resolveHome(terminal.dshHome), 'profiles', terminal.profileName || 'web')
  }
  const readTerminalLogTail = (terminalId, maxLines = 1500) => {
    // ★ 1.0.13：600 → 1500 行。崩溃堆栈(ERR_MODULE_NOT_FOUND 等)可能在旧日志里,
    //   600 行只装下最近轮询的"检测到终端正在运行",真正错误被截掉 → 诊断扑空。
    const file = path.join(app.getPath('userData'), 'logs', terminalId, 'launcher.log')
    try { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-maxLines) : [] } catch { return [] }
  }

  ipcMain.handle('clipboard:write', (_e, text) => {
    const { clipboard } = require('electron')
    clipboard.writeText(String(text || ''))
    return ok({}, '已复制')
  })
  ipcMain.handle('shell:open-url', (_e, url) => {
    try {
      const target = String(url || '').trim()
      if (!/^https?:\/\//i.test(target)) return { ok: false, message: '无效的下载链接' }
      shell.openExternal(target)
      return { ok: true }
    } catch { return { ok: false, message: '打开链接失败' } }
  })

  ipcMain.handle('rescue:status', (_e, terminalId) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    return ok(rescue.rescueStatus(terminalRescueDir(id)), '救援点状态')
  })
  ipcMain.handle('rescue:create', (_e, terminalId) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    const r = rescue.createRescueSnapshot(terminalProfileDir(id), terminalRescueDir(id))
    if (!r.ok) return { ok: false, message: r.message }
    pushTerminalLog(id, 'info', `已创建救援点（快照 ${r.files.length} 个文件）`)
    auditOp(id, `创建救援点（快照 ${r.files.length} 个文件）`)
    return ok({ files: r.files, at: r.at }, `救援点已创建（${r.files.length} 个文件）`)
  })
  ipcMain.handle('rescue:restore', async (_e, terminalId) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    const r = rescue.restoreRescueSnapshot(terminalProfileDir(id), terminalRescueDir(id))
    if (!r.ok) return { ok: false, message: r.message }
    pushTerminalLog(id, 'info', `已从救援点还原 ${r.files.length} 个文件，准备重启 DSH 生效`)
    auditOp(id, `从救援点还原 ${r.files.length} 个文件`)
    const runtime = terminalSupervisor.get(id)
    if (runtime.running || runtime.state === 'attached-running') await stopTerminal(id, { confirmAttached: true })
    const start = await startTerminal(id)
    return ok({ restored: r.files }, start.ok ? '救援还原完成，DSH 已重启' : `救援还原完成，但重启失败：${start.message}`)
  })
  ipcMain.handle('rescue:diagnose', async (_e, terminalId) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    const rescueDir = terminalRescueDir(id)
    const status = rescue.rescueStatus(rescueDir)
    // ★ 1.0.13：lastCrash 已恢复（recoveredAt>0）或崩溃记录太旧（超过 1 天）时不再优先返回历史，
    //   改读当前日志——否则"旧问题旧按钮"死挂（用户朋友 1.0.10 截图：一直显示 22:43 的 tsx 历史）。
    //   历史记录保留供查看,只有 recoveredAt=0 且 24 小时内的才作为主信息源。
    const crash = status.lastCrash || null
    const crashFresh = crash && !crash.recoveredAt && (Date.now() - Number(crash.at || 0)) < 24 * 60 * 60 * 1000
    if (crashFresh && Array.isArray(crash.issues) && crash.issues.length) {
      return ok({ issues: crash.issues, crash, source: 'last-crash' }, '检测到上一次崩溃记录')
    }
    const lines = readTerminalLogTail(id)
    const goodMarkers = ['终端已就绪', '检测到终端正在运行', 'dsh web: http']
    let since = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      if (goodMarkers.some(m => lines[i].includes(m))) { since = i; break }
    }
    const recent = since >= 0 ? lines.slice(since + 1) : lines
    const r = rescue.diagnoseCrash(recent)
    // 当前日志无新问题但有历史崩溃 → 附加历史供参考（source 标 last-crash 之前的记录）
    const result = { issues: r.issues, source: 'current-log' }
    // 刚接入的外部坏 DSH 往往没有启动器日志：直接对 dshDir 跑只读 --dump-default-config，
    // 在不启动 Web 的情况下解析 profile/bundle/依赖，把真实报错交给同一套崩溃诊断。
    let p = null
    try { p = terminalPaths(id) } catch { p = null }
    if (p && p.dshDir) {
      const probe = await runDiagnosticProbe(id, p)
      if (probe.ok === false && probe.output) {
        const probeIssues = rescue.diagnoseCrash(probe.output).issues
        const seen = new Set(result.issues.map(i => `${i.type}:${i.plugin}`))
        for (const issue of probeIssues) {
          const key = `${issue.type}:${issue.plugin}`
          if (!seen.has(key)) {
            seen.add(key)
            result.issues.push(issue)
          }
        }
        if (probeIssues.length) result.source = 'current-log + diagnostic-probe'
      }
    }
    if (!result.issues.length && crash && crash.issues && crash.issues.length) {
      result.lastCrash = crash
      result.message = '当前日志无崩溃,展示上一次崩溃记录(供参考)'
    }
    return ok(result, result.message || (result.issues.length ? `检测到 ${result.issues.length} 个崩溃原因` : '未检测到已知崩溃原因'))
  })
  ipcMain.handle('rescue:exclude', async (_e, terminalId, pluginName) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    if (!pluginName) return { ok: false, message: '未指定要排除的插件' }
    const r = rescue.excludePlugin(terminalProfileDir(id), pluginName)
    if (!r.ok) return { ok: false, message: r.message }
    pushTerminalLog(id, 'info', `已排除插件「${pluginName}」（保留其它插件与 node_modules），准备重启 DSH 生效`)
    auditOp(id, `排除插件「${pluginName}」`)
    const runtime = terminalSupervisor.get(id)
    if (runtime.running || runtime.state === 'attached-running') await stopTerminal(id, { confirmAttached: true })
    const start = await startTerminal(id)
    return ok({ removed: r.removed, bundles: r.bundles }, start.ok ? `已排除插件「${pluginName}」并重启 DSH` : `已排除插件「${pluginName}」，但重启失败：${start.message}`)
  })

  // bundle-mismatch 类崩溃的一键修复：重装 profile 官方 bundle（force 同步到与主包匹配的版本）再重启。
  // 这类崩溃在依赖层面（Unknown file extension .css / failed to import loader entry / prepare 未注册），
  // 救援点（仅配置文件）救不了，必须重装依赖——复用 installProfileBundles(force) 的主路径。
  ipcMain.handle('rescue:reinstall-bundles', async (_e, terminalId) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    const p = terminalPaths(id)
    pushTerminalLog(id, 'info', '检测到 profile 插件版本不匹配：开始重新同步 profile 依赖…')
    auditOp(id, '重装 profile 插件（bundle 同步）')
    const tcEnv = await getToolchainEnv(id)
    const updateExecute = makeToolchainExecute(tcEnv.env)
    const bundles = await freshInstall.installProfileBundles({
      nodeExe: tcEnv.nodeExe || findNodeExe(),
      profileDir: p.profileDir,
      toolsDir: path.join(freshInstall.normalToolsDir(), 'zat-tools'),
      onProgress: (stage, message) => pushTerminalLog(id, 'info', `[${stage}] ${message}`),
      execute: updateExecute,
      force: true,
    })
    if (!bundles.ok) return { ok: false, message: `profile 插件同步失败：${bundles.message}` }
    pushTerminalLog(id, 'info', 'profile 插件已同步，准备重启 DSH 生效')
    const runtime = terminalSupervisor.get(id)
    if (runtime.running || runtime.state === 'attached-running') await stopTerminal(id, { confirmAttached: true })
    const start = await startTerminal(id)
    return ok({}, start.ok ? '已重新同步 profile 插件并重启 DSH' : `已同步 profile 插件，但重启失败：${start.message}`)
  })

  // 源码形态缺 devDependency（如 tsx）：对 dshDir 跑 pnpm install，装完自动重启。
  // 与 bundle reinstall（profile 级）不同，这是源码树级依赖（克隆后未安装的典型场景）。
  ipcMain.handle('rescue:install-source-deps', async (_e, terminalId) => {
    const id = requireTerminalId(terminalId)
    if (!id) return { ok: false, message: '必须指定有效终端' }
    const p = terminalPaths(id)
    pushTerminalLog(id, 'info', '检测到源码形态依赖缺失，开始安装源码依赖（pnpm install）…')
    auditOp(id, '安装源码依赖（tsx 等 devDependencies）')
    // ★ 1.0.13：复用 installSourceDeps（工具链 env + pnpmExe + copy 参数与阶梯 L1 一致）
    const sd = await installSourceDeps(id, p)
    if (!sd.ok) return { ok: false, message: `源码依赖安装失败：${sd.message}` }
    pushTerminalLog(id, 'info', '源码依赖已安装，准备重启 DSH 生效')
    const runtime = terminalSupervisor.get(id)
    if (runtime.running || runtime.state === 'attached-running') await stopTerminal(id, { confirmAttached: true })
    const start = await startTerminal(id)
    return ok({}, start.ok ? '已安装源码依赖并重启 DSH' : `已安装源码依赖，但重启失败：${start.message}`)
  })

  ipcMain.handle('env:list', () => envList())
  ipcMain.handle('env:switch', (_e, id) => {
    const r = envSwitch(id)
    if (r.ok) auditOp(id, `切换环境 ${id}`)
    return r
  })
  ipcMain.handle('env:add', (_e, input) => {
    const r = envAdd(input)
    if (r.ok && r.environment && r.environment.id) auditOp(r.environment.id, `添加环境：${String(input || '').trim()}`)
    return r
  })
  ipcMain.handle('env:remove', async (_e, id) => {
    // 在删除登记/文件前记录操作（终端随后会被移除，日志目录一并清理）
    auditOp(id, `删除环境 ${id}`)
    return envRemove(id)
  })

  ipcMain.handle('env:check', () => {
    const items = envCheckItems()
    const problems = items.filter((i) => i.status === 'error')
    return ok({ items }, problems.length === 0 ? '检测完成' : `检测发现 ${problems.length} 个问题`)
  })
  ipcMain.handle('env:repair', () => repairEnv())

  ipcMain.handle('config:get', () => ok(pathsForRender(), '配置已加载'))
  ipcMain.handle('config:choose-dsh-dir', async () => {
    const r = await dialog.showOpenDialog(state.win, { properties: ['openDirectory'], title: '选择 DSH 安装目录' })
    if (r.canceled || !r.filePaths.length) return { ok: false, message: '已取消' }
    const picked = r.filePaths[0]
    const inspected = inspectDshDir(picked)
    // 作用域改为当前选中的终端：只更新该终端的目录，绝不改动其他终端或全局 CONFIG
    const id = terminalRegistry ? terminalRegistry.selectedTerminalId : ''
    if (id && terminalRegistry && terminalRegistry.get(id) && inspected) {
      const existing = findRegisteredByDshDir(picked, terminalRegistry.list())
      if (existing && existing.id !== id) return { ok: false, duplicate: true, terminalId: existing.id, message: `该 DSH 已被终端「${existing.name}」接入` }
      const terminal = terminalRegistry.update(id, { dshDir: inspected.dir })
      const env = ENVIRONMENTS.find((e) => e.id === id)
      if (env) env.dshDir = inspected.dir
      saveUserConfig()
      if (terminalSupervisor) terminalSupervisor.check(id)
      emitTerminalSnapshot()
      auditOp(id, `设置 DSH 目录：${inspected.dir}`)
      return ok({ dshDir: inspected.dir }, `已为终端「${terminal.name}」设置 DSH 目录：${inspected.dir}`)
    }
    // 无有效终端时回退到旧全局行为（仅记忆路径，不影响任何终端）
    if (inspected) {
      CONFIG.dshDir = inspected.dir
      saveUserConfig()
      return ok({ dshDir: inspected.dir }, `已记忆 DSH 目录：${inspected.dir}`)
    }
    return { ok: false, message: '所选目录不是有效的 DeepSeek Harness 根目录' }
  })

  ipcMain.on('window:minimize', () => { if (state.win) state.win.minimize() })
  ipcMain.on('window:toggle-maximize', () => {
    if (!state.win) return
    if (state.win.isMaximized()) state.win.unmaximize()
    else state.win.maximize()
  })
  // 关闭启动器：先检查运行中的终端并提醒；确认后停止所有终端再退出，取消则全部保持运行
  ipcMain.on('window:close', () => requestQuit())
  ipcMain.on('window:quit-confirmed', async () => {
    if (quitConfirmed) return
    quitConfirmed = true
    // 用户确认关闭 = 希望所有终端都不再运行：先逐个停止所有终端，再退出启动器
    await stopAllTerminals()
    app.quit()
  })
  ipcMain.on('window:quit-cancelled', () => { quitConfirmed = false })
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

let quitConfirmed = false

// 统计运行中/启动中/停止中的终端数量（与启动器是否持有 child 无关，attached 也算）
function runningTerminalCount() {
  if (!terminalRegistry || !terminalSupervisor) return 0
  let count = 0
  for (const terminal of terminalRegistry.list()) {
    const runtime = terminalSupervisor.publicRuntime(terminal.id)
    if (runtime && (runtime.running || runtime.starting || runtime.stopping || runtime.state === 'degraded')) count++
  }
  return count
}

// 关闭启动器入口（用户点 X 或 Alt+F4 触发）：有终端在运行则提醒；确认后停止所有终端再退出
function requestQuit() {
  if (quitConfirmed) { app.quit(); return }
  const running = runningTerminalCount()
  if (!state.win || state.win.isDestroyed()) { quitConfirmed = true; app.quit(); return }
  if (running > 0) {
    state.win.webContents.send('window:quit-request', running)
  } else {
    quitConfirmed = true
    app.quit()
  }
}

// 程序化退出（更新后重启 / Playwright 收尾等）必须能直接退出，
// 不能被"还有终端在运行"的拦截挡住——拦截只针对用户主动关闭。
function forceQuit() {
  quitConfirmed = true
  app.quit()
}

// 用户确认关闭启动器 = 让所有终端停止：逐个停止（含 attached），全部完成后启动器退出
async function stopAllTerminals() {
  if (!terminalRegistry || !terminalSupervisor) return
  const ids = terminalRegistry.list().map(t => t.id)
  await Promise.all(ids.map(async id => {
    const runtime = terminalSupervisor.publicRuntime(id)
    if (runtime && (runtime.running || runtime.starting || runtime.stopping)) {
      try {
        // 用户已在确认框明示要关闭全部终端，attached 不再额外追问
        await stopTerminal(id, { confirmAttached: true })
      } catch { /* 单个终端停止失败不阻塞启动器退出 */ }
    }
  }))
}

function createWindow() {
  Menu.setApplicationMenu(null)
  state.win = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 820,
    minHeight: 560,
    title: '',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    frame: false,
    titleBarStyle: 'hidden',
    thickFrame: false,
    autoHideMenuBar: true,
    transparent: true,
    hasShadow: false,
    resizable: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  // 内容渲染完成后再显示窗口：避免透明窗口先出现、内容后渲染造成的“空白期/出框慢”观感
  state.win.once('ready-to-show', () => { try { state.win.show() } catch { /* ignore */ } })
  // 兜底：透明窗口偶发 ready-to-show 不触发，3 秒后强制显示，避免窗口永远不出现
  setTimeout(() => {
    try {
      if (state.win && !state.win.isDestroyed() && !state.win.isVisible()) state.win.show()
    } catch { /* ignore */ }
  }, 3000)
  state.win.loadFile(path.join(__dirname, 'renderer', 'index.v2.html'))
  state.win.on('maximize', () => state.win.webContents.send('window:maximized', true))
  state.win.on('unmaximize', () => state.win.webContents.send('window:maximized', false))
  // 关闭保护：任何关闭路径（X 按钮 / Alt+F4 / 系统关窗）只要还有终端在运行就必须先确认。
  // 已确认退出（quitConfirmed，含程序化 app.quit() 的 before-quit）则放行。
  state.win.on('close', (e) => {
    if (quitConfirmed || process.env.DSH_LAUNCHER_VISUAL_CHECK === '1') return
    const running = runningTerminalCount()
    if (running > 0) {
      e.preventDefault()
      requestQuit()
    }
  })
  state.win.on('closed', () => { state.win = null })
  state.win.webContents.on('did-finish-load', () => {
    emitSettings()
    emitStatus()
    emitTerminalSnapshot()
  })
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

// 测试专用：DSH_TEST_USERDATA 覆盖 userData（Playwright 验证不污染真实注册表；正式运行无此变量）
if (process.env.DSH_TEST_USERDATA) {
  try { app.setPath('userData', process.env.DSH_TEST_USERDATA) } catch { /* 忽略 */ }
}

app.whenReady().then(() => {
  initializeTerminalSupervisor()
  registerIpc()
  createWindow()
  // 上次删除时被瞬时占用的残留文件：启动时静默补删一轮（进程最少、占用概率最低）
  flushPendingDeletes()
  // 实时会话活动流：每 3 秒增量读取运行中终端 DSH 的会话新帧，推送到对应终端控制台
  // （增量解压毫秒级 + worker 隐藏控制台启动 ~200ms，3 秒周期开销很小，延迟从 6 秒减半）
  setInterval(pollSessionActivity, 3000)
  pollSessionActivity()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 只停止启动器自己的监控，绝不停止任何终端进程（终端独立运行）
  if (terminalSupervisor) terminalSupervisor.dispose()
  app.quit()
})

// 程序化重启/收尾用：绕过关闭保护直接退出（供 Playwright 与内部重启调用）
app.on('before-quit', () => { quitConfirmed = true })

// 崩溃兜底：单个终端的异步异常绝不能带走整个启动器
process.on('uncaughtException', (err) => {
  try { addLog(`主进程未捕获异常（已隔离，不影响终端）：${friendlyError(err)}`, 'warn') } catch { /* ignore */ }
})
process.on('unhandledRejection', (reason) => {
  try { addLog(`主进程未处理拒绝（已隔离，不影响终端）：${friendlyError(reason)}`, 'warn') } catch { /* ignore */ }
})

// 默认配置落盘（首次运行）
try {
  if (!fs.existsSync(configUserPath())) saveUserConfig()
} catch { /* 忽略 */ }

