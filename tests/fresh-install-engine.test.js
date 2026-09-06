'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  probeSource, reachableSource, downloadDshTo,
  ensurePnpm, findPnpm, pickRegistry,
  executablePnpmOrRaw,
  gitPortableUrls,
  NPM_REGISTRIES,
} = require('../src/fresh-install')
const {
  detectEngine, downloadEngineTo, injectEngine, verifyEngine, restoreEngine, enginePatchBlock,
  probeEngineRemoteVersion, checkEngineUpdate, compareVersions,
} = require('../src/engine-manager')

// 临时目录助手
function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'))
}

test('probeSource 只对可达源返回真', async () => {
  const reachable = new Set(['https://github.com/a/b.git'])
  const execute = async (_f, _args, _cwd, timeout) => ({ ok: reachable.has(_args[_args.length - 1]) && timeout === 3000 })
  assert.equal(await probeSource('https://github.com/a/b.git', execute), true)
  assert.equal(await probeSource('https://ghfast.top/x', execute), false)
})

test('reachableSource 按官方→镜像顺序选最先可达源', async () => {
  const reachable = new Set()
  const execute = async (_f, args) => ({ ok: reachable.has(args[args.length - 1]) })
  reachable.add('https://github.com/deepseek-ai/deepseek-harness.git')
  const source = await reachableSource('https://github.com/deepseek-ai/deepseek-harness.git', null, execute)
  assert.equal(source, 'https://github.com/deepseek-ai/deepseek-harness.git')
  // 官方不可达，镜像可达 → 返回 ghfast
  reachable.delete('https://github.com/deepseek-ai/deepseek-harness.git')
  reachable.add('https://ghfast.top/https://github.com/deepseek-ai/deepseek-harness.git')
  const fallback = await reachableSource('https://github.com/deepseek-ai/deepseek-harness.git', null, execute)
  assert.ok(fallback.includes('ghfast.top'))
  // 全部不可达 → 回退官方
  reachable.clear()
  const last = await reachableSource('https://github.com/deepseek-ai/deepseek-harness.git', null, execute)
  assert.equal(last, 'https://github.com/deepseek-ai/deepseek-harness.git')
})

