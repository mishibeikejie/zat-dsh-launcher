'use strict'

const api = window.dshLauncher
const $ = (id) => document.getElementById(id)
const els = {
  clock: $('clock'), version: $('version'), pill: $('titlebar-pill'), footer: $('footer-state'),
  min: $('btn-min'), max: $('btn-max'), close: $('btn-close'), maxIcon: document.querySelector('.ico-max'), restoreIcon: document.querySelector('.ico-restore'),
  orb: $('orb'), status: $('status-text'), detail: $('status-detail'), start: $('btn-start'), stop: $('btn-stop'), restart: $('btn-restart'), open: $('btn-open'),
  autoRestart: $('switch-autorestart'), autoOpen: $('switch-autoopen'), tabs: $('tabs'), indicator: $('tab-indicator'),
  logs: $('log-box'), logCount: $('log-count'), autoscroll: $('check-autoscroll'), copy: $('btn-copy-log'), clear: $('btn-clear-log'),
  envSwitch: $('env-switch'), envSwitchValue: $('env-switch-value'), envMenu: $('env-menu'), addTerminal: $('btn-add-terminal'), removeTerminal: $('btn-remove-terminal'), harnessVersion: $('harness-version'), harnessUpdateBadge: $('harness-update-badge'), harnessUpdateDetail: $('harness-update-detail'), checkUpdate: $('btn-check-update'), installUpdate: $('btn-install-update'), checkEnv: $('btn-check-env'), repairEnv: $('btn-repair-env'), chooseDsh: $('btn-choose-dsh'), envGrid: $('env-grid'), envPath: $('env-dsh-path'),
  engineStatus: $('engine-status'), engineStatusDetail: $('engine-status-detail'), engineInject: $('btn-engine-inject'), engineRollback: $('btn-engine-rollback'), engineCheck: $('btn-engine-check'), engineUpdateBadge: $('engine-update-badge'),
  launcherVersion: $('launcher-version'), launcherUpdateBadge: $('launcher-update-badge'), launcherUpdateDetail: $('launcher-update-detail'), launcherCheckUpdate: $('btn-launcher-check-update'),
  rescueStatus: $('rescue-status'), rescueStatusDetail: $('rescue-status-detail'), rescueCreate: $('btn-rescue-create'), rescueDiagnose: $('btn-rescue-diagnose'), rescueCopyLog: $('btn-rescue-copy-log'), rescueDiagnoseDetail: $('rescue-diagnose-detail'), rescueIssues: $('rescue-issues'),
  emptyInstall: $('empty-install'), emptyScan: $('empty-scan'), emptyManual: $('empty-manual'), emptyDesc: $('empty-desc'),
  toasts: $('toasts'), modal: $('modal-mask'), modalTitle: $('modal-title'), modalMessage: $('modal-message'), modalOk: $('modal-ok'), modalCancel: $('modal-cancel'),
  wizard: $('wizard-mask'), wizardTitle: $('wizard-title'), wizardBody: $('wizard-body'), wizardClose: $('wizard-close'), wizardBack: $('wizard-back'),
}
const state = { logs: [], status: {}, settings: {}, paths: {}, environments: [], currentEnv: '', terminals: [], selectedTerminalId: '' }
let modalResolve
let selectionSeq = 0 // 终端切换序号：只让最后一次切换的结果生效，丢弃过期异步结果

function toast(message, type = '') {
  const n = document.createElement('div'); n.className = `toast ${type}`; n.textContent = message; els.toasts.appendChild(n); setTimeout(() => n.remove(), 4000)
}
// 删除进度：替换式 toast（同一元素反复更新文本，不堆叠）
let deleteToastEl = null
let deleteToastTimer = null
function deleteToast(message, type = '') {
  if (!deleteToastEl) {
    deleteToastEl = document.createElement('div')
    deleteToastEl.className = 'toast'
    els.toasts.appendChild(deleteToastEl)
  }
  deleteToastEl.className = `toast ${type}`
  deleteToastEl.textContent = message
  clearTimeout(deleteToastTimer)
  deleteToastTimer = setTimeout(() => { if (deleteToastEl) { deleteToastEl.remove(); deleteToastEl = null } }, 60000)
}
function clearDeleteToast() {
  clearTimeout(deleteToastTimer)
  if (deleteToastEl) { deleteToastEl.remove(); deleteToastEl = null }
}
function logNode(e) {
  const n = document.createElement('div')
  n.className = `log-line ${e.level || 'info'}${e.kind ? ` kind-${e.kind}` : ''}`
  n.innerHTML = `<span class="log-time"></span><span class="log-tag"></span><span class="log-text"></span>`
  n.firstChild.textContent = e.time || '--:--:--'
  const tag = n.children[1]
  if (e.kind === 'user') tag.textContent = '我'
  else if (e.kind === 'session') tag.textContent = '会话'
  else if (e.kind === 'op') tag.textContent = '操作'
  n.lastChild.textContent = e.text || ''
  return n
}
// 日志面板只保留最近 MAX_LOG_ROWS 条 DOM（历史完整记录在磁盘 launcher.log，面板不无限积累，
// 避免会话事件越多越卡、越耗资源）
const MAX_LOG_ROWS = 600
function renderLogs(entries = []) {
  state.logs = [...entries].slice(-MAX_LOG_ROWS)
  els.logs.innerHTML = ''
  for (const e of state.logs) els.logs.appendChild(logNode(e))
  els.logCount.textContent = `${state.logs.length} 条`; els.logs.scrollTop = els.logs.scrollHeight
  if (!state.logs.length) { const n = document.createElement('div'); n.className = 'log-empty'; n.textContent = '暂无日志。'; els.logs.appendChild(n) }
}
function appendLog(e) {
  state.logs.push(e)
  if (state.logs.length > MAX_LOG_ROWS) state.logs.splice(0, state.logs.length - MAX_LOG_ROWS)
  // 增量 DOM：只追加新行 + 移除超限的最旧行，绝不每次全量重建（历史多时不卡）
  if (els.logs.firstChild && els.logs.firstChild.className === 'log-empty') els.logs.firstChild.remove()
  const node = logNode(e)
  const atBottom = els.logs.scrollHeight - els.logs.scrollTop - els.logs.clientHeight < 40
  els.logs.appendChild(node)
  while (els.logs.children.length > MAX_LOG_ROWS) els.logs.firstChild.remove()
  els.logCount.textContent = `${els.logs.children.length} 条`
  if (atBottom) els.logs.scrollTop = els.logs.scrollHeight
}
function formatDuration(ms) {
  const n = Number(ms) || 0
  if (n <= 0) return ''
  const s = Math.floor(n / 1000)
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60
  if (d > 0) return `${d}天${h}小时`
  if (h > 0) return `${h}小时${m}分`
  if (m > 0) return `${m}分${sec}秒`
  return `${sec}秒`
}
function currentPort() {
  const t = state.terminals.find(x => x.id === (state.selectedTerminalId || state.currentEnv))
  if (t && t.port) return t.port
  return state.paths.port || 3080
}
function renderStatus(s) {
  state.status = s || state.status; const running = !!s.running
  const port = currentPort()
  const pidText = s.pid || (s.pids || [])[0] || (s.ownership === 'attached' ? '外部接入' : '检测中')
  const uptime = formatDuration(s.uptimeMs)
  els.status.textContent = running ? `运行中 · 端口 ${port}` : (s.starting ? '正在启动' : s.stopping ? '正在停止' : '未运行')
  els.detail.textContent = running ? `进程 ${pidText}` : `端口 ${port} ${s.starting ? '启动中' : '空闲'}`
  // 转圈已移除（被打赏二维码卡片取代），仅保留状态容器 class 以兼容旧逻辑
  if (els.orb) els.orb.className = `runtime-orb ${running ? 'running' : s.starting ? 'starting' : ''}`
  // 光环随运行状态柔和呼吸（形象保持静止，等待真实帧动画素材）
  const orbit = document.querySelector('.status-orbit')
  if (orbit) orbit.className = `status-orbit${running ? ' running' : s.starting ? ' starting' : ''}`
  // 大肥鱼：运行中走路帧循环，停止时静止帧
  setMascotMotion(running ? 'running' : 'idle')
  // 运行时长只显示在标题栏 pill 一处（每个终端各显示各的），避免与侧边栏重复
  els.pill.textContent = running ? (uptime ? `运行中 · ${uptime}` : '运行中') : s.starting ? '启动中' : '就绪'
  els.footer.textContent = running ? '● 运行中' : '○ 未运行'
  els.start.disabled = running || s.starting || s.stopping; els.stop.disabled = (!running && !s.starting && !s.pid && !s.childPid) || s.stopping; els.restart.disabled = s.starting || s.stopping || !running
}
function renderEnvs(list, current) {
  state.environments = list || []
  state.currentEnv = current || ''
  const terminals = state.terminals.length ? state.terminals : state.environments
  const menu = els.envMenu
  if (!menu) return
  menu.innerHTML = ''
  if (!terminals.length) {
    // 没有终端时菜单显示占位，避免弹出只有边框的窄条
    const empty = document.createElement('div')
    empty.className = 'env-menu-empty'
    empty.textContent = '暂无终端'
    menu.appendChild(empty)
  }
  for (const terminal of terminals) {
    const runtime = terminal.runtime || {}
    const marker = runtime.running ? '●' : runtime.starting ? '◐' : ['failed', 'port-conflict', 'degraded'].includes(runtime.state) ? '!' : '○'
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'env-menu-item'
    item.dataset.id = terminal.id
    item.setAttribute('role', 'option')
    item.innerHTML = `<span class="env-menu-marker">${marker}</span><span class="env-menu-text">${terminal.name} · :${terminal.port}</span>`
    item.title = `${terminal.name}（端口 ${terminal.port}）`
    item.onclick = () => {
      closeEnvMenu()
      selectTerminal(terminal.id)
    }
    menu.appendChild(item)
  }
  renderEnvSwitchValue()
}

