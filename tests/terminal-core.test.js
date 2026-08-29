'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { TerminalRegistry, assertPathInside } = require('../src/terminal-registry')
const { TerminalSupervisor } = require('../src/terminal-supervisor')
const { parseNetstatListeningPids } = require('../src/windows-process')
const { checkUpdate, installUpdate, updateSources } = require('../src/harness-update')

function temporaryRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-registry-'))
  return { dir, registry: new TerminalRegistry(path.join(dir, 'terminals.json')) }
}

test('registry persists independent terminals and stable selection', () => {
  const { dir, registry } = temporaryRegistry()
  try {
    const first = registry.add({ name: '主环境', port: 3080, dshDir: 'D:\\dsh-a', dshHome: 'D:\\home-a' })
    const second = registry.add({ name: '项目 B', port: 3081, dshDir: 'D:\\dsh-b', dshHome: 'D:\\home-b' })
    registry.select(second.id)
    const loaded = new TerminalRegistry(registry.filePath)
    loaded.load()
    assert.equal(loaded.list().length, 2)
    assert.equal(loaded.selectedTerminalId, second.id)
    assert.notEqual(first.id, second.id)
    assert.notEqual(loaded.get(first.id).dshHome, loaded.get(second.id).dshHome)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('registry save merges concurrent instances without overwriting each other', () => {
  const { dir, registry } = temporaryRegistry()
  try {
    // 实例 A：登记终端 A（3080）
    registry.add({ id: 'term-a', name: 'A', port: 3080, dshDir: 'D:\\dsh-a' })
    // 实例 B：独立加载同一文件，登记终端 B（3081）
    const registryB = new TerminalRegistry(registry.filePath)
    registryB.load()
    registryB.add({ id: 'term-b', name: 'B', port: 3081, dshDir: 'D:\\dsh-b' })
    // 实例 A 再次保存（此时磁盘上有 B 的改动，A 的内存里没有 B）
    registry.select('term-a')
    registry.save()
    // 磁盘上两个终端都应存在（A 的保存不能覆盖 B）
    const after = new TerminalRegistry(registry.filePath)
    after.load()
    assert.equal(after.list().length, 2)
    assert.ok(after.get('term-a'))
    assert.ok(after.get('term-b'))
    assert.equal(after.get('term-b').dshDir, 'D:\\dsh-b')
    // 实例 B 再保存也不覆盖 A
    registryB.select('term-b')
    registryB.save()
    const final = new TerminalRegistry(registry.filePath)
    final.load()
    assert.equal(final.list().length, 2)
    assert.ok(final.get('term-a'))
    assert.ok(final.get('term-b'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('registry rejects duplicate ports and allocates next safe port', () => {
  const { dir, registry } = temporaryRegistry()
  try {
    registry.add({ port: 3080 })
    assert.throws(() => registry.add({ port: 3080 }), /端口 3080/)
    const unavailable = new Set([3081, 3083])
    assert.equal(registry.allocatePort(port => unavailable.has(port)), 3082)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('path guard rejects root and paths outside terminal root', () => {
  const root = path.resolve('C:\\terminals\\one')
  assert.throws(() => assertPathInside(root, root), /不在允许/)
  assert.throws(() => assertPathInside(root, 'C:\\terminals\\two\\data'), /不在允许/)
  assert.equal(assertPathInside(root, path.join(root, 'snapshots', 'good')), path.join(root, 'snapshots', 'good'))
})

test('supervisor keeps logs isolated per terminal', () => {
  const { dir, registry } = temporaryRegistry()
  try {
    const a = registry.add({ port: 3080 })
    const b = registry.add({ port: 3081 })
    const supervisor = new TerminalSupervisor({ registry })
    supervisor.appendLog(a.id, { text: 'alpha' })
    supervisor.appendLog(b.id, { text: 'beta' })
    supervisor.get(a.id).logs.length = 0
    assert.equal(supervisor.get(a.id).logs.length, 0)
    assert.deepEqual(supervisor.get(b.id).logs.map(entry => entry.text), ['beta'])
    supervisor.dispose()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('supervisor increments generation for each managed process', () => {
  const { dir, registry } = temporaryRegistry()
  try {
    const terminal = registry.add({ port: 3080, dshDir: 'D:\\dsh-a' })
    const supervisor = new TerminalSupervisor({ registry })
    const first = supervisor.setManagedProcess(terminal.id, { pid: 1001 })
    const second = supervisor.setManagedProcess(terminal.id, { pid: 1002 })
    assert.equal(first, 1)
    assert.equal(second, 2)
    assert.equal(supervisor.get(terminal.id).pid, 1002)
    supervisor.dispose()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('netstat parser matches only the exact listening port and valid PID', () => {
  const sample = `
  TCP    127.0.0.1:3080      0.0.0.0:0       LISTENING       1234
  TCP    0.0.0.0:30800       0.0.0.0:0       LISTENING       9999
  TCP    [::]:3080           [::]:0          LISTENING       5678
  TCP    127.0.0.1:3080      127.0.0.1:50000 TIME_WAIT       0
  TCP    127.0.0.1:3080      0.0.0.0:0       LISTENING       0
  `
  assert.deepEqual(parseNetstatListeningPids(sample, 3080), [1234, 5678])
})

test('Harness update sources prefer official and include domestic fallbacks', () => {
  const sources = updateSources('https://github.com/deepseek-ai/deepseek-harness.git')
  assert.equal(sources[0], 'https://github.com/deepseek-ai/deepseek-harness.git')
  assert.equal(sources.length, 5)
  assert.ok(sources[1].includes('ghfast.top'))
  assert.ok(sources[2].includes('gh-proxy.com'))
  assert.ok(sources[3].includes('ghproxy.net'))
  assert.ok(sources[4].includes('gh.llkk.cc'))
})

test('Harness update check allows install when source has local changes (stash-backed)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-harness-update-'))
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.1.0-rc.5' }))
    const execute = async (_file, args, _cwd, timeout) => {
      const command = args.join(' ')
      if (command === 'rev-parse --short HEAD') return { ok: true, out: 'abc1234', err: '' }
      if (command === 'branch --show-current') return { ok: true, out: 'master', err: '' }
      if (command === 'status --porcelain') return { ok: true, out: ' M local.js', err: '' }
      if (command === 'remote get-url origin') return { ok: true, out: 'https://github.com/deepseek-ai/deepseek-harness.git', err: '' }
      if (command.startsWith('fetch --force --no-tags ')) { assert.equal(timeout, 3000); return { ok: true, out: '', err: '' } }
      if (command === 'rev-parse --short refs/remotes/zat-update/master') return { ok: true, out: 'def5678', err: '' }
      if (command === 'rev-list --count HEAD..refs/remotes/zat-update/master') return { ok: true, out: '3', err: '' }
      if (command === 'show refs/remotes/zat-update/master:package.json') return { ok: true, out: JSON.stringify({ version: '0.1.0-rc.6' }), err: '' }
      return { ok: false, out: '', err: `unexpected ${command}` }
    }
    const result = await checkUpdate(dir, execute)
    assert.equal(result.updateAvailable, true)
    assert.equal(result.remoteVersion, '0.1.0-rc.6')
    assert.equal(result.behindCount, 3)
    assert.equal(result.dirty, true)
    // 本地修改不再阻止安装：更新器会先 stash 暂存备份，完成后恢复
    assert.equal(result.canInstall, true)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('Harness update install stashes local changes, keeps official version per user choice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-harness-install-'))
  const commands = []
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.1.0-rc.5' }))
    const execute = async (_file, args, _cwd, timeout) => {
      const command = args.join(' ')
      commands.push(command)
      if (command === 'rev-parse --short HEAD') return { ok: true, out: 'abc1234', err: '' }
      if (command === 'rev-parse HEAD') return { ok: true, out: 'abc1234', err: '' }
      if (command === 'branch --show-current') return { ok: true, out: 'master', err: '' }
      if (command === 'status --porcelain') return { ok: true, out: ' M local.js', err: '' }
      if (command === 'remote get-url origin') return { ok: true, out: 'https://github.com/deepseek-ai/deepseek-harness.git', err: '' }
      if (command.startsWith('fetch --force --no-tags ')) return { ok: true, out: '', err: '' }
      if (command === 'rev-parse --short refs/remotes/zat-update/master') return { ok: true, out: 'def5678', err: '' }
      if (command === 'rev-list --count HEAD..refs/remotes/zat-update/master') return { ok: true, out: '3', err: '' }
      if (command === 'show refs/remotes/zat-update/master:package.json') return { ok: true, out: JSON.stringify({ version: '0.1.0-rc.6' }), err: '' }
      if (command.startsWith('stash push --include-untracked -m zat-update-')) return { ok: true, out: '', err: '' }
      if (command === 'merge --ff-only refs/remotes/zat-update/master') return { ok: true, out: '', err: '' }
      if (command === 'install --frozen-lockfile') return { ok: true, out: '', err: '' }
      if (command === 'run build') return { ok: true, out: '', err: '' }
      return { ok: false, out: '', err: `unexpected ${command}` }
    }
    const result = await installUpdate(dir, path.join(dir, 'snap'), execute, { pnpmExe: 'pnpm' })
    assert.equal(result.ok, true)
    assert.ok(commands.some(c => c.startsWith('stash push --include-untracked -m')))
    // 用户选择保留官方版本：成功后不 stash pop、不提示保留
    assert.ok(!commands.includes('stash pop'))
    assert.ok(result.message.includes('官方版本'))
    assert.ok(!result.message.includes('stash'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('Harness update install rolls back without restoring local changes when install fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-harness-install-fail-'))
  const commands = []
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.1.0-rc.5' }))
    const execute = async (_file, args, _cwd, timeout) => {
      const command = args.join(' ')
      commands.push(command)
      if (command === 'rev-parse --short HEAD') return { ok: true, out: 'abc1234', err: '' }
      if (command === 'rev-parse HEAD') return { ok: true, out: 'abc1234', err: '' }
      if (command === 'branch --show-current') return { ok: true, out: 'master', err: '' }
      if (command === 'status --porcelain') return { ok: true, out: ' M local.js', err: '' }
      if (command === 'remote get-url origin') return { ok: true, out: 'https://github.com/deepseek-ai/deepseek-harness.git', err: '' }
      if (command.startsWith('fetch --force --no-tags ')) return { ok: true, out: '', err: '' }
      if (command === 'rev-parse --short refs/remotes/zat-update/master') return { ok: true, out: 'def5678', err: '' }
      if (command === 'rev-list --count HEAD..refs/remotes/zat-update/master') return { ok: true, out: '3', err: '' }
      if (command === 'show refs/remotes/zat-update/master:package.json') return { ok: true, out: JSON.stringify({ version: '0.1.0-rc.6' }), err: '' }
      if (command.startsWith('stash push --include-untracked -m zat-update-')) return { ok: true, out: '', err: '' }
      if (command === 'merge --ff-only refs/remotes/zat-update/master') return { ok: true, out: '', err: '' }
      if (command.startsWith('install ')) return { ok: false, out: '', err: 'pnpm install failed' }
      if (command === 'reset --hard abc1234') return { ok: true, out: '', err: '' }
      return { ok: false, out: '', err: `unexpected ${command}` }
    }
    const result = await installUpdate(dir, path.join(dir, 'snap'), execute, { pnpmExe: 'pnpm' })
    assert.equal(result.ok, false)
    assert.equal(result.rolledBack, true)
    // 失败回滚：reset 回旧提交，但不再 stash pop、不提示恢复
    assert.ok(!commands.includes('stash pop'))
    assert.ok(commands.includes('reset --hard abc1234'))
    assert.ok(!result.message.includes('stash'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('Harness update install falls back to no-frozen-lockfile on config mismatch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-harness-install-lock-'))
  const commands = []
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.1.0-rc.5' }))
    const execute = async (_file, args, _cwd, timeout) => {
      const command = args.join(' ')
      commands.push(command)
      if (command === 'rev-parse --short HEAD') return { ok: true, out: 'abc1234', err: '' }
      if (command === 'rev-parse HEAD') return { ok: true, out: 'abc1234', err: '' }
      if (command === 'branch --show-current') return { ok: true, out: 'master', err: '' }
      if (command === 'status --porcelain') return { ok: true, out: '', err: '' }
      if (command === 'remote get-url origin') return { ok: true, out: 'https://github.com/deepseek-ai/deepseek-harness.git', err: '' }
      if (command.startsWith('fetch --force --no-tags ')) return { ok: true, out: '', err: '' }
      if (command === 'rev-parse --short refs/remotes/zat-update/master') return { ok: true, out: 'def5678', err: '' }
      if (command === 'rev-list --count HEAD..refs/remotes/zat-update/master') return { ok: true, out: '3', err: '' }
      if (command === 'show refs/remotes/zat-update/master:package.json') return { ok: true, out: JSON.stringify({ version: '0.1.0-rc.6' }), err: '' }
      if (command === 'merge --ff-only refs/remotes/zat-update/master') return { ok: true, out: '', err: '' }
      // frozen 全失败（lockfile 失配），no-frozen 成功 → 自动降级
      if (command === 'install --frozen-lockfile') return { ok: false, out: '', err: 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH' }
      if (command === 'install --frozen-lockfile --registry https://registry.npmmirror.com/') return { ok: false, out: '', err: 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH' }
      if (command === 'install --no-frozen-lockfile') return { ok: true, out: '', err: '' }
      if (command === 'run build') return { ok: true, out: '', err: '' }
      return { ok: false, out: '', err: `unexpected ${command}` }
    }
    const result = await installUpdate(dir, path.join(dir, 'snap'), execute, { pnpmExe: 'pnpm' })
    assert.equal(result.ok, true)
    assert.ok(commands.includes('install --no-frozen-lockfile'))
    assert.ok(result.message.includes('官方版本'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('supervisor reports a non-Harness HTTP listener as a port conflict', async () => {
  const { dir, registry } = temporaryRegistry()
  try {
    const terminal = registry.add({ port: 3080, dshDir: 'D:\\dsh-a' })
    const supervisor = new TerminalSupervisor({
      registry,
      probePort: async () => true,
      probeHttp: async () => ({ healthy: true, harness: false, statusCode: 200 }),
    })
    await supervisor.check(terminal.id)
    assert.equal(supervisor.get(terminal.id).state, 'port-conflict')
    assert.equal(supervisor.get(terminal.id).harnessConfirmed, false)
    supervisor.dispose()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ★ 1.3.1 回归：新版 DSH web token 鉴权（根路径 401「dsh web authentication required...」）
// 应识别为 Harness（attached-running），而不是误判"非 Harness 服务占用"（端口冲突）。
test('supervisor identifies DSH token-auth 401 page as harness (1.3.1 regression)', async () => {
  const { dir, registry } = temporaryRegistry()
  const http = require('node:http')
  let server
  const port = 31377
  try {
    const terminal = registry.add({ port, dshDir: 'D:\\dsh-a' })
    server = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'text/plain' })
      res.end('dsh web authentication required; reopen the URL printed by dsh web.')
    })
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
    const supervisor = new TerminalSupervisor({ registry, intervalMs: 1e9 })
    await supervisor.check(terminal.id)
    assert.equal(supervisor.get(terminal.id).state, 'attached-running')
    assert.equal(supervisor.get(terminal.id).harnessConfirmed, true)
    supervisor.dispose()
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('supervisor tracks two terminals independently and recognizes attached harness', async () => {
  const { dir, registry } = temporaryRegistry()
  try {
    const a = registry.add({ port: 3080, dshDir: 'D:\\dsh-a' })
    const b = registry.add({ port: 3081, dshDir: 'D:\\dsh-b' })
    const ports = new Map([[3080, { listening: true, harness: true }], [3081, { listening: false, harness: false }]])
    const supervisor = new TerminalSupervisor({
      registry,
      probePort: async port => ports.get(port).listening,
      probeHttp: async port => ({ healthy: ports.get(port).harness, harness: ports.get(port).harness, statusCode: 200 }),
    })
    await Promise.all([supervisor.check(a.id), supervisor.check(b.id)])
    assert.equal(supervisor.get(a.id).state, 'attached-running')
    assert.equal(supervisor.get(a.id).ownership, 'attached')
    assert.equal(supervisor.get(b.id).state, 'stopped')
    ports.set(3081, { listening: true, harness: false })
    await supervisor.check(b.id)
    assert.equal(supervisor.get(b.id).state, 'port-conflict')
    assert.equal(supervisor.get(a.id).state, 'attached-running')
    supervisor.dispose()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('registry persists managedPid across reload', () => {
  const { dir, registry } = temporaryRegistry()
  try {
    const terminal = registry.add({ port: 3080, dshDir: 'D:\\dsh-a', managedPid: 4242 })
    assert.equal(terminal.managedPid, 4242)
    const reloaded = new TerminalRegistry(registry.filePath)
    reloaded.load()
    assert.equal(reloaded.get(terminal.id).managedPid, 4242)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('supervisor recognizes its own detached process by managedPid after restart', async () => {
  const { dir, registry } = temporaryRegistry()
  try {
    const a = registry.add({ port: 3080, dshDir: 'D:\\dsh-a', managedPid: 4242 })
    const b = registry.add({ port: 3081, dshDir: 'D:\\dsh-b', managedPid: 4242 })
    const listenerPid = new Map([[3080, 4242], [3081, 9999]])
    const supervisor = new TerminalSupervisor({
      registry,
      probePort: async () => true,
      probeHttp: async () => ({ healthy: true, harness: true, statusCode: 200 }),
      resolvePortPid: async port => listenerPid.get(port) || null,
    })
    await Promise.all([supervisor.check(a.id), supervisor.check(b.id)])
    // 监听端口真实 PID 与 managedPid 匹配 → 自己 detach 的进程，识别为 managed/running
    assert.equal(supervisor.get(a.id).state, 'running')
    assert.equal(supervisor.get(a.id).ownership, 'managed')
    assert.equal(supervisor.get(a.id).pid, 4242)
    // PID 不匹配 → 外部接入
    assert.equal(supervisor.get(b.id).state, 'attached-running')
    assert.equal(supervisor.get(b.id).ownership, 'attached')
    supervisor.dispose()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('supervisor accumulates runtime independently per terminal', async () => {
  const { dir, registry } = temporaryRegistry()
  try {
    const a = registry.add({ port: 3080, dshDir: 'D:\\dsh-a' })
    const b = registry.add({ port: 3081, dshDir: 'D:\\dsh-b' })
    let aRunning = true
    const supervisor = new TerminalSupervisor({
      registry,
      probePort: async port => (port === 3080 ? aRunning : false),
      probeHttp: async () => ({ healthy: true, harness: true, statusCode: 200 }),
    })
    await supervisor.check(a.id)
    await supervisor.check(b.id)
    // a 正在运行 → activeSince 已置位；b 停止 → 无累计
    assert.ok(supervisor.get(a.id).activeSince > 0)
    assert.equal(supervisor.get(b.id).activeMs, 0)
    // 模拟 a 已运行 5 秒后停止：手动回拨 activeSince，验证结算
    supervisor.get(a.id).activeSince = Date.now() - 5000
    supervisor.get(a.id).activeMs = 1000
    aRunning = false
    await supervisor.check(a.id)
    const ra = supervisor.get(a.id)
    assert.ok(ra.activeMs >= 6000)
    assert.equal(ra.activeSince, 0)
    assert.ok(ra.activeMs > supervisor.get(b.id).activeMs) // 各终端独立
    supervisor.dispose()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