test('downloadDshTo 走克隆并带进度；已存在则跳过', async () => {
  const dir = tmp('zat-dl')
  const executed = []
  const probe = async (file, args) => ({ ok: true }) // 源探测全可达
  const execute = async (description, file, args) => {
    executed.push({ description, file, args })
    const target = args[args.length - 1]
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '9.9.9', workspaces: ['apps/*'] }))
    return { ok: true, out: '', err: '' }
  }
  const steps = []
  const onProgress = (stage, msg) => steps.push(`${stage}:${msg}`)
  const r = await downloadDshTo(path.join(dir, 'dsh'), onProgress, execute, probe)
  assert.equal(r.ok, true)
  assert.ok(executed.some(e => e.args.includes('clone')))
  assert.ok(executed.some(e => e.args.includes('--depth')))
  assert.ok(steps.some(s => s.startsWith('下载')))
  // 再次调用 → skipped
  const r2 = await downloadDshTo(path.join(dir, 'dsh'), onProgress, execute)
  assert.equal(r2.skipped, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('ensurePnpm 自带 standalone 缓存存在时直接返回（1.5.3 原则：只用自带）', async () => {
  // ★ 1.5.3 用户原则：启动器自带工具齐全就永远只用自带，绝不摸用户系统。
  //   自带 standalone（pnpm-<ver>\pnpm.exe + dist 配对）优先；mjs 已从主路径剔除
  //   （官方 mjs 在 Windows 对最新依赖树 worker 稳定崩溃，矩阵实测 5/5）。
  const dir = tmp('zat-pnpm')
  fs.mkdirSync(path.join(dir, 'pnpm-11.25.0'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pnpm-11.25.0', 'pnpm.exe'), 'MZ-fake-exe')
  fs.mkdirSync(path.join(dir, 'pnpm-11.25.0', 'dist'), { recursive: true })
  const nodeExe = process.execPath
  const got = await ensurePnpm({ nodeExe, toolsDir: dir, skipOnline: true })
  assert.equal(got, path.join(dir, 'pnpm-11.25.0', 'pnpm.exe'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('ensurePnpm 无 standalone 且网络异常时不默认返回会崩的 mjs（1.5.3）', async () => {
  // 用临时干净目录 + 空 PATH：模拟全新机器（无 zat-tools 缓存），且 PATH 无系统 pnpm
  const dir = tmp('zat-pnpm-nomjs')
  fs.mkdirSync(dir, { recursive: true })
  const nodeExe = process.execPath
  const got = await ensurePnpm({ nodeExe, toolsDir: dir, skipOnline: true })
  // 新原则：mjs 不自动作为主路径兜底（会崩）。返回 '' 让调用方明确报错，
  // 而不是静默用崩的 mjs 安装。已有别的源码会给出"无可用 pnpm"的真实错误。
  assert.equal(got, '')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('findPnpm 返回字符串（不抛错）', () => {
  assert.equal(typeof findPnpm(), 'string')
})

test('GIT_MIRRORS 提供多源回退，不依赖单一镜像可达', () => {
  // ★ 1.4.2：GIT_MIRRORS 改为 gitPortableUrls(tag, ver) 函数（跟随官方 latest，内置兜底）
  const urls = gitPortableUrls('v2.55.0.windows.5', '2.55.0')
  assert.ok(urls.length >= 5, `应至少 5 个源，当前 ${urls.length}`)
  assert.ok(urls.some(u => u.includes('github.com')), '缺少官方源')
  assert.ok(urls.some(u => u.includes('ghfast.top')), '缺少 ghfast.top 镜像')
  assert.ok(urls.some(u => u.includes('ghproxy.net')), '缺少 ghproxy.net 镜像')
  assert.ok(urls.every(u => u.includes('v2.55.0.windows.5')), 'URL 应使用传入版本')
})

test('NPM_REGISTRIES 提供多 registry 回退，不依赖单一源可达', () => {
  assert.ok(NPM_REGISTRIES.length >= 4, `应至少 4 个源，当前 ${NPM_REGISTRIES.length}`)
  assert.ok(NPM_REGISTRIES.some(u => u.includes('npmmirror.com')), '缺少 npmmirror 镜像')
  assert.ok(NPM_REGISTRIES.some(u => u.includes('mirrors.cloud.tencent.com')), '缺少腾讯 npm 镜像')
  assert.ok(NPM_REGISTRIES.some(u => u.includes('mirrors.huaweicloud.com')), '缺少华为 npm 镜像')
})

test('executablePnpmOrRaw 归一化原始 .mjs/.cjs（spawn UNKNOWN 回归）', () => {
  const dir = tmp('zat-pnpm-norm')
  const raw = path.join(dir, 'pnpm.mjs')
  fs.writeFileSync(raw, 'console.log(1)\n', 'utf8')
  const wrapped = executablePnpmOrRaw(raw, process.execPath)
  assert.equal(wrapped.file, process.execPath)
  assert.ok(wrapped.args.includes(raw))
  const obj = { file: process.execPath, args: [raw] }
  assert.equal(executablePnpmOrRaw(obj, process.execPath), obj)
  const exe = path.join(dir, 'pnpm.exe')
  fs.writeFileSync(exe, '')
  const exeObj = executablePnpmOrRaw(exe, process.execPath)
  assert.equal(exeObj.file, exe)
  assert.deepEqual(exeObj.args, [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('pickRegistry 在无网络执行器下返回 npmmirror 兜底', async () => {
  const execute = async () => ({ ok: false, code: 2 })
  const registry = await pickRegistry(process.execPath, execute)
  assert.ok(registry.includes('npmmirror'))
})

test('detectEngine 检测未挂载状态', () => {
  const dir = tmp('zat-eng')
  const info = detectEngine(dir)
  assert.equal(info.mounted, false)
  assert.equal(info.hasPatchFile, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('downloadEngineTo 用注入执行器克隆引擎并带进度', async () => {
  const dir = tmp('zat-engdl')
  const execute = async (_file, args) => {
    if (args.includes('ls-remote')) return { ok: true } // 探测通过
    const target = args[args.length - 1]
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'zat-dsh-engine', version: '0.6.1' }))
    return { ok: true }
  }
  const steps = []
  const r = await downloadEngineTo(path.join(dir, 'engine'), (s, m) => steps.push(`${s}:${m}`), execute)
  assert.equal(r.ok, true)
  assert.ok(steps.some(s => s.startsWith('引擎')))
  assert.equal(r.skipped, undefined)
  // 已存在 → skipped
  const r2 = await downloadEngineTo(path.join(dir, 'engine'), null, execute)
  assert.equal(r2.skipped, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('injectEngine 注入/不重复/备份/回滚', () => {
  const dir = tmp('zat-enginj')
  const profile = path.join(dir, 'profiles', 'web')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n', 'utf8')

  const first = injectEngine(profile, { mirror: 'https://gh-proxy.com/' })
  assert.equal(first.ok, true)
  assert.equal(first.injected, true)
  const text = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
  assert.ok(text.includes('plugin-market'))
  assert.ok(text.includes('zat-dsh-engine'))
  // bundle 轨道也应写入 package.json
  const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
  assert.ok(pkg.dsh.profile.bundles.includes('zat-dsh-engine'))

  // 重复注入 → alreadyInjected
  const second = injectEngine(profile)
  assert.equal(second.alreadyInjected, true)
  // 验证：未实装引擎包 → 校验失败（bundle 声明不能替代真实下载）
  const v1 = verifyEngine(profile)
  assert.equal(v1.ok, false)
  assert.equal(v1.mounted, true)
  assert.equal(v1.rootValid, true)
  assert.equal(v1.installedInNodeModules, false)
  assert.ok(v1.message.includes('未安装'))
  // 回滚
  const rollback = restoreEngine(profile)
  assert.equal(rollback.ok, true)
  assert.equal(detectEngine(profile).mounted, false)
  const pkgAfter = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
  assert.ok(!pkgAfter.dsh.profile.bundles.includes('zat-dsh-engine'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('detectEngine 通过官方 bundle 方式识别手动安装的插件商店（用户真实场景）', () => {
  const dir = tmp('zat-engbun')
  const profile = path.join(dir, 'profiles', 'web')
  fs.mkdirSync(path.join(profile, 'node_modules', 'zat-dsh-engine'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'zat-dsh-engine'] } },
  }, null, 2))
  // cordis.patch.yml 仍是空（官方 dsh plugin add 不写 patch）
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n', 'utf8')

  const info = detectEngine(profile)
  assert.equal(info.mounted, true)
  assert.equal(info.mountedViaBundle, true)
  assert.equal(info.mountedViaPatch, false)
  assert.equal(info.installedInNodeModules, true)
  const v2 = verifyEngine(profile)
  assert.equal(v2.ok, true)
  assert.equal(v2.mounted, true)
  assert.equal(v2.rootValid, true)
  assert.equal(v2.installedInNodeModules, true)
  assert.equal(v2.message, '')
  // 已挂载 → 重复注入返回 alreadyInjected
  const again = injectEngine(profile)
  assert.equal(again.alreadyInjected, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('enginePatchBlock 生成合法插入块（幂等）', () => {
  const block = enginePatchBlock()
  assert.ok(block.includes('plugin-market'))
  assert.ok(block.includes('zat-dsh-engine'))
  assert.ok(block.includes('mirror'))
})

test('restoreEngine 无备份时按标记清除注入行', () => {
  const profile = tmp('zat-engrst')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- insert:\n    - id: plugin-market\n', 'utf8')
  // 手动制造无备份场景：注入时的标记在 enginePatchBlock 里，这里直接清
  const r = restoreEngine(profile)
  // 无 .bak 且无标记 → 提示无法回滚（说明 mark 分支要能命中注入块才能删）
  // 我们改用注入过的 patch 验证
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), enginePatchBlock(), 'utf8')
  const r2 = restoreEngine(profile)
  assert.equal(r2.ok, true)
  assert.equal(detectEngine(profile).mounted, false)
  fs.rmSync(profile, { recursive: true, force: true })
})

test('compareVersions 引擎版本比较（0.6.4 < 0.6.5 < 0.6.10；rc 预发布更旧）', () => {
  assert.equal(compareVersions('0.6.4', '0.6.5'), -1)
  assert.equal(compareVersions('0.6.5', '0.6.5'), 0)
  assert.equal(compareVersions('0.6.10', '0.6.5'), 1)
  assert.equal(compareVersions('0.6.5-rc.1', '0.6.5'), -1)
  assert.equal(compareVersions('0.6.5', '0.6.4'), 1)
})

test('detectEngine 读取实装版本 installedVersion', () => {
  const profile = tmp('zat-engver')
  const engineDir = path.join(profile, 'node_modules', 'zat-dsh-engine')
  fs.mkdirSync(engineDir, { recursive: true })
  fs.writeFileSync(path.join(engineDir, 'package.json'), JSON.stringify({ name: 'zat-dsh-engine', version: '0.6.5' }), 'utf8')
  const info = detectEngine(profile)
  assert.equal(info.installedInNodeModules, true)
  assert.equal(info.installedVersion, '0.6.5')
  // 未实装 → 版本为空
  fs.rmSync(engineDir, { recursive: true, force: true })
  const info2 = detectEngine(profile)
  assert.equal(info2.installedInNodeModules, false)
  assert.equal(info2.installedVersion, '')
  fs.rmSync(profile, { recursive: true, force: true })
})

test('checkEngineUpdate 对比本地/远端版本并正确判断更新', async () => {
  const profile = tmp('zat-engchk')
  const engineDir = path.join(profile, 'node_modules', 'zat-dsh-engine')
  fs.mkdirSync(engineDir, { recursive: true })
  fs.writeFileSync(path.join(engineDir, 'package.json'), JSON.stringify({ name: 'zat-dsh-engine', version: '0.6.4' }), 'utf8')
  // 远端 0.6.5 > 本地 0.6.4 → 有更新
  const newer = await checkEngineUpdate(profile, async () => '0.6.5')
  assert.equal(newer.updateAvailable, true)
  assert.equal(newer.installedVersion, '0.6.4')
  assert.equal(newer.remoteVersion, '0.6.5')
  // 远端与本地相同 → 无更新
  const same = await checkEngineUpdate(profile, async () => '0.6.4')
  assert.equal(same.updateAvailable, false)
  assert.ok(same.message.includes('已是最新'))
  // 远端探测失败（网络）→ checkFailed
  const failed = await checkEngineUpdate(profile, async () => '')
  assert.equal(failed.updateAvailable, false)
  assert.equal(failed.checkFailed, true)
  // 未实装 → 提示先安装
  fs.rmSync(engineDir, { recursive: true, force: true })
  const notInstalled = await checkEngineUpdate(profile, async () => '0.6.5')
  assert.equal(notInstalled.installed, false)
  assert.equal(notInstalled.updateAvailable, false)
  fs.rmSync(profile, { recursive: true, force: true })
})

test('probeEngineRemoteVersion 多源逐个尝试，命中即返回', async () => {
  const calls = []
  const fakeFetch = async (url) => {
    calls.push(url)
    if (url.includes('ghfast.top')) return { ok: true, status: 200, json: async () => ({ version: '0.6.5' }) }
    throw new Error('fail')
  }
  const probe = probeEngineRemoteVersion(fakeFetch)
  const v = await probe()
  assert.equal(v, '0.6.5')
  assert.ok(calls.length >= 2) // 官方 raw 失败后切到镜像
  assert.ok(calls.some(u => u.includes('ghfast.top')))
})

