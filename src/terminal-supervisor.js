'use strict'

const net = require('node:net')
const http = require('node:http')
const { EventEmitter } = require('node:events')

function probeHostPort(port, host, timeoutMs) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port })
    let settled = false
    const done = listening => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function probePort(port, host = '', timeoutMs = 800) {
  if (host) return probeHostPort(port, host, timeoutMs)
  const ipv4 = await probeHostPort(port, '127.0.0.1', timeoutMs)
  if (ipv4) return true
  return probeHostPort(port, '::1', timeoutMs)
}

function probeHttp(port, timeoutMs = 4000) {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { if (body.length < 65536) body += chunk })
      response.on('end', () => {
        const text = `${body} ${JSON.stringify(response.headers)}`.toLowerCase()
        // ★ 1.3.1：新版 DSH（0.1.2-alpha.1+）web 需 token 鉴权——根路径返回 401
        //   「dsh web authentication required; reopen the URL printed by dsh web.」
        //   旧标记（deepseek/__dsh_boot__/harness）匹配不了 401 响应，会误判"非 Harness
        //   服务占用"→ 端口冲突刷屏 + 启动超时失败。'dsh web' 是该响应正文的固有字样。
        const harness = text.includes('deepseek') || text.includes('__dsh_boot__') || text.includes('harness') || text.includes('dsh web')
        resolve({ healthy: response.statusCode >= 200 && response.statusCode < 500, harness, statusCode: response.statusCode })
      })
    })
    request.once('timeout', () => { request.destroy(); resolve({ healthy: false, harness: false, statusCode: 0 }) })
    request.once('error', () => resolve({ healthy: false, harness: false, statusCode: 0 }))
  })
}

function initialRuntime(terminalId) {
  return {
    terminalId,
    state: 'checking',
    ownership: 'managed',
    pid: null,
    childProcess: null,
    portListening: false,
    httpHealthy: false,
    harnessConfirmed: false,
    starting: false,
    stopping: false,
    manualStop: false,
    lastCheckedAt: 0,
    lastChangedAt: Date.now(),
    activeMs: 0,
    activeSince: 0,
    logs: [],
    generation: 0,
    cancelRequested: false,
    restartTimer: null,
    monitorTimer: null,
    probeInFlight: false,
    // 崩溃自动重启的连续计数（成功启动后归零，防止无限崩溃循环）
    autoRestartCount: 0,
    // 已通过 managedPid 匹配确认为「自己的 detached 进程」的 PID 缓存（重启后识别用）
    recognizedOwnPid: null,
  }
}

class TerminalSupervisor extends EventEmitter {
  constructor(options = {}) {
    super()
    this.registry = options.registry
    this.probePort = options.probePort || probePort
    this.probeHttp = options.probeHttp || probeHttp
    this.resolvePortPid = options.resolvePortPid || null
    this.identifyHarness = options.identifyHarness || null // (pid) => Promise<boolean>：按进程 cmdline 识别 DSH
    this.intervalMs = options.intervalMs || 2000
    this.runtimes = new Map()
  }

  ensure(terminalId) {
    if (!this.runtimes.has(terminalId)) this.runtimes.set(terminalId, initialRuntime(terminalId))
    return this.runtimes.get(terminalId)
  }

  get(terminalId) { return this.ensure(terminalId) }
  list() { return this.registry.list().map(terminal => this.publicRuntime(terminal.id)) }

  publicRuntime(terminalId) {
    const runtime = this.ensure(terminalId)
    return {
      terminalId,
      state: runtime.state,
      ownership: runtime.ownership,
      pid: runtime.pid,
      portListening: runtime.portListening,
      httpHealthy: runtime.httpHealthy,
      harnessConfirmed: runtime.harnessConfirmed,
      starting: runtime.starting,
      stopping: runtime.stopping,
      running: runtime.state === 'running' || runtime.state === 'attached-running',
      lastCheckedAt: runtime.lastCheckedAt,
      lastChangedAt: runtime.lastChangedAt,
      activeMs: runtime.activeMs,
      activeSince: runtime.activeSince,
      uptimeMs: runtime.activeMs + (runtime.activeSince ? Date.now() - runtime.activeSince : 0),
    }
  }

  // 从 registry 恢复累计运行时长（重启后继续），并结算当前会话到 activeMs
  restoreActiveMs(terminalId, ms) {
    const runtime = this.ensure(terminalId)
    runtime.activeMs = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : 0
    runtime.activeSince = 0
    return runtime.activeMs
  }

  // 结算当前会话时长到 activeMs（停止/持久化前调用）
  settleActive(terminalId) {
    const runtime = this.ensure(terminalId)
    if (runtime.activeSince) {
      runtime.activeMs += Date.now() - runtime.activeSince
      runtime.activeSince = 0
    }
    return runtime.activeMs
  }

  appendLog(terminalId, entry) {
    const runtime = this.ensure(terminalId)
    runtime.logs.push(entry)
    // 内存日志只保留最近 300 条（完整历史在磁盘 launcher.log；以前 3000 条
    // 每次 state:get 全量传给渲染端，纯浪费资源）
    if (runtime.logs.length > 300) runtime.logs.splice(0, runtime.logs.length - 300)
    this.emit('log', { terminalId, entry })
  }

  setManagedProcess(terminalId, childProcess) {
    const runtime = this.ensure(terminalId)
    runtime.generation += 1
    runtime.cancelRequested = false
    runtime.childProcess = childProcess || null
    runtime.pid = childProcess && childProcess.pid || null
    runtime.ownership = 'managed'
    runtime.recognizedOwnPid = null
    return runtime.generation
  }

