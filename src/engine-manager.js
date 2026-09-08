'use strict'

/* zat-dsh-engine 插件管理：检测 / 下载 / 注入 cordis.patch.yml / 备份 / 验证 / 回滚。
 * 只操作「当前终端自己的 DSH_HOME/profile」目录，绝不触碰外部 DSH 安装。 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { updateSources } = require('./harness-update')
const { run, runWithProgress } = require('./fresh-install')

const ENGINE_ORIGIN = 'https://github.com/mishibeikejie/zat-dsh-engine.git'
const PATCH_ROW_ID = 'plugin-market'

function profilePatchPath(profileDir) {
  return path.join(profileDir, 'cordis.patch.yml')
}

function readMaybe(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

// 检测 profile 是否已挂载 zat-dsh-engine。
// 兼容两种官方挂载方式：
//   A) bundle 方式（DSH `dsh plugin add` 官方机制）：package.json -> dsh.profile.bundles 含 zat-dsh-engine
//   B) patch 方式：cordis.patch.yml 内含 plugin-market / zat-dsh-engine 行
// 并核验 node_modules 是否实装该包（真实可加载的证据），同时读取实装版本。
function detectEngine(profileDir) {
  const patchText = readMaybe(profilePatchPath(profileDir))
  let bundles = []
  try {
    const pkg = JSON.parse(readMaybe(path.join(profileDir, 'package.json')))
    bundles = Array.isArray(pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles)
      ? pkg.dsh.profile.bundles
      : []
  } catch { /* 无 package.json 或字段缺失 */ }
  const mountedViaPatch = patchText.includes(PATCH_ROW_ID) || patchText.includes('zat-dsh-engine')
  const mountedViaBundle = bundles.some(b => /zat-dsh-engine/i.test(String(b)))
  const installedInNodeModules = fs.existsSync(path.join(profileDir, 'node_modules', 'zat-dsh-engine'))
  // 实装版本：读引擎包自身 package.json 的 version（引擎更新检测的依据）
  let installedVersion = ''
  if (installedInNodeModules) {
    try {
      const enginePkg = JSON.parse(readMaybe(path.join(profileDir, 'node_modules', 'zat-dsh-engine', 'package.json')))
      installedVersion = String(enginePkg && enginePkg.version || '').trim()
    } catch { /* 包损坏时版本留空 */ }
  }
  return {
    mounted: mountedViaPatch || mountedViaBundle,
    mountedViaPatch,
    mountedViaBundle,
    installedInNodeModules,
    installedVersion,
    bundles,
    patchPath: profilePatchPath(profileDir),
    hasPatchFile: fs.existsSync(profilePatchPath(profileDir)),
  }
}

// 引擎远端版本探测源（官方 raw 优先，ghfast/gh-proxy 镜像回退；分支 main/master 都试）。
const ENGINE_VERSION_SOURCES = [
  'https://raw.githubusercontent.com/mishibeikejie/zat-dsh-engine/main/package.json',
  'https://raw.githubusercontent.com/mishibeikejie/zat-dsh-engine/master/package.json',
  'https://ghfast.top/https://raw.githubusercontent.com/mishibeikejie/zat-dsh-engine/main/package.json',
  'https://ghfast.top/https://raw.githubusercontent.com/mishibeikejie/zat-dsh-engine/master/package.json',
  'https://gh-proxy.com/https://raw.githubusercontent.com/mishibeikejie/zat-dsh-engine/main/package.json',
  'https://gh-proxy.com/https://raw.githubusercontent.com/mishibeikejie/zat-dsh-engine/master/package.json',
  'https://ghproxy.net/https://raw.githubusercontent.com/mishibeikejie/zat-dsh-engine/main/package.json',
  'https://ghproxy.net/https://raw.githubusercontent.com/mishibeikejie/zat-dsh-engine/master/package.json',
  'https://gh.llkk.cc/https://raw.githubusercontent.com/mishibeikejie/zat-dsh-engine/main/package.json',
  'https://gh.llkk.cc/https://raw.githubusercontent.com/mishibeikejie/zat-dsh-engine/master/package.json',
]