function renderEnvSwitchValue() {
  if (!els.envSwitchValue) return
  const terminals = state.terminals.length ? state.terminals : state.environments
  const current = terminals.find(t => t.id === (state.selectedTerminalId || state.currentEnv))
  els.envSwitchValue.textContent = current
    ? `${current.runtime && current.runtime.running ? '●' : current.runtime && current.runtime.starting ? '◐' : '○'} ${current.name} · :${current.port}`
    : '选择终端…'
  // 名称被省略号截断时悬停显示全名（终端选择器宽度有限，长名看不到结尾）
  els.envSwitchValue.title = current ? `${current.name}（端口 ${current.port}）` : ''
}

function toggleEnvMenu() {
  if (!els.envMenu) return
  const opening = els.envMenu.hidden
  closeEnvMenu()
  if (opening) {
    els.envMenu.hidden = false
    // env-menu 是 terminal-select-wrap 的 absolute 子元素，必须使用相对坐标。
    // 之前写入 viewport 坐标会把菜单推到屏幕外，自动化定位能点到但真实鼠标看不见。
    // 方向自适应：下方空间不足（终端选择区贴底时）改为向上弹出，避免被窗口边缘截断。
    const wrap = els.envMenu.parentElement
    const wrapRect = wrap.getBoundingClientRect()
    const estHeight = Math.min(280, els.envMenu.children.length * 34 + 12)
    const spaceBelow = window.innerHeight - wrapRect.bottom
    const spaceAbove = wrapRect.top
    if (spaceBelow < estHeight && spaceAbove > spaceBelow) {
      els.envMenu.style.top = 'auto'
      els.envMenu.style.bottom = '42px'
    } else {
      els.envMenu.style.top = '42px'
      els.envMenu.style.bottom = 'auto'
    }
    els.envMenu.style.left = '0'
    // 宽度由 CSS 控制，覆盖整个终端选择区（含加号和减号），不要在这里覆盖成 100%。
    els.envSwitch.classList.add('open')
  }
}

function closeEnvMenu() {
  if (!els.envMenu) return
  els.envMenu.hidden = true
  els.envSwitch.classList.remove('open')
}
async function selectTerminal(id) {
  const mySeq = ++selectionSeq
  const targetId = id
  const r = api.terminalSelect ? await api.terminalSelect(targetId) : await api.envSwitch(targetId)
  if (mySeq !== selectionSeq) return // 等待期间用户已切到别的终端，丢弃过期结果
  if (!r.ok) { toast(r.message, 'error'); return }
  state.selectedTerminalId = r.terminalId || targetId
  state.currentEnv = state.selectedTerminalId
  if (r.logs) renderLogs(r.logs)
  if (r.paths) renderPaths(r.paths)
  if (r.runtime) renderStatus(r.runtime)
  renderEnvs(state.terminals, state.selectedTerminalId)
  updateTerminalButtons()
  const current = state.terminals.find(item => item.id === state.selectedTerminalId)
  renderEmptyState(current)
  const tid = state.selectedTerminalId
  // 切换终端的瞬间先重置更新区块（清掉上一个终端的 badge/版本），再异步加载当前终端的数据
  state.harnessInfo = null
  resetHarnessUpdate()
  if (api.harnessInfo) { const v = await api.harnessInfo(tid); if (mySeq === selectionSeq && state.selectedTerminalId === tid) renderHarnessInfo(v) }
  if (api.engineStatus) { const v = await api.engineStatus(tid); if (mySeq === selectionSeq && state.selectedTerminalId === tid) renderEngineStatus(v) }
  if (api.rescueStatus) { const v = await api.rescueStatus(tid); if (mySeq === selectionSeq && state.selectedTerminalId === tid) renderRescueStatus(v) }
  if (api.checkEnv) { const v = await api.checkEnv(); if (mySeq === selectionSeq && state.selectedTerminalId === tid) renderEnv(v) }
  scheduleAutoHarnessUpdateCheck()
}
function updateTerminalButtons() {
  if (!els.removeTerminal) return
  const terminal = state.terminals.find(item => item.id === state.selectedTerminalId)
  const runtime = terminal && terminal.runtime || {}
  // 删除不再限制「至少保留一个」；运行中也会先停止再删（主进程处理），所以始终可点
  els.removeTerminal.disabled = !terminal
  els.removeTerminal.title = terminal ? '删除当前终端（登记 + 进程 + 文件夹 + 日志，彻底清理）' : ''
}
function renderTerminalSnapshot(snapshot) {
  if (!snapshot) return
  state.terminals = snapshot.terminals || []
  // 主进程是选中状态的权威：接入/切换/删除后都跟随快照。
  // 旧的"仅当当前选中不存在才回退"会锁死选中：载入新终端后界面停在旧终端，
  // 而主进程已切到新终端（其日志经 state:get/事件推送过来）→ 控制台显示新终端日志、
  // 其他界面却显示旧终端 → 串台。快照事件由主进程按操作顺序同步发送，不存在乱序。
  const target = snapshot.selectedTerminalId || state.currentEnv || ''
  if (target && target !== state.selectedTerminalId) {
    state.selectedTerminalId = target
  }
  const selected = state.terminals.find(t => t.id === state.selectedTerminalId)
  if (snapshot.paths && selected && snapshot.selectedTerminalId === state.selectedTerminalId) renderPaths(snapshot.paths)
  if (selected && selected.runtime) renderStatus(selected.runtime)
  if (selected && selected.rescue) renderRescueStatus(selected.rescue)
  renderEnvs(state.terminals, state.selectedTerminalId)
  updateTerminalButtons()
  renderEmptyState(selected)
  // 终端运行状态变化时，环境面板的端口行也要跟着刷新（如 空闲 → 已监听）
  scheduleEnvRefresh()
}

