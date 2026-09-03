'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRescueSnapshot, rescueStatus, restoreRescueSnapshot, listBundles, diagnoseCrash, excludePlugin, recordCrash, markCrashRecovered, factoryResetProfile, FACTORY_BUNDLES } = require('../src/rescue')

function tmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zat-rescue-${label}-`))
}

test('create + restore rescue snapshot round-trips profile files', () => {
  const dir = tmp('rt')
  try {
    const profile = path.join(dir, 'profiles', 'web')
    const rescue = path.join(dir, 'rescue')
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n')
    fs.writeFileSync(path.join(profile, 'package.json'), '{"dsh":{"profile":{"bundles":["a","b"]}}}\n')
    const created = createRescueSnapshot(profile, rescue, 12345)
    assert.equal(created.ok, true)
    assert.deepEqual(created.files.sort(), ['cordis.yml', 'package.json'])
    fs.writeFileSync(path.join(profile, 'cordis.yml'), 'broken: [\n')
    const restored = restoreRescueSnapshot(profile, rescue)
    assert.equal(restored.ok, true)
    assert.equal(fs.readFileSync(path.join(profile, 'cordis.yml'), 'utf8'), '[]\n')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('rescueStatus reports missing snapshot', () => {
  const dir = tmp('st')
  try {
    assert.deepEqual(rescueStatus(path.join(dir, 'nope')), { exists: false, at: 0, files: [], lastCrash: null })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('last crash record survives recovery marking', () => {
  const dir = tmp('crash')
  try {
    const record = recordCrash(dir, { exitCode: 1, issues: [{ type: 'missing-bundle', plugin: 'bad-plugin' }], logTail: ['cannot resolve profile bundle "bad-plugin"'] })
    assert.equal(record.recoveredAt, 0)
    assert.equal(rescueStatus(dir).lastCrash.issues[0].plugin, 'bad-plugin')
    const recovered = markCrashRecovered(dir, 20000)
    assert.equal(recovered.recoveredAt, 20000)
    assert.equal(rescueStatus(dir).lastCrash.issues[0].plugin, 'bad-plugin')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('excludePlugin removes whole insert block referencing missing package (#880 pattern)', () => {
  const dir = tmp('ex880')
  try {
    const profile = path.join(dir, 'profiles', 'web')
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'zat-dsh-engine'] } } }, null, 2))
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), [
      '# 用户 patch 层',
      '- insert:',
      '    - id: ui-dsh-aionui-panel',
      "      name: '@deepseek-ai/dsh-client-ui-aionui-panel'",
      '      config:',
      '        mirror: https://gh-proxy.com/',
      '- insert:',
      '    - id: plugin-market',
      '      name: zat-dsh-engine',
      '      config:',
      '        mirror: https://gh-proxy.com/',
    ].join('\n') + '\n')
    const r = excludePlugin(profile, '@deepseek-ai/dsh-client-ui-aionui-panel')
    assert.equal(r.ok, true)
    const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.ok(!patch.includes('aionui'), '坏条目块应被整体删除')
    assert.ok(patch.includes('plugin-market'), '同文件其它 insert 条目必须保留')
    assert.ok(patch.includes('zat-dsh-engine'), '其它插件引用必须保留')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('excludePlugin appends [] when removal leaves comment-only patch file', () => {
  const dir = tmp('excmt')
  try {
    const profile = path.join(dir, 'profiles', 'web')
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2))
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), [
      '# 用户 patch 层',
      '- insert:',
      '    - id: ui-dsh-aionui-panel',
      "      name: '@deepseek-ai/dsh-client-ui-aionui-panel'",
    ].join('\n') + '\n')
    const r = excludePlugin(profile, '@deepseek-ai/dsh-client-ui-aionui-panel')
    assert.equal(r.ok, true)
    const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.ok(!patch.includes('aionui'))
    // DSH 的 parsePatchList 要求顶层是 YAML 数组：只剩注释时必须补 []
    assert.ok(/^\s*\[\s*\]\s*$/m.test(patch), `patch 必须以合法空数组结尾: ${JSON.stringify(patch)}`)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('diagnoseCrash finds missing bundle / failed plugin / bad profile', () => {
  const logs = [
    'Error: dsh: cannot resolve profile bundle "bad-plugin" from the dsh installation',
    'Error: dsh: plugin(s) failed to load: plugin-a, plugin-b; Cordis startup failed',
    'Error: dsh: failed to parse patches C:/x/cordis.patch.yml: ...',
  ]
  const r = diagnoseCrash(logs)
  const keys = r.issues.map(i => `${i.type}:${i.plugin}`)
  assert.ok(keys.includes('missing-bundle:bad-plugin'))
  assert.ok(keys.includes('plugin-failed:plugin-a'))
  assert.ok(keys.includes('plugin-failed:plugin-b'))
  assert.ok(keys.includes('bad-profile:'))
  assert.equal(r.issues.find(i => i.type === 'bad-profile').fix, 'restore')
  assert.equal(r.issues.find(i => i.type === 'missing-bundle').fix, 'exclude-bundle')
})

// 0.6.22 回归：npm 预构建包 rc.7 不认 --no-open 导致的启动失败，
// 救援一键检测必须能识别（用户反馈：装好后启动失败 3 次，救援却说"没事"）。
test('diagnoseCrash detects unknown CLI option (rc.7 --no-open regression)', () => {
  const logs = [
    'error: unknown option \'--no-open\'',
    'error: unknown option "--port"',
  ]
  const r = diagnoseCrash(logs)
  const cliIssues = r.issues.filter(i => i.type === 'cli-arg')
  assert.equal(cliIssues.length, 1, `应识别出 cli-arg 问题: ${JSON.stringify(r.issues)}`)
  assert.equal(cliIssues[0].fix, 'restart')
  assert.ok(cliIssues[0].message.includes('--no-open'))
})

// 1.0.6 矩阵扩展：网上搜集的 DSH 真实崩溃案例（官方 discussion #3263/#2889/#1677/#2990）。

test('diagnoseCrash detects bundle-mismatch from failed to import loader entry (群友案例)', () => {
  const logs = [
    'Failed to load plugins',
    'failed to import loader entry 12569d5a(dsh-session-manager): client-modules:require("@deepseek-ai/dsh-client-web-react")missed the module table - not a platform seed word,not a materialized module,and no registered package factory (a build-time externals drift,or a dynamic dependency that did not arrive)',
  ]
  const r = diagnoseCrash(logs)
  const issues = r.issues.filter(i => i.type === 'bundle-mismatch')
  assert.equal(issues.length, 1, `应识别出 bundle-mismatch: ${JSON.stringify(r.issues)}`)
  assert.equal(issues[0].fix, 'reinstall', '依赖层面崩溃必须重装依赖，不能只 restart')
})

test('diagnoseCrash detects bundle-mismatch from Unknown file extension .css (rc.8 错配)', () => {
  const logs = [
    'TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".css" for D:\\2\\profiles\\web\\node_modules\\katex\\dist\\katex.min.css',
  ]
  const r = diagnoseCrash(logs)
  const issues = r.issues.filter(i => i.type === 'bundle-mismatch')
  assert.equal(issues.length, 1, `应识别出 bundle-mismatch: ${JSON.stringify(r.issues)}`)
  assert.equal(issues[0].fix, 'reinstall')
})

test('diagnoseCrash detects bundle-mismatch from ToolRuntime prepare crash (#1677/#2130)', () => {
  const logs = [
    'Error: Cannot read properties of undefined (reading \'prepare\') — ToolRuntime 调度器未注册',
  ]
  const r = diagnoseCrash(logs)
  const issues = r.issues.filter(i => i.type === 'bundle-mismatch')
  assert.equal(issues.length, 1, `应识别出 bundle-mismatch: ${JSON.stringify(r.issues)}`)
  assert.equal(issues[0].fix, 'reinstall')
})

test('diagnoseCrash detects source-mixed rollback (loader entry is not a function)', () => {
  const logs = [
    'Error: dsh: plugin tree failed to load: failed to apply loader entry tool-subagent-report (@deepseek-ai/dsh-tool-subagent-report): ctx.subagents.registerContinuableSetup is not a function',
  ]
  const r = diagnoseCrash(logs)
  const issues = r.issues.filter(i => i.type === 'source-mixed')
  assert.equal(issues.length, 1, `应识别出 source-mixed: ${JSON.stringify(r.issues)}`)
  assert.equal(issues[0].fix, 'rebuild-source')
})

test('diagnoseCrash detects duplicate loader entry (插件市场装插件后崩溃 #3263/#2889)', () => {
  const logs = [
    'Error: duplicate loader entry id: storage (already registered by another plugin)',
  ]
  const r = diagnoseCrash(logs)
  const issues = r.issues.filter(i => i.type === 'duplicate-plugin')
  assert.equal(issues.length, 1, `应识别出 duplicate-plugin: ${JSON.stringify(r.issues)}`)
  assert.equal(issues[0].plugin, 'storage')
  assert.equal(issues[0].fix, 'exclude-bundle', '重复注册应通过排除该插件修复')
})

test('diagnoseCrash detects spawn ENOENT toolchain crash (#2990)', () => {
  const logs = [
    'Error: spawn bash ENOENT — harness 因未捕获的 ENOENT 整体崩溃',
  ]
  const r = diagnoseCrash(logs)
  const issues = r.issues.filter(i => i.type === 'tool-missing')
  assert.equal(issues.length, 1, `应识别出 tool-missing: ${JSON.stringify(r.issues)}`)
  assert.equal(issues[0].fix, 'restart', '工具链缺失重启即由启动器自动自举')
})

test('diagnoseCrash detects missing-module (Cannot find package) with exclude fix', () => {
  const logs = [
    "Error: Cannot find package '@deepseek-ai/dsh-client-ui-xyz' imported from cordis.yml",
  ]
  const r = diagnoseCrash(logs)
  const issues = r.issues.filter(i => i.type === 'missing-module')
  assert.equal(issues.length, 1, `应识别出 missing-module: ${JSON.stringify(r.issues)}`)
  assert.equal(issues[0].plugin, '@deepseek-ai/dsh-client-ui-xyz')
  assert.equal(issues[0].fix, 'exclude-bundle', '缺依赖必须走排除插件（L1 对症修复），不能只重启')
})

// 1.0.11 回归：源码形态缺 tsx（ERR_MODULE_NOT_FOUND → Cannot find package 'tsx'）
// 必须识别为 source-deps（安装依赖），而不是 missing-module 的"排除插件"（排除对依赖无效）。
test('diagnoseCrash detects source-deps for tsx (源码形态缺依赖,不是插件)', () => {
  const logs = [
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from E:\\dsh\\deepseek-harness",
    "code: 'ERR_MODULE_NOT_FOUND'",
  ]
  const r = diagnoseCrash(logs)
  const issues = r.issues.filter(i => i.type === 'source-deps')
  assert.equal(issues.length, 1, `应识别出 source-deps: ${JSON.stringify(r.issues)}`)
  assert.equal(issues[0].plugin, 'tsx')
  assert.equal(issues[0].fix, 'install-deps', '缺 tsx 必须走"安装依赖"，绝不能"排除插件"')
})

test('excludePlugin removes only the bad bundle, keeps others and node_modules', () => {
  const dir = tmp('ex')
  try {
    const profile = path.join(dir, 'profiles', 'web')
    fs.mkdirSync(path.join(profile, 'node_modules', 'bad-plugin'), { recursive: true })
    fs.mkdirSync(path.join(profile, 'node_modules', 'good-plugin'), { recursive: true })
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'bad-plugin', 'good-plugin'] } } }, null, 2))
    const r = excludePlugin(profile, 'bad-plugin')
    assert.equal(r.ok, true)
    assert.deepEqual(r.bundles, ['@deepseek-ai/dsh-base', 'good-plugin'])
    assert.ok(fs.existsSync(path.join(profile, 'node_modules', 'good-plugin')))
    assert.ok(fs.existsSync(path.join(profile, 'node_modules', 'bad-plugin')))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('listBundles returns empty for missing profile', () => {
  const dir = tmp('lb')
  try { assert.deepEqual(listBundles(path.join(dir, 'nope')), []) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('factoryResetProfile backs up configs and writes minimal usable profile (L3)', () => {
  const dir = tmp('l3')
  try {
    const profile = path.join(dir, 'profiles', 'web')
    const backup = path.join(dir, 'factory-backups')
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'bad-plugin', 'another-bad'] } } }, null, 2))
    fs.writeFileSync(path.join(profile, 'cordis.yml'), '- id: bad-plugin\n- id: another-bad\n')
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- insert:\n    - id: custom\n')
    const r = factoryResetProfile(profile, backup)
    assert.equal(r.ok, true)
    // 备份目录含原配置
    assert.ok(fs.existsSync(path.join(backup, 'package.json')))
    assert.ok(fs.existsSync(path.join(backup, 'cordis.yml')))
    // 重建后 profile 仅官方 bundle、无自定义插件
    const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
    assert.deepEqual(pkg.dsh.profile.bundles, FACTORY_BUNDLES)
    assert.ok(!fs.readFileSync(path.join(profile, 'cordis.yml'), 'utf8').includes('bad-plugin'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