// 探测远端引擎最新版本：逐个源 3 秒超时快速切换（直连 → 镜像），任一命中即返回。
function probeEngineRemoteVersion(fetchImpl = fetch) {
  return async function probe() {
    for (const url of ENGINE_VERSION_SOURCES) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      try {
        const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'ZAT-Launcher' } })
        if (res && res.ok) {
          const data = await res.json()
          const v = String(data && data.version || '').trim()
          if (v) return v
        }
      } catch { /* 该源失败，切换下一个 */ }
      finally { clearTimeout(timer) }
    }
    return ''
  }
}

// 引擎更新检查：本地实装版本 vs 远端最新版本（npm 风格版本号比较）。
function checkEngineUpdate(profileDir, probe = null) {
  const info = detectEngine(profileDir)
  if (!info.installedInNodeModules) {
    return Promise.resolve({ ok: true, installed: false, installedVersion: '', remoteVersion: '', updateAvailable: false, message: '引擎未实装，先安装插件商店' })
  }
  const local = info.installedVersion || '未知'
  if (!probe) return Promise.resolve({ ok: true, installed: true, installedVersion: local, remoteVersion: '', updateAvailable: false, message: `当前 ${local}（未配置远端探测）` })
  return probe().then(remote => {
    if (!remote) return { ok: true, installed: true, installedVersion: local, remoteVersion: '', updateAvailable: false, checkFailed: true, message: `当前 ${local} · 网络暂不可用，未完成引擎更新检查` }
    const updateAvailable = local !== '未知' && compareVersions(remote, local) > 0
    return {
      ok: true,
      installed: true,
      installedVersion: local,
      remoteVersion: remote,
      updateAvailable,
      message: updateAvailable ? `发现新版本 ${remote}（当前 ${local}）` : `已是最新版本 ${local}`,
    }
  })
}