// 空终端状态页：新环境未安装 DSH 时显示（一键安装 / 扫描 / 手动），已安装则正常界面。
// 关键：只控制 empty 面板显隐，console/env 的切换完全交给 switchTab，绝不互相干扰。
function renderEmptyState(terminal) {
  if (!els.emptyInstall) return
  const isEmpty = !terminal || !terminal.dshDir || terminal.sourceType === 'fresh-empty' || terminal.sourceType === 'fresh-installed-empty'
  const emptyPanel = document.querySelector('.panel[data-panel="empty"]')
  if (!emptyPanel) return
  emptyPanel.classList.toggle('active', isEmpty)
  // 保留原有标题栏、运行控制区和标签栏布局；空状态只替换内容面板，不改变页面骨架。
  const tabs = document.getElementById('tabs')
  const actionPanel = document.querySelector('.action-panel')
  if (tabs) tabs.style.display = ''
  if (actionPanel) actionPanel.style.display = ''
  if (isEmpty) {
    // 空终端（白板）：默认展示 empty 引导面板（"一键安装/扫描/手动"）。
    // 用户主动点击过 环境/救援 tab 才切到对应面板（修复 1.0.0 的"点了没反应"）；
    // 点回 console tab 或未点击过时恢复引导。
    if (emptyTabOverride === 'env' || emptyTabOverride === 'rescue') {
      document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === emptyTabOverride))
      emptyPanel.classList.remove('active')
    } else {
      emptyPanel.classList.add('active')
      document.querySelectorAll('.panel[data-panel="console"], .panel[data-panel="env"], .panel[data-panel="rescue"]').forEach(p => p.classList.remove('active'))
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'console'))
    }
  } else {
    const activeTab = document.querySelector('.tab.active')?.dataset.tab || 'console'
    switchTab(activeTab)
  }
  // 首次使用（无任何终端）显示扫描/手动；已有终端后只留一键安装
  const hasTerminal = (state.terminals || []).length > 0
  if (els.emptyScan) els.emptyScan.hidden = hasTerminal
  if (els.emptyManual) els.emptyManual.hidden = hasTerminal
  if (els.emptyDesc) els.emptyDesc.textContent = hasTerminal
    ? '这个新环境还没有安装 DSH。点「一键安装」下载官方最新版到独立目录（即装即用）。'
    : '选择安装方式，把 DeepSeek Harness 装到这个独立环境里。'
}
function renderPaths(p) { state.paths = p || {}; els.envPath.textContent = `DSH 目录：${p.dshDir || '未设置'}` }
// ---- 大肥鱼帧动画：停止显示静止帧，运行中循环播放走路帧（透明羽化 PNG，无方块边缘）----
const MASCOT_FRAMES = ['walk_side_238_00.png', 'walk_side_238_01.png', 'walk_side_238_02.png', 'walk_side_238_03.png']
let mascotTimer = null
let mascotFrame = 0
function mascotImg() {
  return document.getElementById('mascot-img') || document.querySelector('.side-mascot img')
}
function setMascotMotion(state) {
  const img = mascotImg()
  if (!img) return
  if (state === 'running') {
    if (mascotTimer) return
    mascotFrame = 0
    mascotTimer = setInterval(() => {
      mascotFrame = (mascotFrame + 1) % MASCOT_FRAMES.length
      img.src = `../assets/dafeiyu/${MASCOT_FRAMES[mascotFrame]}`
    }, 180)
  } else {
    if (mascotTimer) { clearInterval(mascotTimer); mascotTimer = null }
    img.src = '../assets/dafeiyu/idle_front_238.png'
  }
}
function resetHarnessUpdate() {
  if (!els.harnessVersion || !els.harnessUpdateDetail) return
  els.harnessVersion.textContent = '检测中…'
  els.harnessUpdateDetail.textContent = '读取当前终端版本'
  if (els.harnessUpdateBadge) { els.harnessUpdateBadge.hidden = true; els.harnessUpdateBadge.textContent = ''; els.harnessUpdateBadge.className = 'update-badge' }
  if (els.installUpdate) { els.installUpdate.disabled = true; els.installUpdate.textContent = '安装更新' }
}
function renderHarnessInfo(info) {
  const previous = state.harnessInfo || {}
  const merged = info && info.version ? info : { ...previous, ...(info || {}) }
  state.harnessInfo = merged
  if (!els.harnessVersion || !els.harnessUpdateDetail) return
  if (!merged.version) {
    els.harnessVersion.textContent = '本地不可用'
    els.harnessUpdateDetail.textContent = merged.message || '无法读取本地 Harness 版本'
    els.harnessUpdateBadge.hidden = true
    els.installUpdate.disabled = true
    return
  }
  els.harnessVersion.textContent = merged.version || '未知'
  els.harnessUpdateBadge.hidden = false
  if (merged.checkFailed) {
    els.harnessUpdateBadge.className = 'update-badge failed'
    els.harnessUpdateBadge.textContent = '检查失败'
  } else if (merged.updateAvailable) {
    els.harnessUpdateBadge.className = 'update-badge available'
    els.harnessUpdateBadge.textContent = `有新版本 ${merged.remoteVersion || ''}`.trim()
  } else if (merged.remoteCommit) {
    els.harnessUpdateBadge.className = 'update-badge current'
    els.harnessUpdateBadge.textContent = '已是最新'
  } else {
    els.harnessUpdateBadge.hidden = true
  }
  const terminal = state.terminals.find(item => item.id === state.selectedTerminalId)
  const runtime = terminal && terminal.runtime || {}
  const dirty = merged.dirty ? ` · ${merged.dirtyCount} 项本地修改` : ''
  const remoteDetail = merged.remoteCommit ? (merged.kind === 'npm' ? ` · 最新 ${merged.remoteVersion}` : ` · 远端 ${merged.remoteCommit} · 落后 ${merged.behindCount} 个提交`) : ''
  const checkDetail = merged.checkFailed ? ` · ${merged.message}` : ''
  const branchText = merged.kind === 'npm' ? 'npm 包' : (merged.branch || '未知分支')
  const commitText = merged.kind === 'npm' ? (merged.version || '未知') : (merged.commit || '未知')
  const needsStop = runtime.running || runtime.starting || runtime.stopping
  const stopNote = runtime.running
    ? ' · 终端运行中：直接尝试热更新，不停止终端；若文件被占用会在日志说明'
    : ''
  els.harnessUpdateDetail.textContent = merged.kind === 'npm'
    ? `版本 ${commitText} · ${branchText}${remoteDetail}${checkDetail}${merged.updateAvailable && needsStop ? stopNote : ''}`
    : `提交 ${commitText} · ${branchText}${remoteDetail}${dirty}${checkDetail}${merged.updateAvailable && needsStop ? stopNote : ''}`
  // 有更新就能点：运行中直接尝试热更新，不停止终端、不禁止
  els.installUpdate.disabled = !merged.canInstall
  els.installUpdate.title = merged.dirty ? '存在本地修改：更新会先自动暂存（git stash），安装完成后保留官方版本' : merged.updateAvailable ? '安装可用更新（运行中直接尝试，不停止终端）' : '当前没有可安装更新'
}
function renderEnv(result) { els.envGrid.innerHTML = ''; for (const x of result.items || []) { const n = document.createElement('div'); n.className = 'env-item'; n.innerHTML = `<div class="env-icon ${x.status}">${x.status === 'ok' ? '✓' : x.status === 'warn' ? '!' : '×'}</div><div class="env-copy"><div class="env-name"></div><div class="env-detail"></div></div>`; n.querySelector('.env-name').textContent = x.label; n.querySelector('.env-detail').textContent = x.detail || ''; els.envGrid.appendChild(n) } }
// 插件商店（zat-dsh-engine）状态显示：按「包是否实装」为准（bundle 声明存在但缺包 = 未安装，可一键补装）
function renderEngineStatus(info) {
  if (!els.engineStatus || !els.engineStatusDetail) return
  state.engineInfo = info || {}
  const mounted = state.engineInfo.mounted === true
  const viaBundle = state.engineInfo.mountedViaBundle === true
  const viaPatch = state.engineInfo.mountedViaPatch === true
  const installed = state.engineInfo.installedInNodeModules === true
  const localVersion = state.engineInfo.installedVersion || ''
  els.engineStatus.classList.toggle('store-mounted', installed)
  els.engineStatus.classList.toggle('store-missing', !installed)
  els.engineStatus.textContent = installed ? (localVersion ? `已内置 v${localVersion}` : '已内置') : (mounted ? '未安装' : '待注入')
  const mode = installed && (viaBundle && viaPatch ? 'bundle + patch' : viaBundle ? '官方 bundle' : viaPatch ? '内置 patch' : '')
  const detail = installed
    ? `插件商店是启动器固定组件，已加载${localVersion ? ` v${localVersion}` : ''}${mode ? ` · ${mode}` : ''}。点「检查更新」对比 GitHub 最新版本`
    : mounted
      ? '插件商店已声明但包未安装，点击「安装插件商店」补装'
      : '插件商店是启动器固定组件，当前终端尚未注入'
  els.engineStatusDetail.textContent = detail
  els.engineInject.hidden = installed
  if (els.engineRollback) els.engineRollback.hidden = true
  if (els.engineCheck) els.engineCheck.hidden = !installed
  if (els.engineUpdateBadge) els.engineUpdateBadge.hidden = true
}

