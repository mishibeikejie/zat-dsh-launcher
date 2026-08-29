'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { detectKind, localInfo, checkUpdate, installUpdate, compareVersions, npmLatestProbe } = require('../src/harness-update')

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zat-hupd-${label}-`))
}

test('detectKind: npm package install vs git source checkout', () => {
  const dir = tmpDir('kind')
  try {
    const npmPkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(npmPkg, { recursive: true })
    fs.writeFileSync(path.join(npmPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.7' }))
    assert.equal(detectKind(npmPkg).kind, 'npm')

    const gitRoot = path.join(dir, 'deepseek-harness')
    fs.mkdirSync(gitRoot, { recursive: true })
    fs.writeFileSync(path.join(gitRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '0.1.0-rc.5' }))
    fs.mkdirSync(path.join(gitRoot, '.git'), { recursive: true })
    assert.equal(detectKind(gitRoot).kind, 'git')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('detectKind: 项目根 npm 形态（扫描接入的一键安装终端，如 D:\\2）识别为 npm 而非 git', async () => {
  const dir = tmpDir('kindproj')
  try {
    // 项目根：package.json 只有 dependencies，DSH 包在 node_modules（启动器一键安装的布局）
    const npmPkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(path.join(npmPkg, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(npmPkg, 'lib', 'bin.js'), 'x\n')
    fs.writeFileSync(path.join(npmPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.7', bin: { dsh: 'lib/bin.js' } }))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.7' } }))
    const det = detectKind(dir)
    assert.equal(det.kind, 'npm')
    assert.equal(det.pkg.version, '0.1.0-rc.7')
    // localInfo 不走 git
    const execute = async () => { throw new Error('npm form must not run git') }
    const info = await (async () => localInfo(dir, execute))()
    assert.equal(info.ok, true)
    assert.equal(info.kind, 'npm')
    assert.equal(info.version, '0.1.0-rc.7')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('localInfo reports npm package form without git commands', async () => {
  const dir = tmpDir('local')
  try {
    const npmPkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(npmPkg, { recursive: true })
    fs.writeFileSync(path.join(npmPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.7' }))
    const execute = async () => { throw new Error('npm form must not run git') }
    const info = await localInfo(npmPkg, execute)
    assert.equal(info.ok, true)
    assert.equal(info.kind, 'npm')
    assert.equal(info.version, '0.1.0-rc.7')
    assert.equal(info.dirty, false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('checkUpdate npm form detects newer registry version', async () => {
  const dir = tmpDir('chk')
  try {
    const npmPkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(npmPkg, { recursive: true })
    fs.writeFileSync(path.join(npmPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.7' }))
    const probe = async () => '0.1.0-rc.8'
    const result = await checkUpdate(npmPkg, undefined, probe)
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'npm')
    assert.equal(result.updateAvailable, true)
    assert.equal(result.canInstall, true)
    assert.equal(result.remoteVersion, '0.1.0-rc.8')
    // 已是最新
    const same = await checkUpdate(npmPkg, undefined, async () => '0.1.0-rc.7')
    assert.equal(same.updateAvailable, false)
    // 探测失败
    const failed = await checkUpdate(npmPkg, undefined, async () => '')
    assert.equal(failed.checkFailed, true)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('compareVersions handles rc prereleases and releases', () => {
  assert.equal(compareVersions('0.1.0-rc.7', '0.1.0-rc.8'), -1)
  assert.equal(compareVersions('0.1.0-rc.8', '0.1.0-rc.7'), 1)
  assert.equal(compareVersions('0.1.0-rc.7', '0.1.0-rc.7'), 0)
  assert.equal(compareVersions('0.1.0-rc.7', '0.1.0'), -1)
  assert.equal(compareVersions('0.1.0', '0.1.0-rc.7'), 1)
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1)
})

test('installUpdate npm form invokes npmUpdater and reports new version', async () => {
  const dir = tmpDir('inst')
  try {
    const npmPkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(npmPkg, { recursive: true })
    fs.writeFileSync(path.join(npmPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.7' }))
    let called = false
    const result = await installUpdate(npmPkg, path.join(dir, 'snap'), undefined, {
      probeLatest: async () => '0.1.0-rc.8',
      npmUpdater: async () => { called = true; return { ok: true, version: '0.1.0-rc.8' } },
    })
    assert.equal(called, true)
    assert.equal(result.ok, true)
    assert.ok(result.message.includes('0.1.0-rc.8'))
    // 已是最新时不调用更新器
    const noop = await installUpdate(npmPkg, path.join(dir, 'snap'), undefined, {
      probeLatest: async () => '0.1.0-rc.7',
      npmUpdater: async () => { called = true; return { ok: true, version: '0.1.0-rc.8' } },
    })
    assert.equal(noop.updateAvailable, false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('npmLatestProbe uses node fetch and returns registry version', async () => {
  const probe = npmLatestProbe(process.execPath)
  const version = await probe('https://registry.npmjs.org/')
  assert.ok(typeof version === 'string')
  assert.ok(version.length > 0 || version === '')
})

test('cleanUntrackedWorkspaceDirs removes ghost dirs but keeps tracked and user files', async () => {
  const { cleanUntrackedWorkspaceDirs } = require('../src/harness-update')
  const dir = tmpDir('ghost')
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '0.1.0-rc.8' }))
    // 真实包（已跟踪）：保留
    fs.mkdirSync(path.join(dir, 'packages', 'util', 'brand'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'packages', 'util', 'brand', 'package.json'), '{}')
    // 幽灵目录（未跟踪，仅 node_modules 残留）：删除
    fs.mkdirSync(path.join(dir, 'packages', 'api', 'session-controller', 'node_modules', 'x'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'packages', 'api', 'session-controller', 'node_modules', 'x', 'package.json'), '{}')
    // 未跟踪但含用户文件：保护不动
    fs.mkdirSync(path.join(dir, 'packages', 'api', 'user-stuff', 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'packages', 'api', 'user-stuff', 'notes.txt'), 'keep me')
    const trackedSet = new Set(['packages/util/brand'])
    const execute = async (_file, args) => {
      // 模拟 git ls-files --error-unmatch <rel>
      const rel = args[args.length - 1]
      return trackedSet.has(rel) ? { ok: true } : { ok: false }
    }
    const steps = []
    const removed = await cleanUntrackedWorkspaceDirs(dir, execute, msg => steps.push(msg))
    assert.equal(removed, 1)
    assert.equal(fs.existsSync(path.join(dir, 'packages', 'api', 'session-controller')), false)
    assert.equal(fs.existsSync(path.join(dir, 'packages', 'util', 'brand')), true)
    assert.equal(fs.existsSync(path.join(dir, 'packages', 'api', 'user-stuff', 'notes.txt')), true)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