// npm 风格版本号比较（0.6.4 < 0.6.5 < 0.6.10；rc/beta/alpha 视为预发布，比正式版旧）
function compareVersions(a, b) {
  const parts = v => String(v || '').split(/[.\-]/).map(p => /^\d+$/.test(p) ? parseInt(p, 10) : (p === 'rc' || p === 'beta' || p === 'alpha' ? -1 : 0))
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = i < pa.length ? pa[i] : 0
    const y = i < pb.length ? pb[i] : 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// 修补引擎的 spawnShell：powershell 命令加 -WindowStyle Hidden，
// 避免引擎执行 shell/curl 命令时弹出 PowerShell 窗口（用户反复反馈的弹窗问题）。
// 引擎 lib/index.js 是编译产物，用正则精确替换 argv 构造（不匹配则不修改）。
function patchEngineNoWindow(engineDir) {
  try {
    const lib = path.join(engineDir, 'lib', 'index.js')
    if (!fs.existsSync(lib)) return false
    let c = fs.readFileSync(lib, 'utf8')
    if (c.includes('"-WindowStyle"')) return true // 已打过补丁
    const re = /(\t*)"-NoProfile",(\r?\n)(\t*)"-NonInteractive",(\r?\n)(\t*)"-Command",/
    const m = c.match(re)
    if (!m) return false
    const t1 = m[1]
    const nl = m[2]
    const t2 = m[3]
    const rep = `${t1}"-NoProfile",${nl}${t2}"-NonInteractive",${nl}${t2}"-WindowStyle",${nl}${t2}"Hidden",${nl}${t2}"-Command",`
    c = c.replace(re, rep)
    fs.writeFileSync(lib, c, 'utf8')
    return true
  } catch { return false }
}

// 下载引擎源码到 targetDir（官方优先，国内镜像回退；浅克隆，带进度）。
// force=true 时忽略"已存在跳过"（更新场景：目录里有旧版也必须重新克隆覆盖）。
// execute 未指定时构造带自举 git PATH 的默认执行器——git 调用绝不依赖系统 PATH（1.0.11 加固）。
async function downloadEngineTo(targetDir, onProgress, execute = run, { force = false } = {}) {
  // 默认执行器：把已自举的 git 目录（%TEMP%\zat-tools\git\cmd）前置到 PATH，
  // 保证无系统 git 的机器也能克隆（白板原则；调用方传入工具链 execute 时直接使用）。
  if (execute === run) {
    const gitDir = path.join(os.tmpdir(), 'zat-tools', 'git', 'cmd')
    if (fs.existsSync(gitDir)) {
      const baseEnv = { ...process.env, PATH: `${gitDir};${process.env.PATH || ''}` }
      const wrapped = (desc, file, args, cwd, onProg, timeout) => runWithProgress(desc, file, args, cwd, onProg, timeout, baseEnv)
      wrapped.env = baseEnv
      execute = wrapped
    }
  }
  if (!force && fs.existsSync(targetDir) && readMaybe(path.join(targetDir, 'package.json')).includes('zat-dsh-engine')) {
    if (onProgress) onProgress('引擎', `引擎源码已存在（${targetDir}），跳过下载`)
    return { ok: true, dir: targetDir, skipped: true }
  }
  fs.mkdirSync(path.dirname(targetDir), { recursive: true })
  const sources = updateSources(ENGINE_ORIGIN)
  let lastErr = ''
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]
    if (onProgress) onProgress('引擎', `探测下载源 ${i + 1}/${sources.length}：${source}`)
    const probe = await execute('git', ['ls-remote', '--heads', source], null, 3000)
    if (!probe.ok) { lastErr = `源 ${source} 不可达：${(probe.err || '超时').trim()}`; continue }
    if (onProgress) onProgress('引擎', `从 ${source} 克隆 zat-dsh-engine…`)
    const tmp = `${targetDir}.cloning`
    fs.rmSync(tmp, { recursive: true, force: true })
    const clone = await execute('git', ['clone', '--depth', '1', '--single-branch', source, tmp], undefined, 180000)
    if (!clone.ok) { lastErr = `克隆失败：${(clone.err || '').trim().split(/\r?\n/).pop()}`; fs.rmSync(tmp, { recursive: true, force: true }); continue }
    try {
      // 覆盖更新：先移除旧目录（renameSync 无法覆盖已存在目录）
      fs.rmSync(targetDir, { recursive: true, force: true })
      fs.renameSync(tmp, targetDir)
      // 下载后自动打"无窗口"补丁（防止引擎执行 powershell/curl 时弹窗）
      patchEngineNoWindow(targetDir)
      if (onProgress) onProgress('引擎', 'zat-dsh-engine 下载完成')
      return { ok: true, dir: targetDir }
    } catch (err) {
      lastErr = `移动目录失败：${err.message}`
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
  return { ok: false, message: lastErr || '引擎下载失败' }
}

// 生成要追加进 cordis.patch.yml 的插入块（与官方 cordis.patch.yml 同构）
function enginePatchBlock(mirror = 'https://gh-proxy.com/') {
  return `\n# Zat-DSH Engine bundle patch (inserted by ZAT 启动器)\n- insert:\n    - id: ${PATCH_ROW_ID}\n      name: zat-dsh-engine\n      config:\n        mirror: ${mirror}\n`
}

// 官方 bundle 方式：把 zat-dsh-engine 加入 profile package.json 的 dsh.profile.bundles（幂等）
function addEngineBundle(profileDir) {
  const pkgFile = path.join(profileDir, 'package.json')
  let pkg = {}
  try { pkg = JSON.parse(readMaybe(pkgFile) || '{}') } catch { pkg = {} }
  pkg.name = pkg.name || 'dsh-profile-web'
  pkg.private = pkg.private !== false
  pkg.dependencies = pkg.dependencies || {}
  const bundles = Array.isArray(pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles)
    ? pkg.dsh.profile.bundles
    : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  if (!bundles.some(b => /zat-dsh-engine/i.test(String(b)))) bundles.push('zat-dsh-engine')
  pkg.dsh = Object.assign(pkg.dsh || {}, { profile: Object.assign(pkg.dsh && pkg.dsh.profile || {}, { bundles }) })
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  return bundles
}

// 注入：优先官方 bundle 方式（注册到 package.json），同时写 patch 兜底，双轨挂载，幂等且备份。
function injectEngine(profileDir, { mirror = 'https://gh-proxy.com/', supported = true } = {}) {
  const patchFile = profilePatchPath(profileDir)
  if (!fs.existsSync(path.dirname(patchFile))) fs.mkdirSync(path.dirname(patchFile), { recursive: true })
  if (!supported) return { ok: false, message: '该 DSH 版本不支持引擎注入' }
  let current = readMaybe(patchFile)
  const before = detectEngine(profileDir)
  if (before.mounted) {
    return { ok: true, mounted: true, alreadyInjected: true, patchFile, message: 'zat-dsh-engine 已挂载，无需重复注入' }
  }
  if (current) fs.writeFileSync(`${patchFile}.bak`, current, 'utf8')
  // 双轨注入：bundle 注册 + patch 兜底
  const bundles = addEngineBundle(profileDir)
  if (!current.includes(PATCH_ROW_ID) && !current.includes('zat-dsh-engine')) {
    // ★ 1.5.6：现有内容为空/`[]` 时不能拼接——`[]` 后跟 `- insert:` 是非法 YAML，
    //   DSH parsePatchList 直接启动失败（实机事故）。空文件/空数组一律以 patch 块为新文档。
    const trimmed = String(current || '').trim()
    const base = trimmed && trimmed !== '[]' ? `${trimmed}\n` : ''
    fs.writeFileSync(patchFile, `${base}${enginePatchBlock(mirror)}`, 'utf8')
  }
  return { ok: true, mounted: true, injected: true, patchFile, bundles, message: '已注入 zat-dsh-engine（bundle 注册 + patch 兜底，均已备份）' }
}

// 验证：检测到挂载（bundle 或 patch，且 node_modules 实装），cordis.yml 是合法空列表（允许注释行），
// 并且引擎包真实安装到 profile/node_modules（dsh-app-boot 的 resolveBundleDir 能解析到）。
function verifyEngine(profileDir) {
  const info = detectEngine(profileDir)
  const rootYml = path.join(profileDir, 'cordis.yml')
  let rootValid = true
  if (fs.existsSync(rootYml)) {
    const text = readMaybe(rootYml)
    // 真实 DSH 的 cordis.yml 通常是「注释行 + []」，去掉注释后判断是否为空 entry list
    const meaningful = text.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).join('\n').trim()
    rootValid = meaningful === '[]' || meaningful === ''
  }
  const installed = info.installedInNodeModules
  const ok = info.mounted && rootValid && installed
  const message = !ok
    ? (installed ? 'cordis.yml 不是空 entry 列表' : 'zat-dsh-engine 未安装到 profile/node_modules')
    : ''
  return { ok, mounted: info.mounted, rootValid, installedInNodeModules: installed, message }
}