// 插件商店更新检查：本地版本 vs GitHub 远端最新（多源 3s 快速切换），有新版时提示可更新
async function checkEngineUpdate() {
  const id = state.selectedTerminalId
  if (!id || !els.engineCheck) return
  const seqAtClick = selectionSeq
  const label = els.engineCheck.textContent
  els.engineCheck.disabled = true
  els.engineCheck.textContent = '检查中…'
  try {
    const r = await api.engineCheckUpdate(id)
    if (state.selectedTerminalId !== id || seqAtClick !== selectionSeq) return
    if (r && r.ok) {
      state.engineUpdateInfo = r
      if (r.updateAvailable) {
        if (els.engineUpdateBadge) {
          els.engineUpdateBadge.hidden = false
          els.engineUpdateBadge.className = 'update-badge available'
          els.engineUpdateBadge.textContent = `插件商店有新版本 ${r.remoteVersion || ''}`.trim()
        }
        if (els.engineInject) {
          els.engineInject.hidden = false
          els.engineInject.textContent = '更新插件商店'
        }
        if (els.engineStatusDetail) els.engineStatusDetail.textContent = `发现新版本 ${r.remoteVersion}（当前 ${r.installedVersion}）。点击「更新插件商店」从 GitHub 拉取最新。`
      } else {
        if (els.engineUpdateBadge) { els.engineUpdateBadge.hidden = false; els.engineUpdateBadge.className = 'update-badge current'; els.engineUpdateBadge.textContent = '已是最新' }
      }
      toast(r.message, r.checkFailed ? 'error' : '')
    } else {
      toast((r && r.message) || '引擎更新检查失败', 'error')
    }
  } catch (err) {
    toast('引擎更新检查失败', 'error')
  } finally {
    if (state.selectedTerminalId === id) {
      els.engineCheck.disabled = false
      els.engineCheck.textContent = label
    }
  }
}
function renderRescueStatus(info) {  if (!els.rescueStatus || !els.rescueStatusDetail) return
  const exists = !!(info && info.exists)
  els.rescueStatus.classList.toggle('store-mounted', exists)
  els.rescueStatus.classList.toggle('store-missing', !exists)
  els.rescueStatus.textContent = exists ? '有救援点' : '无救援点'
  if (exists) {
    const d = new Date(info.at)
    const base = `救援点时间 ${isNaN(d.getTime()) ? '未知' : d.toLocaleString('zh-CN', { hour12: false })}（${(info.files || []).length} 个文件）`
    const crash = info.lastCrash
    els.rescueStatusDetail.textContent = crash
      ? `${base} · 上次崩溃 ${new Date(crash.at).toLocaleString('zh-CN', { hour12: false })}${crash.recoveredAt ? '（已恢复，记录保留）' : '（待处理）'}`
      : base
  } else {
    const crash = info && info.lastCrash
    els.rescueStatusDetail.textContent = crash
      ? `上次崩溃 ${new Date(crash.at).toLocaleString('zh-CN', { hour12: false })}${crash.recoveredAt ? '（已恢复，记录保留）' : '（待处理）'}`
      : '崩溃自动重启，每次成功启动后自动刷新；也可手动锁定'
  }
}

// ---- 启动器自身更新 ----
let launcherAutoChecked = false
function renderLauncherUpdate(info) {
  if (!els.launcherVersion || !els.launcherUpdateDetail) return
  const v = info || {}
  els.launcherVersion.textContent = `v${v.version || '1.0.4'}`
  if (!els.launcherUpdateBadge) return
  els.launcherUpdateBadge.hidden = false
  if (v.updateAvailable) {
    els.launcherUpdateBadge.className = 'update-badge available'
    els.launcherUpdateBadge.textContent = `有新版本 ${v.remoteVersion || ''}`
    els.launcherUpdateDetail.textContent = v.notes ? `更新说明：${v.notes}` : `发现新版本 ${v.remoteVersion}，点「检查更新」查看下载`
  } else if (v.ok) {
    els.launcherUpdateBadge.className = 'update-badge current'
    els.launcherUpdateBadge.textContent = '已是最新'
    els.launcherUpdateDetail.textContent = '启动器已是最新版本'
  } else if (v.notConfigured) {
    els.launcherUpdateBadge.hidden = true
    els.launcherUpdateDetail.textContent = '未配置更新源（config.json 的 updaterUrl）'
  } else if (v.checkFailed) {
    els.launcherUpdateBadge.hidden = true
    els.launcherUpdateDetail.textContent = '检查失败（网络不可用，可稍后手动检查）'
  } else {
    els.launcherUpdateBadge.hidden = true
    els.launcherUpdateDetail.textContent = '启动器更新自动检查'
  }
}
// 启动器自动更新检查：启动后延迟 8 秒静默检查一次，有新版本才在徽标上提示
async function autoCheckLauncherUpdate() {
  if (launcherAutoChecked || !api.launcherCheckUpdate) return
  launcherAutoChecked = true
  try {
    const result = await api.launcherCheckUpdate()
    if (result && result.updateAvailable) renderLauncherUpdate(result)
  } catch { /* 自动检查失败静默 */ }
}

// ---- DSH 自动更新检查：启动/切换终端后延迟自动检查，有新版本自动提示（每终端 30 分钟一次） ----
const autoCheckTimestamps = {}
const AUTO_CHECK_INTERVAL = 30 * 60 * 1000
function scheduleAutoHarnessUpdateCheck() {
  const id = state.selectedTerminalId
  const terminal = state.terminals.find(t => t.id === id)
  if (!id || !terminal || !terminal.dshDir || !api.harnessCheckUpdate) return
  const now = Date.now()
  if (now - (autoCheckTimestamps[id] || 0) < AUTO_CHECK_INTERVAL) return
  autoCheckTimestamps[id] = now
  setTimeout(async () => {
    const seqAtSchedule = selectionSeq
    try {
      const timeout = new Promise(resolve => setTimeout(() => resolve({ ok: true, checkFailed: true, message: '自动检查超时' }), 12000))
      const result = await Promise.race([api.harnessCheckUpdate(id), timeout])
      if (state.selectedTerminalId === id && seqAtSchedule === selectionSeq) renderHarnessInfo(result)
    } catch { /* 自动检查失败静默 */ }
  }, 6000)
}