  setTransition(terminalId, patch) {
    const runtime = this.ensure(terminalId)
    Object.assign(runtime, patch)
    this.publishIfChanged(terminalId, runtime.state)
  }

  publishIfChanged(terminalId, previousState) {
    const runtime = this.ensure(terminalId)
    if (runtime.state !== previousState) runtime.lastChangedAt = Date.now()
    this.emit('status', { terminalId, runtime: this.publicRuntime(terminalId) })
  }

  async check(terminalId) {
    const terminal = this.registry.get(terminalId)
    if (!terminal) return null
    const runtime = this.ensure(terminalId)
    if (runtime.probeInFlight) return this.publicRuntime(terminalId)
    runtime.probeInFlight = true
    const previousState = runtime.state
    try {
      const listening = await this.probePort(terminal.port)
      const httpStatus = listening ? await this.probeHttp(terminal.port) : { healthy: false, harness: false, statusCode: 0 }
      runtime.portListening = listening
      runtime.httpHealthy = !!httpStatus.healthy
      // ★ 1.3.1：HTTP 标记识别不了时（新版 DSH 的 token 鉴权 401 页 / 未来其他鉴权页），
      //   用监听进程 cmdline 兜底识别——node .../bin.js web（或含 dsh/deepseek-harness）必然是 DSH，
      //   避免把在跑的 DSH 误判成"非 Harness 服务占用"（端口冲突刷屏 / 启动超时失败）。
      let isHarness = !!httpStatus.harness
      if (!isHarness && listening && this.identifyHarness && this.resolvePortPid) {
        try {
          const pid = await this.resolvePortPid(terminal.port)
          if (Number.isSafeInteger(pid) && pid > 0) isHarness = await this.identifyHarness(pid)
        } catch { /* 兜底失败按 HTTP 结果处理 */ }
      }
      // 曾确认是 Harness 的端口：探测暂时失败时保持 attached（连续失败 3 次才降级为冲突），
      // 避免"端口冲突"误报与状态跳动（源码版 DSH 首页响应慢会偶发超时）
      const wasConfirmed = runtime.harnessConfirmed
      runtime.harnessConfirmed = isHarness
      runtime.lastCheckedAt = Date.now()

      if (runtime.stopping) runtime.state = 'stopping'
      else if (runtime.starting && !isHarness) runtime.state = listening ? 'checking-http' : 'waiting-port'
      else if (isHarness) {
        runtime.httpFailStreak = 0
        // 归属判定：持有 live childProcess 句柄 = 本实例启动；否则若登记了 managedPid，
        // 用监听端口的真实 PID 匹配（重启后识别自己 detach 出去的终端，避免误判为外部接入）。
        let managed = !!runtime.childProcess
        if (!managed && !runtime.recognizedOwnPid && terminal.managedPid && this.resolvePortPid) {
          try {
            const pid = await this.resolvePortPid(terminal.port)
            if (Number.isSafeInteger(pid) && pid === Number(terminal.managedPid)) {
              managed = true
              runtime.pid = pid
              runtime.recognizedOwnPid = pid
            }
          } catch { /* 探测失败按外部处理 */ }
        } else if (runtime.recognizedOwnPid && Number(runtime.recognizedOwnPid) === Number(terminal.managedPid)) {
          managed = true
        }
        runtime.state = managed ? 'running' : 'attached-running'
        runtime.ownership = managed ? 'managed' : 'attached'
        runtime.starting = false
      } else if (listening) {
        runtime.httpFailStreak = (runtime.httpFailStreak || 0) + 1
        if (wasConfirmed && runtime.httpFailStreak < 3) {
          runtime.state = 'attached-running'
          runtime.ownership = 'attached'
          runtime.harnessConfirmed = true
        } else {
          runtime.state = 'port-conflict'
        }
      }
      else if (runtime.childProcess && runtime.childProcess.exitCode === null) runtime.state = 'degraded'
      else {
        runtime.state = terminal.dshDir ? 'stopped' : 'unconfigured'
        runtime.recognizedOwnPid = null
        if (!runtime.childProcess) runtime.pid = null
      }

      // 每个终端独立累计运行时长：运行中记 activeSince，停止时结算进 activeMs
      const runningNow = runtime.state === 'running' || runtime.state === 'attached-running'
      if (runningNow) {
        if (!runtime.activeSince) runtime.activeSince = Date.now()
      } else if (runtime.activeSince) {
        runtime.activeMs += Date.now() - runtime.activeSince
        runtime.activeSince = 0
      }

      this.publishIfChanged(terminalId, previousState)
      return this.publicRuntime(terminalId)
    } finally {
      runtime.probeInFlight = false
    }
  }

  startMonitoring(terminalId) {
    const runtime = this.ensure(terminalId)
    if (runtime.monitorTimer) return
    this.check(terminalId)
    runtime.monitorTimer = setInterval(() => this.check(terminalId), this.intervalMs)
  }

  monitorAll() { for (const terminal of this.registry.list()) this.startMonitoring(terminal.id) }

  stopMonitoring(terminalId) {
    const runtime = this.runtimes.get(terminalId)
    if (!runtime || !runtime.monitorTimer) return
    clearInterval(runtime.monitorTimer)
    runtime.monitorTimer = null
  }

  dispose() {
    for (const id of this.runtimes.keys()) this.stopMonitoring(id)
    this.removeAllListeners()
  }
}

module.exports = { TerminalSupervisor, probePort, probeHttp, initialRuntime }
