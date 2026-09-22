'use strict'

// 内嵌工具播种回归测试（1.5.6）：
//  - 1.5.5 把播种代码写在 normalToolsDir() 的 return 之后 = 死代码，安装包内嵌的
//    git/node/pnpm 从未播种到永久缓存 → 每次启动联网下载 PortableGit，断网即自举失败。
//  - seedEmbeddedTools 必须按单工具目录补缺：缺失才复制、已存在不覆盖、只动指定名字（onlyName）。

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { seedEmbeddedTools, pnpmStandaloneComplete, toolDirComplete } = require('../src/fresh-install')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zat-seed-test-'))
}

// 造一个假 resources 根：<root>/tools/zat-tools/<layout 相对路径>，并把 process.resourcesPath 指过去。
// 返回恢复函数（测试结束调用，还原原值）。
function fakeResources(layout) {
  const root = tmpDir()
  const embedded = path.join(root, 'tools', 'zat-tools')
  for (const [rel, content] of Object.entries(layout)) {
    const file = path.join(embedded, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const saved = process.resourcesPath
  process.resourcesPath = root
  return () => {
    if (saved === undefined) delete process.resourcesPath
    else process.resourcesPath = saved
  }
}

test('seedEmbeddedTools: 缺失的工具目录被复制，已有目录不覆盖', () => {
  const restore = fakeResources({
    'git/cmd/git.exe': 'git-bin',
    'node/node.exe': 'node-bin',
    'pnpm-11.25.0/pnpm.exe': 'pnpm-bin',
  })
  try {
    const persistent = tmpDir()
    // 预置已存在的 git（旧缓存/下载版），内容不同 → 播种不得覆盖
    fs.mkdirSync(path.join(persistent, 'git', 'cmd'), { recursive: true })
    fs.writeFileSync(path.join(persistent, 'git', 'cmd', 'git.exe'), 'existing')

    seedEmbeddedTools(persistent)

    assert.equal(fs.readFileSync(path.join(persistent, 'git', 'cmd', 'git.exe'), 'utf8'), 'existing', '已有 git 被覆盖')
    assert.equal(fs.readFileSync(path.join(persistent, 'node', 'node.exe'), 'utf8'), 'node-bin', '缺失 node 未播种')
    assert.equal(fs.readFileSync(path.join(persistent, 'pnpm-11.25.0', 'pnpm.exe'), 'utf8'), 'pnpm-bin', '缺失 pnpm 未播种')
  } finally {
    restore()
  }
})

test('seedEmbeddedTools: onlyName 只播种指定工具（ensureGit 坏缓存修复路径）', () => {
  const restore = fakeResources({
    'git/cmd/git.exe': 'git-bin',
    'node/node.exe': 'node-bin',
  })
  try {
    const persistent = tmpDir()
    seedEmbeddedTools(persistent, 'git')
    assert.ok(fs.existsSync(path.join(persistent, 'git', 'cmd', 'git.exe')), '指定 git 未播种')
    assert.ok(!fs.existsSync(path.join(persistent, 'node')), 'onlyName 播种了无关工具')
  } finally {
    restore()
  }
})

test('seedEmbeddedTools: 内嵌源不存在时不报错不落盘', () => {
  const restore = fakeResources({})
  process.resourcesPath = path.join(tmpDir(), 'no-such-resources')
  try {
    const persistent = tmpDir()
    seedEmbeddedTools(persistent)
    assert.equal(fs.readdirSync(persistent).length, 0, '无内嵌源时不应产生任何文件')
  } finally {
    restore()
  }
})

// ★ 1.5.8 回归：1.5.5~1.5.7 的安装包里 pnpm-11.25.0 只带了 pnpm.exe、没有 dist，
//   播种后用户执行 pnpm add 直接 MODULE_NOT_FOUND（实机大面积报错）。
//   修复要求：残缺目录（只有 exe）不能再被当成"已播种"跳过，必须把缺的 dist 补上。
test('seedEmbeddedTools: 残缺 pnpm 目录（只有 exe）必须补齐 dist，且不覆盖已有 exe', () => {
  const restore = fakeResources({
    'pnpm-11.25.0/pnpm.exe': 'pnpm-bin-new',
    'pnpm-11.25.0/dist/pnpm.mjs': 'pnpm-mjs',
    'pnpm-11.25.0/dist/pnpmrc': 'registry=x',
  })
  try {
    const persistent = tmpDir()
    // 预置残缺目录：有 exe（老缓存内容），没有 dist
    fs.mkdirSync(path.join(persistent, 'pnpm-11.25.0'), { recursive: true })
    fs.writeFileSync(path.join(persistent, 'pnpm-11.25.0', 'pnpm.exe'), 'existing-exe')
    assert.equal(toolDirComplete('pnpm-11.25.0', path.join(persistent, 'pnpm-11.25.0')), false, '残缺目录被判为完整')

    seedEmbeddedTools(persistent)

    assert.equal(fs.readFileSync(path.join(persistent, 'pnpm-11.25.0', 'pnpm.exe'), 'utf8'), 'existing-exe', '已有 exe 被覆盖')
    assert.equal(fs.readFileSync(path.join(persistent, 'pnpm-11.25.0', 'dist', 'pnpm.mjs'), 'utf8'), 'pnpm-mjs', 'dist/pnpm.mjs 未补齐')
    assert.equal(fs.readFileSync(path.join(persistent, 'pnpm-11.25.0', 'dist', 'pnpmrc'), 'utf8'), 'registry=x', 'dist 其余文件未补齐')
    assert.equal(toolDirComplete('pnpm-11.25.0', path.join(persistent, 'pnpm-11.25.0')), true, '补齐后仍判为残缺')
    assert.equal(pnpmStandaloneComplete(path.join(persistent, 'pnpm-11.25.0', 'pnpm.exe')), true, 'exe+dist 配对判定失败')
  } finally {
    restore()
  }
})

test('pnpmStandaloneComplete: 只有 exe（缺 dist）一律判为不可用', () => {
  const dir = tmpDir()
  try {
    fs.writeFileSync(path.join(dir, 'pnpm.exe'), 'bin')
    assert.equal(pnpmStandaloneComplete(path.join(dir, 'pnpm.exe')), false, '缺 dist 竟判为可用')
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'dist', 'pnpm.mjs'), 'mjs')
    assert.equal(pnpmStandaloneComplete(path.join(dir, 'pnpm.exe')), true, 'exe+dist 配对未识别')
    assert.equal(pnpmStandaloneComplete(path.join(dir, 'nope.exe')), false, '不存在的 exe 判为可用')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('seedEmbeddedTools: 完整的 pnpm 目录一个字节都不动', () => {
  const restore = fakeResources({
    'pnpm-11.25.0/pnpm.exe': 'src-exe',
    'pnpm-11.25.0/dist/pnpm.mjs': 'src-mjs',
  })
  try {
    const persistent = tmpDir()
    fs.mkdirSync(path.join(persistent, 'pnpm-11.25.0', 'dist'), { recursive: true })
    fs.writeFileSync(path.join(persistent, 'pnpm-11.25.0', 'pnpm.exe'), 'keep-exe')
    fs.writeFileSync(path.join(persistent, 'pnpm-11.25.0', 'dist', 'pnpm.mjs'), 'keep-mjs')

    seedEmbeddedTools(persistent)

    assert.equal(fs.readFileSync(path.join(persistent, 'pnpm-11.25.0', 'pnpm.exe'), 'utf8'), 'keep-exe', '完整缓存的 exe 被覆盖')
    assert.equal(fs.readFileSync(path.join(persistent, 'pnpm-11.25.0', 'dist', 'pnpm.mjs'), 'utf8'), 'keep-mjs', '完整缓存的 dist 被覆盖')
  } finally {
    restore()
  }
})