function crashRecordText(result) {
  const crash = (result && result.crash) || null
  const issues = (result && result.issues) || []
  const parts = []
  if (crash && crash.at) parts.push(`崩溃时间：${new Date(crash.at).toLocaleString('zh-CN', { hour12: false })}${crash.recoveredAt ? '（已恢复）' : ''}`)
  if (crash && crash.exitCode !== undefined && crash.exitCode !== null) parts.push(`退出码：${crash.exitCode}`)
  for (const issue of issues) parts.push(`[${issue.type}] ${issue.message}`)
  if (crash && Array.isArray(crash.logTail) && crash.logTail.length) {
    parts.push('--- 完整崩溃日志 ---')
    parts.push(crash.logTail.join('\n'))
  }
  return parts.join('\n')
}
function renderRescueDiagnosis(result) {
  if (!els.rescueIssues) return
  state.lastRescueDiagnosis = result || null
  const issues = (result && result.issues) || []
  const crash = (result && result.crash) || null
  if (els.rescueCopyLog) els.rescueCopyLog.hidden = !(crash && Array.isArray(crash.logTail) && crash.logTail.length)
  els.rescueIssues.innerHTML = ''
  // 来源标题：让用户一眼看出是「上一次崩溃记录」，而不是当前正在发生的问题
  if (crash && crash.at) {
    const head = document.createElement('div')
    head.className = 'rescue-source'
    head.textContent = `上一次崩溃记录 · ${new Date(crash.at).toLocaleString('zh-CN', { hour12: false })}${crash.recoveredAt ? '（已恢复，记录保留）' : '（待处理）'}`
    els.rescueIssues.appendChild(head)
  }
  if (!issues.length) {
    const n = document.createElement('div')
    n.className = 'rescue-empty'
    n.textContent = '未检测到已知崩溃原因。'
    els.rescueIssues.appendChild(n)
    return
  }
  const typeLabel = { 'missing-bundle': '缺失插件', 'plugin-failed': '插件加载失败', 'bad-profile': 'profile 损坏', 'missing-module': '缺少依赖', 'cli-arg': '启动参数不兼容', 'cli-error': '启动命令错误', 'bundle-mismatch': '插件版本不匹配', 'duplicate-plugin': '插件重复注册', 'tool-missing': '工具链缺失', 'source-deps': '源码依赖缺失' }
  for (const issue of issues) {
    const row = document.createElement('div')
    row.className = 'rescue-issue'
    const head = document.createElement('div')
    head.className = 'rescue-issue-copy'
    const badge = document.createElement('span')
    badge.className = 'version-badge store-missing'
    badge.textContent = typeLabel[issue.type] || issue.type
    const msg = document.createElement('span')
    msg.className = 'muted'
    msg.textContent = issue.message
    head.appendChild(badge)
    head.appendChild(msg)
    row.appendChild(head)
    // 操作列独立成组：复制 + 排除/还原，绝不遮挡错误文本，文本可选中复制
    const actions = document.createElement('div')
    actions.className = 'rescue-issue-actions'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'btn btn-ghost'
    copy.textContent = '复制'
    copy.title = '复制这条错误信息'
    copy.onclick = async () => {
      try { await api.copyText(issue.message); toast('错误信息已复制') } catch { toast('复制失败，请手动选中文本', 'error') }
    }
    actions.appendChild(copy)
    if (issue.fix === 'exclude-bundle' && issue.plugin) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn btn-ghost'
      btn.textContent = `排除「${issue.plugin}」`
      btn.onclick = async () => {
        if (!await confirm('排除崩溃插件', `将从 profile 移除插件「${issue.plugin}」并重启 DSH，其它插件与 node_modules 全部保留（不重装）。确定继续？`)) return
        btn.disabled = true
        btn.textContent = '排除中…'
        const id = state.selectedTerminalId
        const r = await api.rescueExclude(id, issue.plugin)
        toast(r.message, r.ok ? '' : 'error')
        btn.disabled = false
        btn.textContent = `排除「${issue.plugin}」`
        if (r.ok) { renderRescueStatus(await api.rescueStatus(id)); renderRescueDiagnosis(await api.rescueDiagnose(id)) }
      }
      actions.appendChild(btn)
    } else if (issue.fix === 'restore') {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn btn-ghost'
      btn.textContent = '还原到救援点'
      btn.onclick = async () => {
        const id = state.selectedTerminalId
        if (!id) return toast('请先选择终端', 'error')
        if (!await confirm('还原到救援点', '将把当前终端 profile 配置还原到救援点（上次成功启动的状态），并重启 DSH 生效。确定继续？')) return
        btn.disabled = true
        btn.textContent = '还原中…'
        try {
          const r = await api.rescueRestore(id)
          toast(r.message, r.ok ? '' : 'error')
          if (r.ok) { renderRescueStatus(await api.rescueStatus(id)); renderRescueDiagnosis(await api.rescueDiagnose(id)) }
        } finally {
          btn.disabled = false
          btn.textContent = '还原到救援点'
        }
      }
      actions.appendChild(btn)
    } else if (issue.fix === 'restart') {
      // CLI 参数/命令错误：启动器启动前会自动适配参数（如 --no-open 探测），
      // 这里给出一键重启动作，让"检测出问题 → 直接修复"闭环。
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn btn-primary btn-mini'
      btn.textContent = '重新启动'
      btn.onclick = async () => {
        btn.disabled = true
        btn.textContent = '重启中…'
        const id = state.selectedTerminalId
        const terminal = state.terminals.find(item => item.id === id)
        const attached = terminal?.runtime?.ownership === 'attached'
        const r = await api.restart(id, { confirmAttached: attached })
        toast(r.message, r.ok ? '' : 'error')
        btn.disabled = false
        btn.textContent = '重新启动'
        if (r.ok) { renderRescueStatus(await api.rescueStatus(id)); renderRescueDiagnosis(await api.rescueDiagnose(id)) }
      }
      actions.appendChild(btn)
    } else if (issue.fix === 'install-deps') {
      // 源码形态缺 devDependency（如 tsx）：安装源码依赖（pnpm install）再重启。
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn btn-primary btn-mini'
      btn.textContent = '安装依赖并重启'
      btn.onclick = async () => {
        btn.disabled = true
        btn.textContent = '安装中…'
        const id = state.selectedTerminalId
        const r = await api.rescueInstallSourceDeps(id)
        toast(r.message, r.ok ? '' : 'error')
        btn.disabled = false
        btn.textContent = '安装依赖并重启'
        if (r.ok) { renderRescueStatus(await api.rescueStatus(id)); renderRescueDiagnosis(await api.rescueDiagnose(id)) }
      }
      actions.appendChild(btn)
    } else if (issue.fix === 'reinstall') {
      // bundle 版本不匹配：依赖层面的崩溃（.css / loader entry / prepare 未注册），
      // 光重启修不好，必须重装 profile 依赖（force 同步到与主包匹配版本）再重启。
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn btn-primary btn-mini'
      btn.textContent = '重装依赖并重启'
      btn.onclick = async () => {
        btn.disabled = true
        btn.textContent = '重装中…'
        const id = state.selectedTerminalId
        const r = await api.rescueReinstallBundles(id)
        toast(r.message, r.ok ? '' : 'error')
        btn.disabled = false
        btn.textContent = '重装依赖并重启'
        if (r.ok) { renderRescueStatus(await api.rescueStatus(id)); renderRescueDiagnosis(await api.rescueDiagnose(id)) }
      }
      actions.appendChild(btn)
    } else if (issue.fix === 'rebuild-source') {
      // DSH 更新回滚后源码/编译产物混装：只重装 profile 依赖救不了，必须 clean + 完整重建源码。
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn btn-primary btn-mini'
      btn.textContent = '重建源码并重启'
      btn.onclick = async () => {
        btn.disabled = true
        btn.textContent = '重建中（约几分钟）…'
        const id = state.selectedTerminalId
        const r = await api.rescueRebuildSource(id)
        toast(r.message, r.ok ? '' : 'error')
        btn.disabled = false
        btn.textContent = '重建源码并重启'
        if (r.ok) { renderRescueStatus(await api.rescueStatus(id)); renderRescueDiagnosis(await api.rescueDiagnose(id)) }
      }
      actions.appendChild(btn)
    }
    row.appendChild(actions)
    els.rescueIssues.appendChild(row)
  }
}
function confirm(title, message) { return new Promise((resolve) => { modalResolve = resolve; els.modalTitle.textContent = title; els.modalMessage.textContent = message; els.modal.hidden = false }) }
function closeModal(result) { els.modal.hidden = true; if (modalResolve) { const r = modalResolve; modalResolve = null; r(result) } }
// 空状态（白板）下用户主动点击的 tab：记录后 renderEmptyState 保持对应面板，
// 默认（未点击 / 点回 console）显示 empty 引导。修复"点不动"的同时保证打开是白板引导页。
let emptyTabOverride = ''
function switchTab(name) {
  // 1.0.0 修复：移除空状态拦截——空终端时点环境/救援 tab 也要能切换，
  // 否则"点了没反应"（0.6.30 同样存在，只是当时有终端未触发）。
  emptyTabOverride = name
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name))
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name))
  // 空状态（白板）下"控制台"没有可看内容，点它回到白板引导（否则用户找不到安装入口）
  if (name === 'console') {
    const current = state.terminals.find(item => item.id === state.selectedTerminalId)
    const isEmpty = !current || !current.dshDir || current.sourceType === 'fresh-empty' || current.sourceType === 'fresh-installed-empty'
    if (isEmpty) {
      const emptyPanel = document.querySelector('.panel[data-panel="empty"]')
      const consolePanel = document.querySelector('.panel[data-panel="console"]')
      if (emptyPanel) emptyPanel.classList.add('active')
      if (consolePanel) consolePanel.classList.remove('active')
    }
  }
  const a = document.querySelector(`.tab[data-tab="${name}"]`)
  if (a) { els.indicator.style.width = `${a.offsetWidth}px`; els.indicator.style.transform = `translateX(${a.offsetLeft}px)` }
}