// 回滚：从 .bak 恢复 patch，删除注入行；并移除 package.json 中的引擎 bundle（非官方自带 bundle 才移除）
function restoreEngine(profileDir) {
  const patchFile = profilePatchPath(profileDir)
  const bak = `${patchFile}.bak`
  if (fs.existsSync(bak)) {
    fs.copyFileSync(bak, patchFile)
  } else {
    const text = readMaybe(patchFile)
    const marker = text.indexOf('# Zat-DSH Engine bundle patch')
    if (marker >= 0) fs.writeFileSync(patchFile, text.slice(0, marker).trimEnd() + '\n', 'utf8')
  }
  // 移除 package.json bundle 中的 zat-dsh-engine（若存在）
  let removed = false
  try {
    const pkgFile = path.join(profileDir, 'package.json')
    const pkg = JSON.parse(readMaybe(pkgFile) || '{}')
    if (Array.isArray(pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles)) {
      const next = pkg.dsh.profile.bundles.filter(b => !/zat-dsh-engine/i.test(String(b)))
      if (next.length !== pkg.dsh.profile.bundles.length) {
        pkg.dsh.profile.bundles = next
        fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
        removed = true
      }
    }
  } catch { /* 忽略 */ }
  return { ok: true, message: removed ? '已移除 zat-dsh-engine（patch 与 bundle）' : '已清除 zat-dsh-engine 注入', removed }
}

module.exports = {
  ENGINE_ORIGIN, PATCH_ROW_ID, ENGINE_VERSION_SOURCES,
  detectEngine, downloadEngineTo, patchEngineNoWindow, enginePatchBlock,
  injectEngine, verifyEngine, restoreEngine,
  probeEngineRemoteVersion, checkEngineUpdate, compareVersions,
}
