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
const { seedEmbeddedTools } = require('../src/fresh-install')

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