// ---- 添加终端向导（入口随终端数量动态变化；复制功能已废案移除）----
const WIZARD_VIEWS = {
  menu() {
    els.wizardTitle.textContent = '添加终端'
    els.wizardBack.hidden = true
    const hasTerminal = (state.terminals || []).length > 0
    const fresh = `
      <div class="wizard-option" data-action="fresh">
        <div class="wizard-option-icon">⬇</div>
        <div class="wizard-option-copy"><strong>${hasTerminal ? '一键安装新的 DSH' : '一键全新安装'}</strong><span>下载官方最新版到独立环境，注入插件商店，全新干净</span></div>
        <span class="wizard-option-arrow">›</span>
      </div>`
    const scan = `
      <div class="wizard-option" data-action="scan">
        <div class="wizard-option-icon">⌕</div>
        <div class="wizard-option-copy"><strong>自动扫描已有 DSH</strong><span>检测本机已安装或正在运行的 Harness</span></div>
        <span class="wizard-option-arrow">›</span>
      </div>`
    const manual = `
      <div class="wizard-option" data-action="manual">
        <div class="wizard-option-icon">📁</div>
        <div class="wizard-option-copy"><strong>手动选择 DSH 目录</strong><span>在文件对话框中指定 Harness 根目录</span></div>
        <span class="wizard-option-arrow">›</span>
      </div>`
    const intro = hasTerminal
      ? '已有一个正常运转的 DSH。新终端环境可以这样建立：'
      : '首次使用：请选择如何接入第一个 DeepSeek Harness。'
    // 有终端：只留「一键安装新的」；首次使用：三入口
    els.wizardBody.innerHTML = `<div class="wizard-intro">${intro}</div>${fresh}${hasTerminal ? '' : scan + manual}`
    els.wizardBody.querySelectorAll('.wizard-option').forEach(option => {
      option.onclick = () => wizardAction(option.dataset.action)
    })
  },
  loading(text) {
    els.wizardTitle.textContent = text || '处理中…'
    els.wizardBack.hidden = false
    els.wizardBody.innerHTML = `<div class="wizard-loading"><span class="wizard-spinner"></span><span>正在${text || '处理'}，请稍候…</span></div>`
  },
  error(message) {
    els.wizardTitle.textContent = '无法继续'
    els.wizardBack.hidden = false
    els.wizardBody.innerHTML = `<div class="wizard-error">${escapeHtml(message || '发生未知错误')}</div>`
  },
}
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function openWizard() { els.wizard.hidden = false; WIZARD_VIEWS.menu() }
function closeWizard() { els.wizard.hidden = true }
async function wizardAction(action) {
  // 空终端页的「自动扫描/手动选择」按钮直接调用本函数，弹层必须确保可见，
  // 否则 loading/结果都渲染在隐藏层里，用户看到"点了没反应"。
  if (els.wizard) els.wizard.hidden = false
  if (action === 'fresh') {
    // 一键安装（1.0.2 用户要求：极简，无确认弹窗）：
    // 没有用户创建的 fresh-empty 空终端 → 直接弹文件夹选择（可新建），选完直接开始装；
    // 已有 fresh-empty 空终端（加号选过文件夹）→ 直接装到那里。
    const selected = state.terminals.find(t => t.id === state.selectedTerminalId)
    const hasEmptyTarget = selected && !selected.dshDir && (selected.sourceType === 'fresh-empty' || selected.sourceType === 'fresh-installed-empty')
    if (!hasEmptyTarget) {
      const created = await api.terminalCreateEmpty()
      if (!created || !created.ok) { toast(created && created.message || '选择安装位置失败', 'error'); return }
      if (created.existingDsh) { toast('所选目录已包含 DSH，已直接接入（不再安装）'); closeWizard(); await loadState(); return }
      await loadState()
    }
    els.wizard.hidden = true
    wizardInstall()
    return
  }
  if (action === 'scan') {
    WIZARD_VIEWS.loading('扫描本机 DSH 安装')
    const result = await api.terminalScan()
    if (!result || !result.ok) { WIZARD_VIEWS.error(result && result.message || '扫描失败'); return }
    const items = result.results || []
    if (!items.length) { WIZARD_VIEWS.error('未发现本机 DSH 安装，可尝试手动选择目录'); return }
    els.wizardTitle.textContent = '扫描结果'
    els.wizardBack.hidden = false
    els.wizardBody.innerHTML = `<div class="wizard-intro">找到 ${items.length} 个 DSH 安装。已登记的不能重复接入。</div>
      <div class="wizard-scan-list">${items.map(item => `
        <div class="wizard-scan-item ${item.registered ? 'is-registered' : ''}">
          <div class="wizard-scan-main">
            <strong>${escapeHtml(item.name)}</strong>
            <span class="wizard-scan-meta">${escapeHtml(item.version)} · ${escapeHtml(item.dir)}</span>
          </div>
          <div class="wizard-scan-side">
            <span class="wizard-chip ${item.source === 'running-process' ? 'chip-running' : 'chip-disk'}">${item.source === 'running-process' ? `运行中 · 端口 ${item.port || '?'}` : '本机目录'}</span>
            ${item.registered
              ? '<span class="wizard-chip chip-registered" title="' + escapeHtml(item.terminalId || '') + '">已登记</span>'
              : `<button class="btn btn-primary wizard-scan-connect" data-dir="${escapeHtml(item.dir)}" data-source="${escapeHtml(item.source)}" data-port="${item.port || ''}">接入</button>`}
          </div>
        </div>`).join('')}
      </div>`
    els.wizardBody.querySelectorAll('.wizard-scan-connect').forEach(button => {
      button.onclick = async () => {
        // 按钮本身就是明确的接入意图，不再弹多余确认框（用户反馈 0.6.20）
        const dir = button.dataset.dir
        const source = button.dataset.source
        const port = button.dataset.port ? Number(button.dataset.port) : undefined
        const options = { sourceType: source === 'running-process' ? 'attached' : source || 'manual' }
        if (port) options.port = port
        const result = await api.terminalConnectDirectory(dir, options)
        toast(result && result.message || '接入失败', result && result.ok ? '' : 'error')
        if (result && result.ok) { closeWizard(); await loadState() }
      }
    })
    return
  }
  if (action === 'manual') {
    WIZARD_VIEWS.loading('打开目录选择')
    const result = await api.terminalChooseDirectory()
    if (!result || result.canceled || !result.ok) { result && result.message && !result.canceled ? WIZARD_VIEWS.error(result.message) : WIZARD_VIEWS.menu(); return }
    const inspected = result.inspected
    // 用户已明确选择目录并点确认，不再弹多余确认框（用户反馈 0.6.20）
    WIZARD_VIEWS.loading('接入终端')
    const connected = await api.terminalConnectDirectory(inspected.dir, { sourceType: 'manual' })
    toast(connected && connected.message || '接入失败', connected && connected.ok ? '' : 'error')
    if (connected && connected.ok) { closeWizard(); await loadState() }
    else { WIZARD_VIEWS.menu() }
  }
}

// 一键全新安装：独立安装进度面板 + 实时日志事件流
let installVisible = false
async function wizardInstall() {
  installVisible = true
  const mask = els.wizard
  mask.hidden = false
  els.wizardTitle.textContent = '全新安装'
  els.wizardBack.hidden = true
  els.wizardBody.innerHTML = `
    <div class="wizard-intro">正在下载并安装 DeepSeek Harness 到独立目录。进度实时刷新：</div>
    <div class="wizard-install-log" id="wizard-install-log"><div class="wizard-install-empty">准备开始…</div></div>
    <div class="wizard-install-foot">离开此页不会中断安装。</div>`
  const logBox = els.wizardBody.querySelector('#wizard-install-log')
  const append = (stage, message) => {
    if (!installVisible) return
    const line = document.createElement('div')
    line.className = 'wizard-install-line'
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    line.innerHTML = `<span class="wizard-install-time"></span><span class="wizard-install-stage"></span><span class="wizard-install-msg"></span>`
    line.firstChild.textContent = time
    line.querySelector('.wizard-install-stage').textContent = `[${stage}]`
    line.lastChild.textContent = message
    logBox.appendChild(line)
    logBox.scrollTop = logBox.scrollHeight
  }
  // 订阅进度事件（一次性订阅，用完取消——preload 的 on* 现在返回取消函数，
  // 避免多次安装累积永久监听器导致泄漏/写入孤儿 DOM）
  const sub = payload => { if (payload && payload.kind === 'install') append(payload.stage || '…', payload.message || '') }
  const unsubscribe = api.onInstallProgress(sub)
  try {
    const result = await api.installFresh({ terminalId: state.selectedTerminalId })
    if (result && result.ok) {
      append('完成', result.message || '安装完成')
      toast(result.message || '全新安装完成', '')
      setTimeout(() => { if (installVisible) { closeWizard(); loadState() } }, 1200)
    } else {
      append('失败', (result && result.message) || '未知错误')
      toast((result && result.message) || '全新安装失败', 'error')
      els.wizardBack.hidden = false
      els.wizardBack.onclick = () => WIZARD_VIEWS.menu()
    }
  } catch (err) {
    // ★ 1.4.0（I4）：IPC reject 未捕获会让向导永远停在"准备开始…"——必须渲染错误
    const msg = (err && err.message) || String(err || '未知错误')
    append('失败', msg)
    toast(`全新安装失败：${msg}`, 'error')
    els.wizardBack.hidden = false
    els.wizardBack.onclick = () => WIZARD_VIEWS.menu()
  } finally {
    if (typeof unsubscribe === 'function') unsubscribe()
  }
}

async function init() {
  if (els.min) els.min.onclick = () => api.windowMinimize(); if (els.max) els.max.onclick = () => api.windowToggleMaximize(); if (els.close) els.close.onclick = () => api.windowClose();
  const titlebar = document.getElementById('titlebar'); if (titlebar) titlebar.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) api.windowToggleMaximize() })
  els.modalOk.onclick = () => closeModal(true); els.modalCancel.onclick = () => closeModal(false)
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab))
  els.start.onclick = async () => { const id = state.selectedTerminalId || state.currentEnv; const r = await api.start(id); toast(r.message, r.ok ? '' : 'error') }
  els.stop.onclick = async () => { const id = state.selectedTerminalId || state.currentEnv; const terminal = state.terminals.find(item => item.id === id); const attached = terminal?.runtime?.ownership === 'attached'; const message = attached ? `端口 ${terminal.port} 的 Harness 不是由 ZAT 启动。确定停止这个外部进程吗？` : `确定停止端口 ${terminal ? terminal.port : state.paths.port} 的终端吗？`; if (await confirm('停止终端', message)) { const r = await api.stop(id, { confirmAttached: attached }); toast(r.message, r.ok ? '' : 'error') } }
  els.restart.onclick = async () => { const id = state.selectedTerminalId || state.currentEnv; const terminal = state.terminals.find(item => item.id === id); const attached = terminal?.runtime?.ownership === 'attached'; const message = attached ? `端口 ${terminal.port} 的 Harness 不是由 ZAT 启动。确定停止外部进程并由 ZAT 重新启动吗？` : `确定重启端口 ${terminal ? terminal.port : state.paths.port} 的终端吗？`; if (await confirm('重启终端', message)) { const r = await api.restart(id, { confirmAttached: attached }); toast(r.message, r.ok ? '' : 'error') } }
  els.open.onclick = async () => { const id = state.selectedTerminalId || state.currentEnv; const r = await api.openWeb(id); toast(r.message, r.ok ? '' : 'error') }
  if (els.autoRestart) els.autoRestart.onchange = () => api.setSettings({ autoRestart: els.autoRestart.checked }); if (els.autoOpen) els.autoOpen.onchange = () => api.setSettings({ autoOpen: els.autoOpen.checked })
  els.clear.onclick = async () => {
    const id = state.selectedTerminalId || state.currentEnv
    const seq = selectionSeq
    const r = await api.clearLogs(id)
    if (!r.ok) return toast(r.message, 'error')
    if (state.selectedTerminalId === id && seq === selectionSeq) renderLogs([])
  }
  els.copy.onclick = async () => {
    const text = state.logs.filter(logVisible).map(e => `[${e.time}] ${e.text}`).join('\n')
    try { await api.copyText(text); toast('日志已复制') } catch { toast('复制失败，请手动选中文本', 'error') }
  }
  els.envSwitch.onclick = () => toggleEnvMenu()
  // 点击菜单外部关闭
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#terminal-select-wrap')) closeEnvMenu()
  })
  // 关闭启动器提醒：还有未关闭的终端；确认 = 停止所有终端并关闭，取消 = 保持运行
  if (api.onQuitRequest) api.onQuitRequest(async count => {
    if (!await confirm('还有终端正在运行', `当前仍有 ${count} 个终端在运行。\n\n点「确认」将停止这些终端并关闭启动器；\n点「取消」则什么都不动，终端继续运行，启动器保持打开。`)) { api.quitCancelled(); return }
    api.quitConfirmed()
  })
  // 点加号：直接让用户选/新建一个文件夹作为新终端环境 → 创建空终端并切换到它的空状态页
  if (els.addTerminal) els.addTerminal.onclick = async () => {
    const r = await api.terminalCreateEmpty()
    if (!r || r.canceled) { if (r && r.message) toast(r.message, '') ; return }
    if (!r.ok) { toast(r && r.message || '创建失败', 'error'); return }
    toast(r.message, '')
    await loadState()
  }
  // 空状态页按钮：一键安装 / 扫描 / 手动
  // 一键安装（1.0.2 用户要求：极简无弹窗）：
  // 没有 fresh-empty 空终端 → 直接弹文件夹选择（可新建），选完直接装；
  // 有 fresh-empty 空终端 → 直接装到那里。无任何确认弹窗。
  if (els.emptyInstall) els.emptyInstall.onclick = async () => {
    const selected = state.terminals.find(t => t.id === state.selectedTerminalId)
    const hasEmptyTarget = selected && !selected.dshDir && (selected.sourceType === 'fresh-empty' || selected.sourceType === 'fresh-installed-empty')
    if (!hasEmptyTarget) {
      const created = await api.terminalCreateEmpty()
      if (!created || !created.ok) { toast(created && created.message || '选择安装位置失败', 'error'); return }
      if (created.existingDsh) { toast('所选目录已包含 DSH，已直接接入（不再安装）'); await loadState(); return }
      await loadState()
    }
    wizardInstall()
  }
  if (els.emptyScan) els.emptyScan.onclick = () => wizardAction('scan')
  if (els.emptyManual) els.emptyManual.onclick = () => wizardAction('manual')
  if (els.wizardClose) els.wizardClose.onclick = () => closeWizard()
  if (els.wizardBack) els.wizardBack.onclick = () => WIZARD_VIEWS.menu()
  // 插件商店：固定内置组件，只提供注入/修复，不提供用户移除
  if (els.engineCheck) els.engineCheck.onclick = () => checkEngineUpdate()
  if (els.engineInject) els.engineInject.onclick = async () => {
    const id = state.selectedTerminalId
    if (!id) return toast('请先选择终端', 'error')
    const seqAtClick = selectionSeq
    if (!await confirm('安装固定插件商店', 'zat-dsh-engine 是启动器的固定内置组件，将从官方源（国内镜像回退）下载并安装到当前终端。确定继续？')) return
    els.engineInject.disabled = true
    els.engineInject.textContent = '安装中…'
    try {
      const r = await api.engineInstall(id)
      toast(r && r.message || '插件商店已安装', r && r.ok ? '' : 'error')
      if (state.selectedTerminalId === id && seqAtClick === selectionSeq) renderEngineStatus(await api.engineStatus(id))
    } finally {
      els.engineInject.disabled = false
      els.engineInject.textContent = '安装插件商店'
    }
  }
  if (els.rescueCreate) els.rescueCreate.onclick = async () => {
    const id = state.selectedTerminalId
    if (!id) return toast('请先选择终端', 'error')
    const seqAtClick = selectionSeq
    const r = await api.rescueCreate(id)
    toast(r.message, r.ok ? '' : 'error')
    if (r.ok && state.selectedTerminalId === id && seqAtClick === selectionSeq) renderRescueStatus(await api.rescueStatus(id))
  }
  if (els.rescueDiagnose) els.rescueDiagnose.onclick = async () => {
    const id = state.selectedTerminalId
    if (!id) return toast('请先选择终端', 'error')
    const seqAtClick = selectionSeq
    els.rescueDiagnose.disabled = true
    els.rescueDiagnose.textContent = '检测中…'
    try {
      const r = await api.rescueDiagnose(id)
      if (state.selectedTerminalId !== id || seqAtClick !== selectionSeq) return
      if (els.rescueDiagnoseDetail) els.rescueDiagnoseDetail.textContent = r.message || ''
      renderRescueDiagnosis(r)
      toast(r.message, r.issues && r.issues.length ? '' : '')
    } finally {
      els.rescueDiagnose.disabled = false
      els.rescueDiagnose.textContent = '一键检测'
    }
  }
  if (els.rescueCopyLog) els.rescueCopyLog.onclick = async () => {
    const text = crashRecordText(state.lastRescueDiagnosis)
    if (!text) return toast('当前没有可复制的崩溃记录', 'error')
    try { await api.copyText(text); toast('完整崩溃记录已复制') } catch { toast('复制失败，请手动选中文本', 'error') }
  }
  if (els.removeTerminal) els.removeTerminal.onclick = async () => {
    const id = state.selectedTerminalId
    const terminal = state.terminals.find(item => item.id === id)
    if (!terminal) return
    const running = terminal.runtime && (terminal.runtime.running || terminal.runtime.starting)
    const runWarn = running ? '\n\n注意：该终端正在运行，删除时会先停止它。' : ''
    const p3080 = terminal.port === 3080 || (terminal.runtime && terminal.runtime.ownership === 'attached' && terminal.port === 3080)
    const dshWarn = p3080 ? '\n\n警告：:3080 是当前 DeepSeek Harness 对话的宿主，删除会停止它并中断正在进行的对话！' : ''
    if (!await confirm('删除终端及文件', `确定彻底删除「${terminal.name} · :${terminal.port}」吗？\n\n将删除：终端登记、运行进程、安装目录文件夹、日志、对话记录。\n与其他终端共享的路径会被保护，不会删除。${runWarn}${dshWarn}`)) return
    // 删除中：按钮保持 "−"，进度由 terminal:deleting 事件实时更新（替换式 toast，
    // 显示"已删除 N/M 个文件"，删干净才提示完成——不糊弄、不假成功）。
    els.removeTerminal.disabled = true
    deleteToast(`正在删除「${terminal.name}」…`)
    try {
      const result = await api.envRemove(id)
      clearDeleteToast()
      toast(result.message, result.ok ? '' : 'error')
      if (result.ok) await loadState()
    } finally {
      els.removeTerminal.disabled = false
    }
  }
  if (els.checkUpdate) els.checkUpdate.onclick = async () => {
    const id = state.selectedTerminalId
    if (!id) return toast('请先选择终端', 'error')
    const seqAtClick = selectionSeq
    els.checkUpdate.disabled = true
    els.checkUpdate.textContent = '检查中…'
    try {
      const timeout = new Promise(resolve => setTimeout(() => resolve({ ok: true, checkFailed: true, message: '网络连接超时，可稍后重试' }), 12000))
      const result = await Promise.race([api.harnessCheckUpdate(id), timeout])
      if (state.selectedTerminalId !== id || seqAtClick !== selectionSeq) return // 已切换终端，丢弃过期结果
      renderHarnessInfo(result)
      toast(result.message, result.checkFailed ? 'error' : '')
    } catch {
      if (state.selectedTerminalId !== id || seqAtClick !== selectionSeq) return
      renderHarnessInfo({ ok: true, checkFailed: true, message: '更新检查失败，可稍后重试' })
      toast('更新检查失败，可稍后重试', 'error')
    } finally {
      els.checkUpdate.disabled = false
      els.checkUpdate.textContent = '检查更新'
    }
  }
  if (els.installUpdate) els.installUpdate.onclick = async () => {
    const id = state.selectedTerminalId
    if (!id) return toast('请先选择终端', 'error')
    const seqAtClick = selectionSeq
    const info = state.harnessInfo || {}
    const terminal = state.terminals.find(item => item.id === id)
    const running = terminal && terminal.runtime && (terminal.runtime.running || terminal.runtime.starting || terminal.runtime.stopping)
    const runNote = running ? '\n\n当前终端正在运行：直接尝试热更新，不停止终端（若文件被占用会在日志说明）。' : ''
    const dirtyNote = info.dirty ? `\n\n检测到 ${info.dirtyCount} 项本地修改。按你的要求：更新到官方版本，本地修改先自动暂存（git stash 留作备份，不再自动恢复）。` : ''
    if (!await confirm('安装 Harness 更新', `确定将当前终端从 ${info.version || '当前版本'} 更新到 ${info.remoteVersion || '远端版本'} 吗？${runNote}${dirtyNote}`)) return
    els.installUpdate.disabled = true
    els.installUpdate.textContent = '安装中…'
    const result = await api.harnessInstallUpdate(id)
    if (state.selectedTerminalId !== id || seqAtClick !== selectionSeq) return
    renderHarnessInfo(result)
    toast(result.message, result.ok ? '' : 'error')
    els.installUpdate.textContent = '安装更新'
  }
  if (els.launcherCheckUpdate) els.launcherCheckUpdate.onclick = async () => {
    const label = els.launcherCheckUpdate.textContent
    els.launcherCheckUpdate.disabled = true
    els.launcherCheckUpdate.textContent = '检查中…'
    try {
      const timeout = new Promise(resolve => setTimeout(() => resolve({ ok: false, checkFailed: true, version: '1.0.4' }), 12000))
      const result = await Promise.race([api.launcherCheckUpdate(), timeout])
      renderLauncherUpdate(result)
      if (result.updateAvailable && result.url) {
        if (await confirm('发现新版本', `启动器有新版本 ${result.remoteVersion}。\n\n${result.notes || ''}\n\n打开下载页面？`)) {
          try { await api.openUrl(result.url) } catch { toast('无法打开下载页，请复制链接手动下载', 'error') }
        }
      } else {
        toast(result.updateAvailable ? '发现新版本' : (result.ok ? '已是最新版本' : (result.notConfigured ? '未配置更新源' : '检查失败')), result.ok ? '' : 'error')
      }
    } finally {
      els.launcherCheckUpdate.disabled = false
      els.launcherCheckUpdate.textContent = label
    }
  }
  els.checkEnv.onclick = async () => { const id = state.selectedTerminalId; const seq = selectionSeq; const v = await api.checkEnv(); if (state.selectedTerminalId === id && seq === selectionSeq) renderEnv(v) }
  els.repairEnv.onclick = async () => { const id = state.selectedTerminalId; const seq = selectionSeq; const v = await api.repairEnv(); if (state.selectedTerminalId === id && seq === selectionSeq) renderEnv(v) }
  els.chooseDsh.onclick = async () => { const r = await api.chooseDshDir(); toast(r.message, r.ok ? '' : 'error'); if (r.ok) loadState() }
  api.onLog((entry) => { if (entry && entry.terminalId && entry.terminalId === state.selectedTerminalId) appendLog(entry) })
  api.onStatus(renderStatus)
  if (api.onTerminalStatus) api.onTerminalStatus(renderTerminalSnapshot)
  api.onSettings(s => { state.settings = s; if (els.autoRestart) els.autoRestart.checked = !!s.autoRestart; if (els.autoOpen) els.autoOpen.checked = !!s.autoOpen })
  api.onLogsCleared((ev) => { if (ev && ev.terminalId && ev.terminalId === state.selectedTerminalId) renderLogs([]) })
  if (api.onTerminalDeleting) api.onTerminalDeleting(p => {
    if (!p) return
    if (p.deleting) deleteToast(p.message || '正在删除…')
    else clearDeleteToast()
  })
  api.onWindowMaximized(v => document.body.classList.toggle('maximized', !!v))
  await loadState()
  const bootSeq = selectionSeq
  const bootEnv = await api.checkEnv()
  if (bootSeq === selectionSeq) renderEnv(bootEnv)
  // 自动更新检查：启动器自身（8 秒后）+ 当前终端 DSH（6 秒后），有新版本自动提示
  autoCheckLauncherUpdate()
  scheduleAutoHarnessUpdateCheck()
  const tick = () => { const d = new Date(); els.clock.textContent = d.toLocaleTimeString('zh-CN', { hour12: false }) }; tick(); setInterval(tick, 1000)
}
async function loadState() {
  const s = await api.getState(); if (!s || !s.ok) return
  renderLogs(s.logs); renderPaths(s.paths); renderEnvs(s.environments, s.currentEnv)
  if (s.terminalRegistry) renderTerminalSnapshot(s.terminalRegistry); else renderStatus(s.status)
  state.settings = s.settings
  if (els.autoRestart) els.autoRestart.checked = !!s.settings.autoRestart
  if (els.autoOpen) els.autoOpen.checked = !!s.settings.autoOpen
  if (els.version) els.version.textContent = `v${s.version || '1.0.4'}`
  const tid = state.selectedTerminalId
  if (api.harnessInfo && tid) { const v = await api.harnessInfo(tid); if (state.selectedTerminalId === tid) renderHarnessInfo(v) }
  if (api.engineStatus && tid) { const v = await api.engineStatus(tid); if (state.selectedTerminalId === tid) renderEngineStatus(v) }
  if (api.rescueStatus && tid) { const v = await api.rescueStatus(tid); if (state.selectedTerminalId === tid) renderRescueStatus(v) }
  // 环境面板（端口/目录/Node 等）也必须随终端刷新，否则接入/切换后显示陈旧快照
  if (api.checkEnv) { const v = await api.checkEnv(); if (state.selectedTerminalId === tid) renderEnv(v) }
  const cur = state.terminals.find(item => item.id === state.selectedTerminalId); renderEmptyState(cur)
}

// 终端状态/运行时变化时延迟刷新环境面板（端口行实时反映，防抖避免高频监控刷屏）
let envRefreshTimer = null
function scheduleEnvRefresh() {
  if (envRefreshTimer || !api.checkEnv) return
  envRefreshTimer = setTimeout(async () => {
    envRefreshTimer = null
    const tid = state.selectedTerminalId
    const v = await api.checkEnv()
    if (state.selectedTerminalId === tid) renderEnv(v)
  }, 1200)
}
document.addEventListener('DOMContentLoaded', init)
