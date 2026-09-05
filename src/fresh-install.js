'use strict'

/* 全新安装管道：官方预构建包下载（npm registry）+ 可选镜像回退 + 失败清理。
 * 主路径 = npm 安装官方预构建包 @deepseek-ai/dsh（lib/bin.js 直接可用，零编译）。
 * 纯逻辑 + 可注入执行器，便于单元测试；不触碰任何外部 DSH 目录。 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile, spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { updateSources, compareVersions } = require('./harness-update')
const { wrapJsFile } = require('./toolchain-execute')

const DSH_ORIGIN = 'https://github.com/deepseek-ai/deepseek-harness.git'
const DSH_NPM_PACKAGE = '@deepseek-ai/dsh'
// 不固定标签：npm 上 latest 可能落后（如 latest=rc.7 而 next=rc.8），
// 且 pnpm add @next 的标签解析不可靠（实测 add @next 装出旧 rc.7）。
// 安装/更新统一走 resolveLatestDshVersion：动态查 dist-tags 取最新版本号，
// 用具体版本号安装（@deepseek-ai/dsh@0.1.0-rc.8），未来新 rc 自动跟随。
const DSH_NPM_TAG = 'next'
const NPM_REGISTRIES = [
  'https://registry.npmmirror.com/',
  'https://mirrors.cloud.tencent.com/npm/',
  'https://mirrors.huaweicloud.com/repository/npm/',
  'https://registry.npmjs.org/',
]
const SOURCE_TIMEOUT_MS = 3000

// ★ 工具目录归一化（1.0.12 修复）：Windows 的 %TEMP% 对长用户名/含空格用户名会展开成
// 8.3 短路径（如 C:\Users\FUTURE~1），node ESM loader 对短路径解析模块失败
// （ERR_MODULE_NOT_FOUND: .../pnpm.mjs，用户朋友机器实测）。统一用 fs.realpathSync
// 展开成完整长路径，所有工具（pnpm/npm/git/node）都用长路径，绝不使用短路径。
function normalToolsDir() {
  const t = os.tmpdir()
  try { return fs.realpathSync(t) } catch { return t }
}

// 执行器归一化：file 可为 { file, args } 对象（executablePnpm 的返回值），展开为 file+args。
// Node 24 无 shell 时 execFile(.cmd) 直接 EINVAL，pnpm 一律用 node <cjs> / .exe 形态。
function normalizeExec(file, args) {
  if (file && typeof file === 'object' && typeof file.file === 'string') {
    return wrapJsFile({ file: file.file, args: [...(file.args || []), ...args] })
  }
  return wrapJsFile({ file, args })
}

function run(file, args, cwd, timeout = 120000, env) {
  return new Promise(resolve => {
    const n = normalizeExec(file, args)
    const opts = { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout }
    if (env) opts.env = env
    execFile(n.file, n.args, opts, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error && error.code || 0, out: String(stdout || ''), err: String(stderr || error && error.message || '') })
    })
  })
}

// 带进度的执行：stdout/stderr 按行转发到 onProgress；env 可注入子进程环境（如把 node 目录加进 PATH）
function runWithProgress(description, file, args, cwd, onProgress, timeout = 600000, env) {
  return new Promise(resolve => {
    const n = normalizeExec(file, args)
    const opts = { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout }
    if (env) opts.env = env
    const child = execFile(n.file, n.args, opts, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error && error.code || 0, out: String(stdout || ''), err: String(stderr || error && error.message || '') })
    })
    const pump = stream => {
      if (!stream) return
      let pending = ''
      stream.on('data', chunk => {
        pending += chunk.toString()
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() || ''
        for (let line of lines) {
          line = line.trim()
          if (line && onProgress) onProgress(description, line)
        }
      })
      stream.on('end', () => { if (pending.trim() && onProgress) onProgress(description, pending.trim()) })
    }
    if (child.stdout) pump(child.stdout)
    if (child.stderr) pump(child.stderr)
  })
}

// 只读探测某个 git 源是否 3 秒内可达
async function probeSource(source, execute = run, timeoutMs = SOURCE_TIMEOUT_MS) {
  try {
    const r = await execute('git', ['ls-remote', '--heads', source], null, timeoutMs)
    return r.ok
  } catch { return false }
}

// 依次探测官方 + 国内镜像，返回第一个 3 秒内可达的源（无则返回官方兜底）
async function reachableSource(origin, onProgress, execute = run) {
  const sources = updateSources(origin)
  if (onProgress) onProgress('网络', `探测 ${sources.length} 个下载源…`)
  for (const source of sources) {
    if (onProgress) onProgress('网络', source)
    if (await probeSource(source, execute)) return source
  }
  if (onProgress) onProgress('网络', '全部源超时，回退官方源重试')
  return sources[0]
}

// 浅克隆 DSH 源码到 targetDir（官方优先，镜像回退，纯进度）
// execute 兼容 runWithProgress 签名：(description, file, args, cwd, onProgress, timeout) → {ok,...}
// probeExecute 兼容 run 签名：(file, args, cwd, timeout) → {ok,...}，用于 3 秒源探测
async function downloadDshTo(targetDir, onProgress, execute = runWithProgress, probeExecute = run) {
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length) {
    if (onProgress) onProgress('下载', `目录已存在（${targetDir}），跳过克隆`)
    return { ok: true, dir: targetDir, skipped: true }
  }
  fs.mkdirSync(path.dirname(targetDir), { recursive: true })
  const source = await reachableSource(DSH_ORIGIN, onProgress, probeExecute)
  if (onProgress) onProgress('下载', `从 ${source} 克隆 DSH（depth 1）…`)
  const tmp = `${targetDir}.cloning`
  fs.rmSync(tmp, { recursive: true, force: true })
  const r = await execute('下载', 'git', ['clone', '--depth', '1', '--single-branch', source, tmp], undefined, onProgress, 20 * 60 * 1000)
  if (!r.ok) {
    fs.rmSync(tmp, { recursive: true, force: true })
    const detail = (r.err || r.out || '').trim().split(/\r?\n/).pop()
    return { ok: false, message: `克隆失败（${source}）：${detail || r.err || '未知错误'}` }
  }
  if (!fs.existsSync(path.join(tmp, 'package.json'))) {
    fs.rmSync(tmp, { recursive: true, force: true })
    return { ok: false, message: '克隆结果缺少 package.json，已清理' }
  }
  try { fs.renameSync(tmp, targetDir) } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true })
    return { ok: false, message: `克隆完成但移动目录失败：${err.message}` }
  }
  if (onProgress) onProgress('下载', 'DSH 源码下载完成')
  return { ok: true, dir: targetDir }
}

// 定位已有 pnpm；工具目录已自举则优先复用（缓存），否则找系统 pnpm；都没有时从 npm 镜像自举
async function ensurePnpm({ nodeExe, toolsDir, onProgress, execute = run, skipOnline = false }) {
  // ★ 目录归一化（1.0.12）：无论调用方传什么（可能是 8.3 短路径），统一 realpath 长路径，
  //   否则 node ESM 对短路径解析失败（ERR_MODULE_NOT_FOUND，用户朋友机器实测）。
  const rawDir = toolsDir || path.join(normalToolsDir(), 'zat-tools')
  const dir = (() => { try { fs.mkdirSync(rawDir, { recursive: true }); return fs.realpathSync(rawDir) } catch { return normalToolsDir() + '\\zat-tools' } })()
  const cached = path.join(dir, 'pnpm.mjs')
  const nodeBin = nodeExe && nodeExe !== 'pnpm' ? nodeExe : 'node'
  // ★ 1.4.2 根修（权威结论见 PNPM_VERIFIED_VERSIONS）：主路径 = 官方 standalone pnpm.exe
  //   （仅已验证版本白名单，下载 zip→解压→体检），内置 mjs 仅作网络全挂的兜底。
  try {
    if (!skipOnline) {
      const latestVer = await probeRegistryPnpmLatest(nodeBin, dir)
      const target = pickVerifiedPnpmVersion(latestVer)
      if (target) {
        // ★ standalone 整体目录落位（pnpm.exe + dist 配对）
        const exeEntry = path.join(dir, `pnpm-${target}`, 'pnpm.exe')
        if (fs.existsSync(exeEntry)) {
          const r = await run(nodeBin, [exeEntry, '--version'], null, 20000)
          if (r.ok && String(r.out || '').trim() === target) {
            if (onProgress) onProgress('依赖', `pnpm 官方版就绪：${target}`)
            return exeEntry
          }
          try { fs.rmSync(exeEntry, { force: true }) } catch { /* 忽略 */ }
        }
        // ★ 1.5.2：下载前先复用系统已装的同版本 standalone pnpm（exe + dist 配对，
        //   本机已是最新就别再联网下载 39MB——用户明确不满"系统内置都最新还下载"）
        const local = await reuseLocalPnpmStandalone(target, dir)
        if (local) {
          if (onProgress) onProgress('依赖', `pnpm 复用本机已装官方版：${target}`)
          return local
        }
        const dl = await downloadPnpmStandalone(nodeBin, target, dir, onProgress)
        if (dl) return dl
        if (onProgress) onProgress('依赖', 'pnpm 官方版下载失败，回退内置…')
      }
    }
  } catch { /* 在线探测失败，走内置兜底 */ }
  // ===== 兜底：内置 mjs 资产（网络全挂时提供；官方 mjs 形态在 Windows 对最新依赖树
  //       有 worker 崩溃问题，仅用于旧依赖树/极端网络场景） =====
  // 内置资产（asarUnpack 物理文件）；★ 1.4.2：大小幂等比较——缓存与资产不一致（版本升级/损坏）
  // 一律重拷。老用户手里的旧版 pnpm.mjs（撞新依赖链 worker 崩溃：实测 11.7.0 崩 / 11.25.0 成）
  // 自动被升级，无需手删。
  const src = path.join(__dirname, '..', 'assets', 'pnpm.cjs')
  let srcSize = -1
  try { srcSize = fs.statSync(src).size } catch { /* 资产缺失走 findPnpm 兜底 */ }
  // ★ 1.4.0：缓存命中先体检（node pnpm.mjs --version）——损坏的 pnpm.mjs 被永久信任会让
  //   所有安装/更新报语法错误且永不自愈（同 npmCliHealthy/probeGit 的体检惯例）
  const healthy = async () => {
    try {
      const r = await run(nodeBin, [cached, '--version'], null, 8000)
      return r.ok && /\d+\.\d+/.test(r.out)
    } catch { return false }
  }
  if (fs.existsSync(cached)) {
    let sizeOk = true
    if (srcSize > 0) { try { sizeOk = fs.statSync(cached).size === srcSize } catch { sizeOk = false } }
    if (sizeOk && await healthy()) return cached
    if (onProgress) onProgress('依赖', '自举 pnpm 缓存与内置版本不一致/自检失败，正在刷新…')
    try { fs.rmSync(cached, { force: true }) } catch { /* 忽略 */ }
  }
  const existing = findPnpm()
  if (existing && srcSize <= 0) return existing
  // 内置 pnpm（assets/pnpm.cjs = 官方 dist/pnpm.mjs 单文件）：直接复制，零下载零安装。
  // asarUnpack 后 Electron 会把 asar 路径透明映射到 resources/app.asar.unpacked 物理文件，
  // 但显式探测物理路径更稳（打包机/便携版路径不同）。复制失败 = 安装包异常，如实抛出。
  // ★ 1.4.0：tmp + rename 原子落盘——两个进程并发冷启动（便携版换 userData 可双开）
  //   直接 copyFileSync 到目标会互相截断，产出损坏的 pnpm.mjs
  const tmp = `${cached}.${process.pid}.tmp`
  try {
    fs.copyFileSync(src, tmp)
    fs.renameSync(tmp, cached)
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
    fs.copyFileSync(src, cached)
  }
  if (!(await healthy())) {
    // 体检仍失败：再重拷一次（复制中断/杀软瞬时锁场景），尽力而为
    try {
      fs.rmSync(cached, { force: true })
      fs.copyFileSync(src, tmp)
      fs.renameSync(tmp, cached)
    } catch { /* 忽略 */ }
  }
  return cached
}

// ★ 1.4.2 根修：pnpm 在线自升级——内置版本永远可能落后（曾实测内置 11.7.0 撞新依赖链
//   worker 崩溃 / 11.22.0 成功）。根本解法 = 以 npm registry 的 pnpm@latest 为跟随目标：
//   每次工具链准备时探测（3 秒超时，6 小时 TTL），比内置新 → 下载官方单文件（sha512
//   完整性对 registry 元数据校验）→ 体检版本 === 目标 → 使用；任何失败静默回退内置。
//   未来 pnpm 再更新/修 bug，用户下次安装自动用上，永不依赖启动器发版。
const PNPM_LATEST_CACHE_NAME = 'pnpm-latest.json'
const PNPM_LATEST_TTL_MS = 6 * 60 * 60 * 1000
// ★ 权威结论（2026-09 实机矩阵验证）：pnpm 官方 npm 分发包 dist/pnpm.mjs 用 node 跑时
//   worker 在 Windows 上稳定崩溃（11.7/11.22/11.25 × node22/node24 × 新旧依赖树全崩，
//   错误 "Worker pnpm#N exited with code 1"，崩溃于 @modelcontextprotocol/sdk 依赖链）；
//   而官方 standalone 二进制（pnpm.exe，内嵌运行时）11.22.0/11.25.0 均真实安装成功。
//   → 主路径 = 下载官方 standalone zip（pnpm-win32-x64.zip，39MB，多镜像）解压出 pnpm.exe，
//   仅用「本启动器实机验证通过」的版本白名单，绝不自动跟未验证的最新版；mjs 仅作网络全挂兜底。
const PNPM_VERIFIED_VERSIONS = ['11.25.0', '11.22.0'] // 白名单：均以真实安装（@deepseek-ai/dsh 依赖树）验证
function pickVerifiedPnpmVersion(latestVer) {
  if (latestVer && PNPM_VERIFIED_VERSIONS.includes(latestVer)) return latestVer
  // 最新未验证：取白名单内最高（宁可慢一拍，不可踩上未验证的坑）
  return PNPM_VERIFIED_VERSIONS[0]
}

function probeRegistryPnpmLatest(nodeBin, toolsDir, timeoutMs = 3000) {
  const cacheFile = path.join(toolsDir || path.join(normalToolsDir(), 'zat-tools'), PNPM_LATEST_CACHE_NAME)
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    if (cached && cached.ver && Date.now() - Number(cached.at || 0) < PNPM_LATEST_TTL_MS) return Promise.resolve(String(cached.ver))
  } catch { /* 无缓存或损坏 */ }
  return new Promise(resolve => {
    const script = 'fetch(process.argv[1]).then(r=>r.json()).then(j=>console.log(j.latest||"")).catch(()=>process.exit(1))'
    run(nodeBin, ['-e', script, 'https://registry.npmjs.org/-/package/pnpm/dist-tags'], null, timeoutMs).then(r => {
      const ver = (r.ok && r.out || '').trim()
      if (!/^\d+\.\d+\.\d+/.test(ver)) return resolve('')
      try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
        fs.writeFileSync(cacheFile, JSON.stringify({ ver, at: Date.now() }), 'utf8')
      } catch { /* 缓存失败不阻断 */ }
      resolve(ver)
    }).catch(() => resolve(''))
  })
}

function verifySha512(file, integrity) {
  try {
    const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(String(integrity || ''))
    if (!m) return false
    const digest = require('node:crypto').createHash('sha512').update(fs.readFileSync(file)).digest('base64')
    return digest === m[1]
  } catch { return false }
}

// 下载官方 pnpm 单文件 dist/pnpm.mjs：registry 元数据（含 sha512 integrity）→ 下载 tgz →
// 校验 → 解压取 dist/pnpm.mjs → 原子落盘 <dir>/pnpm-<version>.mjs → 体检版本 === 目标。
function downloadPnpmDist(nodeBin, version, dir, onProgress = null) {
  const pkgRoot = `https://registry.npmjs.org/pnpm`
  return new Promise(resolve => {
    if (!/^\d+\.\d+\.\d+/.test(String(version || ''))) return resolve('')
    fs.mkdirSync(dir, { recursive: true })
    const metaUrl = `${pkgRoot}/${version}`
    run(nodeBin, ['-e', 'fetch(process.argv[1]).then(r=>r.json()).then(j=>console.log(j.dist&&j.dist.tarball||"")).catch(()=>process.exit(1))', metaUrl], null, 5000).then(metaR => {
      const tarball = (metaR.ok && metaR.out || '').trim()
      const integrityUrl = `${pkgRoot}/-/pnpm-${version}.tgz`
      if (!tarball) return resolve('')
      // integrity 与 tgz 一并取：npmjs 元数据带 dist.integrity；npmmirror 兼容
      run(nodeBin, ['-e', 'fetch(process.argv[1]).then(r=>r.json()).then(j=>console.log(j.dist&&j.dist.integrity||"")).catch(()=>process.exit(1))', metaUrl], null, 5000).then(metaR2 => {
        const integrity = (metaR2.ok && metaR2.out || '').trim()
        const tgz = path.join(dir, `pnpm-${version}.tgz`)
        const extract = path.join(dir, `pnpm-${version}.extract`)
        const final = path.join(dir, `pnpm-${version}.mjs`)
        const cleanup = () => {
          try { fs.rmSync(tgz, { force: true }) } catch { /* 忽略 */ }
          try { fs.rmSync(extract, { recursive: true, force: true }) } catch { /* 忽略 */ }
        }
        downloadFileNative(tarball, tgz, onProgress, 120000).then(r => {
          if (!r.ok || !fs.existsSync(tgz) || fs.statSync(tgz).size < 1000000) { cleanup(); return resolve('') }
          if (integrity && !verifySha512(tgz, integrity)) {
            if (onProgress) onProgress('依赖', 'pnpm 下载完整性校验失败，已丢弃')
            cleanup(); return resolve('')
          }
          try { fs.rmSync(extract, { recursive: true, force: true }) } catch { /* 忽略 */ }
          fs.mkdirSync(extract, { recursive: true })
          run('tar.exe', ['-xzf', tgz, '-C', extract], dir, 120000).then(extR => {
            if (!extR.ok) { cleanup(); return resolve('') }
            // pnpm 发布结构：dist/pnpm.mjs（单文件）；兼容旧结构 bin/pnpm.cjs
            const candidates = [
              path.join(extract, 'package', 'dist', 'pnpm.mjs'),
              path.join(extract, 'package', 'dist', 'pnpm.cjs'),
              path.join(extract, 'package', 'bin', 'pnpm.cjs'),
            ]
            const found = candidates.find(p => fs.existsSync(p) && fs.statSync(p).size > 5000000)
            if (!found) { cleanup(); return resolve('') }
            const tmp = `${final}.${process.pid}.tmp`
            try {
              fs.copyFileSync(found, tmp)
              fs.renameSync(tmp, final)
            } catch {
              try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
              return resolve('')
            }
            cleanup()
            run(nodeBin, [final, '--version'], null, 15000).then(v => {
              if (v.ok && String(v.out || '').trim() === version) {
                if (onProgress) onProgress('依赖', `已启用最新 pnpm ${version}`)
                resolve(final)
              } else resolve('')
            }).catch(() => resolve(''))
          }).catch(() => { cleanup(); resolve('') })
        }).catch(() => { cleanup(); resolve('') })
      }).catch(() => resolve(''))
    }).catch(() => resolve(''))
  })
}

// ★ 内置资产版本（缓存文件避免每次跑 12MB 脚本；TTL 6 小时）
function builtinPnpmVersion(nodeBin, dir) {
  const cacheFile = path.join(dir, 'pnpm-builtin.json')
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    if (cached && cached.ver && Date.now() - Number(cached.at || 0) < PNPM_LATEST_TTL_MS) return Promise.resolve(String(cached.ver))
  } catch { /* 无缓存 */ }
  const src = path.join(__dirname, '..', 'assets', 'pnpm.cjs')
  if (!fs.existsSync(src)) return Promise.resolve('')
  return new Promise(resolve => {
    run(nodeBin, [src, '--version'], null, 20000).then(r => {
      const ver = (r.ok && r.out || '').trim()
      if (!/^\d+\.\d+\.\d+/.test(ver)) return resolve('')
      try { fs.writeFileSync(cacheFile, JSON.stringify({ ver, at: Date.now() }), 'utf8') } catch { /* 忽略 */ }
      resolve(ver)
    }).catch(() => resolve(''))
  })
}

// ★ 1.4.2 统一：内置版本仅兜底，实际安装跟随上游最新（TTL 缓存 6h，失败回退内置）。
//   背景：内置 pnpm/npm/node/git 全部打包时钉死（11.7.0/11.3.0/v22.19.0/2.47.1），
//   一落后就撞上游新问题（实测内置 pnpm 11.7.0 崩 / 11.25.0 成）——跟随不是发版的事，是启动器的事。
function ttlCacheRead(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'))
    return c && c.ver && Date.now() - Number(c.at || 0) < 6 * 60 * 60 * 1000 ? String(c.ver) : ''
  } catch { return '' }
}
function ttlCacheWrite(file, ver) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ver, at: Date.now() }), 'utf8') } catch { /* 忽略 */ }
}
function probeRemoteVersion(nodeBin, script, url, cacheFile, timeoutMs = 6000) {
  return new Promise(resolve => {
    const cached = ttlCacheRead(cacheFile)
    if (cached) return resolve(cached)
    run(nodeBin, ['-e', script, url], null, timeoutMs).then(r => {
      const ver = (r.ok && r.out || '').trim()
      if (!/^[\d.]+$/.test(ver)) return resolve('')
      ttlCacheWrite(cacheFile, ver)
      resolve(ver)
    }).catch(() => resolve(''))
  })
}

const NODE_LATEST_SCRIPT = 'fetch(process.argv[1]).then(r=>r.json()).then(j=>{const v=(Array.isArray(j)?j:[]).find(x=>x.lts&&typeof x.version==="string");if(v)console.log(v.version)}).catch(()=>process.exit(1))'
// node：跟随 nodejs.org 最新 LTS（index.json 首个 lts 项；满足 DSH engines ^22.19||>=24）
async function latestNodeVersion(nodeBin, toolsDir) {
  for (const url of ['https://nodejs.org/dist/index.json', 'https://npmmirror.com/mirrors/node/index.json']) {
    const ver = await probeRemoteVersion(nodeBin, NODE_LATEST_SCRIPT, url, path.join(toolsDir, 'node-latest.json'), 8000)
    if (ver && /^\d+\.\d+\.\d+$/.test(ver)) return ver
  }
  return ''
}
const GIT_LATEST_SCRIPT = 'fetch(process.argv[1],{headers:{"User-Agent":"zat-launcher"}}).then(r=>r.json()).then(j=>{if(j&&j.tag_name)console.log(String(j.tag_name))}).catch(()=>process.exit(1))'
// git：跟随 git-for-windows 官方 latest release tag（v2.x.y.windows.N）
async function latestGitTag(nodeBin, toolsDir) {
  for (const url of [
    'https://api.github.com/repos/git-for-windows/git/releases/latest',
    'https://ghfast.top/https://api.github.com/repos/git-for-windows/git/releases/latest',
    'https://gh-proxy.com/https://api.github.com/repos/git-for-windows/git/releases/latest',
  ]) {
    const tag = await probeRemoteVersion(nodeBin, GIT_LATEST_SCRIPT, url, path.join(toolsDir, 'git-latest.json'), 8000)
    if (tag && /^\d+\.\d+\.\d+\.windows\.\d+$/.test(tag)) return tag
  }
  return ''
}
const NPM_TAG_SCRIPT = 'fetch(process.argv[1]).then(r=>r.json()).then(j=>console.log(j.latest||"")).catch(()=>process.exit(1))'
// npm：跟随 npm@latest，但守住 major=11|12（npm 10.x 的 arborist 解析 @deepseek-ai 依赖树会崩，历史结论）
async function latestNpmCLIVersion(nodeBin, toolsDir) {
  const ver = await probeRemoteVersion(nodeBin, NPM_TAG_SCRIPT, 'https://registry.npmjs.org/-/package/npm/dist-tags', path.join(toolsDir, 'npm-latest.json'), 4000)
  return /^(11|12)\.\d+\.\d+$/.test(ver) ? ver : ''
}

// ★ 1.5.2：复用本机已装的同版本 standalone pnpm——系统/LOCALAPPDATA/常见位置的
//   pnpm.exe（带 dist 配对）版本 === 目标时，本地复制进 zat-tools 缓存，零下载。
//   本机已最新还联网下载 39MB 纯属浪费（用户已装 11.25.0 仍触发下载的根因之一）。
async function reuseLocalPnpmStandalone(version, toolsDir) {
  const findCandidates = () => {
    const list = []
    const seen = new Set()
    const push = (p) => {
      try {
        if (!p || seen.has(String(p))) return
        seen.add(String(p))
        if (fs.existsSync(String(p))) list.push(String(p))
      } catch { /* 忽略 */ }
    }
    // 系统 PATH 里的 pnpm（pnpm 官方安装器/独立安装都落这里）
    const which = (name) => {
      try {
        const out = require('node:child_process').execFileSync('where.exe', [name], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 5000, windowsHide: true })
        for (const line of String(out).split(/\r?\n/)) {
          const t = line.trim().toLowerCase()
          if (t && (t.endsWith('pnpm.exe') || t.endsWith('pnpm.cmd') || t.endsWith('pnpm.cjs') || t.endsWith('pnpm.mjs'))) push(line.trim())
        }
      } catch { /* 不在 PATH */ }
    }
    which('pnpm')
    push(path.join(process.env.LOCALAPPDATA || '', 'pnpm', 'pnpm.exe'))
    push(path.join(process.env.LOCALAPPDATA || '', 'pnpm', 'pnpm.cjs'))
    push(path.join(process.env.LOCALAPPDATA || '', 'pnpm', 'pnpm.mjs'))
    push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'pnpm.exe'))
    push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
    push(path.join(process.env.APPDATA || '', 'npm', 'pnpm.cjs'))
    push(path.join(process.env.APPDATA || '', 'npm', 'pnpm.exe'))
    return list
  }
  const exeOf = (p) => {
    // .exe 直接用；.cmd 解析真实目标（官方 shim 内容形如 pnpm.exe 调用）；.cjs/.mjs 不适合复用
    const lower = String(p).toLowerCase()
    if (lower.endsWith('.exe')) return String(p)
    if (lower.endsWith('.cmd')) {
      try {
        const c = fs.readFileSync(String(p), 'utf8')
        const m = c.match(/"([^"]+\.exe)"/)
        if (m && fs.existsSync(m[1])) return m[1]
      } catch { /* 解析失败 */ }
    }
    return ''
  }
  for (const cand of findCandidates()) {
    try {
      const exe = exeOf(cand)
      if (!exe) continue
      // standalone 必须带 dist 配对（官方 zip 结构）；纯 .cmd shim 无 dist 跳过
      const distDir = path.join(path.dirname(exe), 'dist')
      if (!fs.existsSync(distDir)) continue
      const probe = await run(exe, ['--version'], null, 15000)
      if (!probe.ok || String(probe.out || '').trim() !== version) continue
      // 命中：整体复制 exe + dist → <toolsDir>/pnpm-<ver>/（原子：先临时目录后 rename）
      const exeDir = path.join(toolsDir, `pnpm-${version}`)
      const tmpDir = `${exeDir}.${process.pid}.tmp`
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
        fs.mkdirSync(tmpDir, { recursive: true })
        fs.copyFileSync(exe, path.join(tmpDir, 'pnpm.exe'))
        fs.cpSync(distDir, path.join(tmpDir, 'dist'), { recursive: true })
        const verify = await run(path.join(tmpDir, 'pnpm.exe'), ['--version'], null, 15000)
        if (!verify.ok || String(verify.out || '').trim() !== version) {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
          continue
        }
        fs.rmSync(exeDir, { recursive: true, force: true })
        fs.renameSync(tmpDir, exeDir)
        return path.join(exeDir, 'pnpm.exe')
      } catch {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
      }
    } catch { /* 单个候选失败继续 */ }
  }
  return ''
}

// ★ 下载官方 standalone pnpm（pnpm-win32-x64.zip → pnpm.exe）：多镜像 + 解压 + 版本体检。
//   返回 exe 路径；失败返回 ''（调用方回退 mjs 内置链）。
const PNPM_STANDALONE_MIRRORS = (ver) => [
  `https://github.com/pnpm/pnpm/releases/download/v${ver}/pnpm-win32-x64.zip`,
  `https://ghfast.top/https://github.com/pnpm/pnpm/releases/download/v${ver}/pnpm-win32-x64.zip`,
  `https://gh-proxy.com/https://github.com/pnpm/pnpm/releases/download/v${ver}/pnpm-win32-x64.zip`,
  `https://ghproxy.net/https://github.com/pnpm/pnpm/releases/download/v${ver}/pnpm-win32-x64.zip`,
  `https://gh.llkk.cc/https://github.com/pnpm/pnpm/releases/download/v${ver}/pnpm-win32-x64.zip`,
]
function downloadPnpmStandalone(nodeBin, version, dir, onProgress = null) {
  return new Promise(resolve => {
    if (!/^\d+\.\d+\.\d+$/.test(String(version || ''))) return resolve('')
    fs.mkdirSync(dir, { recursive: true })
    const zip = path.join(dir, `pnpm-${version}.win32.zip`)
    const extract = path.join(dir, `pnpm-${version}.win32.extract`)
    // ★ standalone 不是单文件：pnpm.exe 依赖同目录 dist/，必须整体目录落位
    const exeDir = path.join(dir, `pnpm-${version}`)
    const exe = path.join(exeDir, 'pnpm.exe')
    const cleanup = () => { try { fs.rmSync(zip, { force: true }) } catch { /* 忽略 */ } }
    ;(async () => {
      const names = PNPM_STANDALONE_MIRRORS(version)
      for (let i = 0; i < names.length; i++) {
        const url = names[i]
        if (onProgress) onProgress('依赖', `下载 pnpm 官方版（${version}，源 ${i + 1}/${names.length}）…`)
        const r = await downloadFileNative(url, zip, onProgress, 300000)
        if (!r.ok || !fs.existsSync(zip) || fs.statSync(zip).size < 5000000) { try { fs.rmSync(zip, { force: true }) } catch { /* 忽略 */ } continue }
        try { fs.rmSync(extract, { recursive: true, force: true }) } catch { /* 忽略 */ }
        fs.mkdirSync(extract, { recursive: true })
        const tar = await run('tar.exe', ['-xzf', zip, '-C', extract], dir, 180000)
        cleanup()
        if (!tar.ok) { try { fs.rmSync(extract, { recursive: true, force: true }) } catch { /* 忽略 */ } continue }
        const exeCandidate = path.join(extract, 'pnpm.exe')
        const distCandidate = path.join(extract, 'dist')
        if (!fs.existsSync(exeCandidate)) { try { fs.rmSync(extract, { recursive: true, force: true }) } catch { /* 忽略 */ } continue }
        const tmp = `${exe}.${process.pid}.tmp`
        try {
          fs.rmSync(exeDir, { recursive: true, force: true })
          fs.mkdirSync(exeDir, { recursive: true })
          fs.copyFileSync(exeCandidate, path.join(exeDir, 'pnpm.exe'))
          if (fs.existsSync(distCandidate)) fs.cpSync(distCandidate, path.join(exeDir, 'dist'), { recursive: true })
          fs.copyFileSync(exeCandidate, tmp)
          fs.renameSync(tmp, exe)
        } catch {
          try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
          try { fs.rmSync(extract, { recursive: true, force: true }) } catch { /* 忽略 */ }
          continue
        }
        try { fs.rmSync(extract, { recursive: true, force: true }) } catch { /* 忽略 */ }
        const ver = await run(exe, ['--version'], null, 20000) // ★ exe 直接执行（standalone 自带运行时）
        if (ver.ok && String(ver.out || '').trim() === version) {
          if (onProgress) onProgress('依赖', `pnpm 官方版就绪：${version}`)
          return resolve(exe)
        }
        try { fs.rmSync(exeDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
      }
      resolve('')
    })().catch(() => { cleanup(); resolve('') })
  })
}

function findPnpm() {
  // 只认 .cjs / .mjs / .exe：Node 24 的 execFile/spawn 对 .cmd 在无 shell 下直接 EINVAL，
  // 且 zat-tools 里的 pnpm.cmd 包装可能引用已消失的 node/pnpm.cjs（残留垃圾）。
  // .cjs/.mjs 由 executablePnpm 用 node 直接执行；.exe 系统 pnpm 优先（本机 11.22.0）。
  const toolDir = path.join(normalToolsDir(), 'zat-tools') // 长路径（8.3 短路径导致 ESM 解析失败）
  const candidates = [
    // ★ 1.4.2：官方 standalone pnpm（pnpm-<ver>\pnpm.exe + dist 配对，版本数字排序取最高）最优——
    //   mjs 形态在 Windows 对新依赖树有 worker 崩溃问题，绝不优先
    ...((() => {
      try {
        return fs.readdirSync(toolDir)
          .filter(n => /^pnpm-\d+\.\d+\.\d+$/.test(n) && fs.existsSync(path.join(toolDir, n, 'pnpm.exe')))
          .map(n => path.join(toolDir, n, 'pnpm.exe'))
          .sort((a, b) => {
            const pa = (/pnpm-([\d.]+)/.exec(a) || [])[1].split('.').map(Number)
            const pb = (/pnpm-([\d.]+)/.exec(b) || [])[1].split('.').map(Number)
            for (let i = 0; i < 4; i++) { const x = pa[i] || 0; const y = pb[i] || 0; if (x !== y) return y - x }
            return 0
          })
      } catch { return [] }
    })()),
    // ★ 1.5.2：顺序修正——mjs（Windows 对最新依赖树 worker 崩的兜底形态）绝不能排在
    //   系统 standalone exe 前面：系统已装 11.25.0 exe 时若先命中 zat-tools\pnpm.mjs 旧缓存，
    //   会绕开稳定的 standalone（且永远走不到系统 exe）。优先级：standalone 缓存 > 系统
    //   standalone > mjs/cjs 兜底。
    path.join(toolDir, 'pnpm.exe'),
    path.join(toolDir, 'pnpm.cjs'),
    // 系统 standalone（pnpm 官方安装器/独立安装）
    path.join(process.env.LOCALAPPDATA || '', 'pnpm', 'pnpm.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'pnpm', 'pnpm.cjs'),
    // 系统 nodejs 全局 pnpm
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    path.join(os.homedir(), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    // mjs 兜底（最后）
    path.join(toolDir, 'pnpm.mjs'),
    process.env.PNPM_MJS,
  ]
  // 常见开发工具自带的 pnpm（runtime 缓存，与 findNodeExe 同一套递归探测，不硬编码个人路径）
  const findUnderCache = (dir, depth) => {
    if (depth > 5) return null
    for (const sub of ['node_modules/pnpm/bin/pnpm.cjs', 'pnpm/pnpm.cjs', 'bin/pnpm.cjs']) {
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
  for (const c of candidates) if (c && fs.existsSync(c)) return c
  return ''
}

// 用 Node 原生 https/http 下载文件（不依赖外部 curl.exe，也绝不弹控制台窗口）。
// 返回 { ok }；onProgress(description, message) 透出进度。自动跟随 3xx 重定向。
function downloadFileNative(url, dest, onProgress, timeoutMs = 60000, redirects = 0) {
  return new Promise(resolve => {
    if (redirects > 5) return resolve({ ok: false, err: '重定向次数过多' })
    const lib = String(url).startsWith('https:') ? require('node:https') : require('node:http')
    const request = lib.get(url, { headers: { 'User-Agent': 'zat-launcher' } }, response => {
      const status = response.statusCode || 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        const next = new URL(response.headers.location, url).toString()
        return resolve(downloadFileNative(next, dest, onProgress, timeoutMs, redirects + 1))
      }
      if (status !== 200) { response.resume(); return resolve({ ok: false, err: `HTTP ${status}` }) }
      const total = Number(response.headers['content-length'] || 0)
      let received = 0
      const tmp = `${dest}.part`
      try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略：残留文件可能被占用，用带重试的打开覆盖 */ }
      // ★ 杀软扫描/占用导致的 EPERM 重试：国内用户机器常见（createWriteStream 报
      //   EPERM: operation not permitted, open '<path>'——朋友实机截图根因）。
      // ★ 1.4.0 修正：createWriteStream 的 EPERM 发生在【异步 open】，同步 try/catch 接不住
      //   （1.3.x 的重试是死代码），且写入流无 error 监听会变成主进程未捕获异常。
      //   改用 fs.openSync（同步抛错，重试真实生效）+ createWriteStream(null,{fd})，并挂 error。
      const openStream = () => new Promise((res, rej) => {
        let attempt = 0
        const tryOpen = () => {
          try {
            const fd = fs.openSync(tmp, 'w')
            res(fs.createWriteStream(null, { fd, autoClose: true }))
          } catch (err) {
            attempt += 1
            if (attempt >= 4) return rej(err)
            setTimeout(tryOpen, 500 * attempt)
          }
        }
        tryOpen()
      })
      const startPump = (out) => {
        out.on('error', err => {
          try { out.destroy() } catch { /* 忽略 */ }
          try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
          try { response.destroy() } catch { /* 忽略 */ }
          resolve({ ok: false, err: `写入临时文件失败：${err.message}` })
        })
        response.on('data', chunk => {
          received += chunk.length
          out.write(chunk)
          if (total && onProgress) onProgress('依赖', `下载中 ${Math.round(received / total * 100)}%`)
        })
        response.on('end', () => {
          out.end(() => {
            const finish = () => {
              withRetry(() => new Promise((res, rej) => fs.rename(tmp, dest, e => (e ? rej(e) : res()))), 4, 500)
                .then(() => resolve({ ok: true }))
                .catch((err) => { try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ } resolve({ ok: false, err: err.message }) })
            }
            finish()
          })
        })
        response.on('error', err => { try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ } resolve({ ok: false, err: err.message }) })
      }
      openStream()
        .then(startPump)
        .catch((err) => {
          response.resume()
          resolve({ ok: false, err: `写入临时文件失败：${err.message}` })
        })
    })
    request.setTimeout(timeoutMs, () => { request.destroy(); resolve({ ok: false, err: '下载超时' }) })
    request.on('error', err => resolve({ ok: false, err: err.message }))
  })
}

// 简单重试（杀软扫描/临时占用导致的 EPERM/EBUSY 常见，重试通常即通过）
async function withRetry(fn, times = 3, delayMs = 400, retryable = () => true) {
  let lastErr = null
  for (let i = 0; i < times; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!retryable(err) || i === times - 1) throw err
      await new Promise(res => setTimeout(res, delayMs * (i + 1)))
    }
  }
  throw lastErr
}

// ★ npm CLI 健康检查（2026-08 实测根因）：自举解压的 npm 包可能残留损坏——
// 曾出现 node_modules/node-gyp/bin/node-gyp.js 与 lib/commands/* 缺失（解压残留/杀软删除），
// 任何 `npm run ...` 都瞬间崩 MODULE_NOT_FOUND（exit 1），导致 DSH 更新构建全链失败。
// 体检标准：node <cli> --version 8 秒内成功输出 11.x，且 node_modules 与入口存在。
// ★ 1.4.0（U4）：支持注入 env（工具链 PATH 含 node 目录）——无系统 node 的机器上
//   'node' 也能解析，npm 路径不再被误跳过
async function npmCliHealthy(nodeExe, cliPath, env = undefined) {
  try {
    if (!cliPath || !fs.existsSync(cliPath)) return false
    const r = await run(nodeExe, [cliPath, '--version'], null, 8000, env)
    if (!r.ok) return false
    if (!/^\s*\d+\.\d+\.\d+/.test(r.out)) return false
    const pkgRoot = path.dirname(path.dirname(cliPath))
    if (!fs.existsSync(path.join(pkgRoot, 'node_modules'))) return false
    return true
  } catch { return false }
}

// 下载 tgz 并解压 package/bin 下的 CLI 入口（pnpm.cjs 或 npm-cli.js），返回入口路径。
// 注意：npm-cli.js 依赖同包 ../lib/*，必须保留整个解压目录，不能单独拷出入口。
async function downloadCliTgz(url, dir, version, onProgress) {
  const tgz = path.join(dir, `cli-${version}.tgz`)
  try {
    const r = await downloadFileNative(url, tgz, onProgress)
    if (!r.ok || !fs.existsSync(tgz) || fs.statSync(tgz).size < 1000) { fs.rmSync(tgz, { force: true }); return '' }
    const extractDir = path.join(dir, `package-${version}`)
    fs.rmSync(extractDir, { recursive: true, force: true })
    fs.mkdirSync(extractDir, { recursive: true })
    const tar = await run('tar.exe', ['-xzf', tgz, '-C', extractDir], dir, 120000)
    if (!tar.ok) { fs.rmSync(extractDir, { recursive: true, force: true }); return '' }
    const binDir = path.join(extractDir, 'package', 'bin')
    const entry = fs.existsSync(path.join(binDir, 'pnpm.cjs'))
      ? path.join(binDir, 'pnpm.cjs')
      : fs.existsSync(path.join(binDir, 'npm-cli.js'))
        ? path.join(binDir, 'npm-cli.js')
        : ''
    if (!entry) { fs.rmSync(extractDir, { recursive: true, force: true }); return '' }
    // pnpm.cjs 是自包含单文件可拷出；npm-cli.js 依赖同包，保留整个 package-<version> 目录
    if (entry.endsWith('pnpm.cjs')) {
      fs.copyFileSync(entry, path.join(dir, 'pnpm.cjs'))
      fs.rmSync(extractDir, { recursive: true, force: true })
      fs.rmSync(tgz, { force: true })
      return path.join(dir, 'pnpm.cjs')
    }
    fs.rmSync(tgz, { force: true })
    return entry
  } catch { return '' }
}

// 安装依赖（+可选构建）。默认只装依赖：DSH 可用 tsx 源码模式直接运行（node --import tsx/esm apps/cli/src/bin.ts），
// 无需全量 tsc/tsdown/web 构建——这才是"下载即用"的快速路径（clone + install 仅数分钟）。
async function installDependencies(dshDir, pnpmCjs, nodeExe, onProgress, execute = runWithProgress, { build = false } = {}) {
  // 把 node 可执行目录注入 PATH：pnpm 的原生包 postinstall（node-pty/esbuild/koffi/lefthook）
  // 会调用裸 `node`，若机器上 node 不在 PATH 则安装失败。任何环境都必须可装。
  const nodeBinDir = nodeExe && nodeExe !== 'pnpm' ? path.dirname(nodeExe) : ''
  const envForPnpm = nodeBinDir
    ? { ...process.env, PATH: `${nodeBinDir};${process.env.PATH || ''}` }
    : undefined
  const runPnpm = (description, args, timeout) => {
    const cmd = pnpmCjs === 'pnpm'
      ? { file: 'pnpm', args }
      : { file: nodeExe, args: [pnpmCjs, ...args] }
    return execute(description, cmd.file, cmd.args, dshDir, onProgress, timeout, envForPnpm)
  }
  if (onProgress) onProgress('依赖', '开始安装依赖（可能较久，进度实时可见）…')
  const registry = await pickRegistry(nodeExe)
  if (onProgress) onProgress('依赖', `使用 npm registry：${registry}`)
  const install = await runPnpm('依赖', ['install', '--registry', registry], 15 * 60 * 1000)
  if (!install.ok) {
    const detail = (install.err || install.out || '').trim().split(/\r?\n/).slice(-3).join(' | ')
    return { ok: false, step: 'install', message: `依赖安装失败：${detail}` }
  }
  if (build) {
    if (onProgress) onProgress('构建', '开始构建 DSH（build:lib + build:web，可能较久）…')
    const buildResult = await runPnpm('构建', ['run', 'build'], 25 * 60 * 1000)
    if (!buildResult.ok) {
      const detail = (buildResult.err || buildResult.out || '').trim().split(/\r?\n/).slice(-3).join(' | ')
      return { ok: false, step: 'build', message: `构建失败：${detail}` }
    }
    if (onProgress) onProgress('构建', '构建完成')
  } else if (onProgress) {
    onProgress('依赖', '依赖安装完成（跳过全量构建，将使用 tsx 源码模式运行）')
  }
  return { ok: true }
}

// 选择一个 3 秒内可达的 npm registry：官方优先，否则国内 npmmirror
async function pickRegistry(nodeExe, execute = run) {
  const probe = 'require("node:https").get(process.argv[1], r=>{r.resume();process.exit(0)}).on("error",()=>process.exit(1));setTimeout(()=>process.exit(2),3000)'
  const bin = nodeExe || process.execPath
  // 镜像优先（1.0.9 修复）：国内用户直连 npmjs 慢/断，npmmirror 快且稳；
  // 官方源仅作为镜像不可用时的兜底（先测镜像，再测官方）。
  for (const url of NPM_REGISTRIES) {
    const r = await execute(bin, ['-e', probe, url], null, 5000)
    if (r.ok && r.code === 0) return url
  }
  return 'https://registry.npmmirror.com/'
}

// npm 包级工具自举：下载 npm-cli 到 toolsDir（npm registry 官方/国内镜像，3 秒超时切换）。
// 用 11.x：npm 10.9.2 的 arborist 解析 @deepseek-ai/dsh 依赖树会崩溃（Link.matches null，npm 已知 bug）。
// ★ 1.4.2：内置默认 = 当前 latest（12.0.2）；在线探测 latest 优先（major 11|12），
//   每版体检（npmCliHealthy）不过自动换下一版；npm 12 若遇新问题，回退链稳稳保住。
async function ensureNpmCli({ nodeExe, toolsDir, onProgress, execute = runWithProgress }) {
  const dir = toolsDir || path.join(normalToolsDir(), 'zat-tools')
  let versionsToTry = ['12.0.2', '11.3.0']
  try {
    const latest = await latestNpmCLIVersion(nodeExe, dir)
    if (latest && !versionsToTry.includes(latest)) versionsToTry.unshift(latest)
  } catch { /* 探测失败用内置 */ }
  if (onProgress && versionsToTry[0] !== '12.0.2') onProgress('依赖', `npm CLI 目标版本：${versionsToTry[0]}`)
  let lastVer = versionsToTry[0]
  for (const version of versionsToTry) {
    lastVer = version
    // 缓存命中：兼容两种结构（tar 解压 package-<v>/package/bin 与 直接 package-<v>/bin），逐一体检
    for (const sub of [`package-${version}`, 'package']) {
      for (const inner of ['package', '']) {
        const candidate = path.join(dir, sub, inner, 'bin', 'npm-cli.js')
        if (!fs.existsSync(candidate)) continue
        const healthy = await npmCliHealthy(nodeExe, candidate)
        if (healthy) return candidate
        // 坏缓存：移除，走重新下载修复
        if (onProgress) onProgress('依赖', `npm CLI 自检失败（${sub}），正在重新下载修复…`)
        try { fs.rmSync(path.join(dir, sub), { recursive: true, force: true }) } catch { /* 移除失败交给下载流程覆盖 */ }
        break
      }
    }
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i < NPM_REGISTRIES.length; i++) {
      const base = NPM_REGISTRIES[i].replace(/\/$/, '')
      const url = `${base}/npm/-/npm-${version}.tgz`
      if (onProgress) onProgress('依赖', `下载 npm CLI（${version}，源 ${i + 1}/${NPM_REGISTRIES.length}）…`)
      const entry = await downloadCliTgz(url, dir, version, onProgress)
      if (entry && (await npmCliHealthy(nodeExe, entry))) return entry
      if (entry && onProgress) onProgress('依赖', 'npm CLI 下载后自检失败，切换下一源…')
    }
    if (onProgress && version !== versionsToTry[versionsToTry.length - 1]) onProgress('依赖', `npm CLI ${version} 全部源失败，回退下一版本…`)
  }
  if (onProgress) onProgress('依赖', `npm CLI 自举失败：${lastVer}`)
  throw new Error('无法自举 npm CLI（registry 均不可用）')
}

// 确保 toolsDir 里有可执行的 npm.cmd（DSH build 脚本直接调 `npm run ...`）。
// 本机往往没有全局 npm，这里用自举的 npm-cli.js 生成一个 npm.cmd 包装（幂等）。
// ★ 幂等校验：已有 npm.cmd 必须体检其引用的 npm-cli；坏引用（残留/路径失效）重新生成。
// 返回 npm.cmd 路径；失败返回 ''（调用方决定是否降级）。
async function ensureNpmCommand({ nodeExe, toolsDir, onProgress, execute = runWithProgress }) {
  try {
    const dir = toolsDir || path.join(normalToolsDir(), 'zat-tools')
    const npmCmd = path.join(dir, 'npm.cmd')
    if (fs.existsSync(npmCmd)) {
      // 体检 npm.cmd 引用的 npm-cli 是否真能用（引用路径可能因重新解压/结构变化而失效）
      const m = fs.readFileSync(npmCmd, 'utf8').match(/"([^"]+npm-cli\.js)"/)
      if (m && (await npmCliHealthy(nodeExe, m[1]))) return npmCmd
      try { fs.rmSync(npmCmd, { force: true }) } catch { /* 忽略 */ }
    }
    const cli = await ensureNpmCli({ nodeExe, toolsDir: dir, onProgress, execute })
    if (!cli || !fs.existsSync(cli)) return ''
    const nodePath = String(nodeExe || 'node').replace(/"/g, '')
    const cliPath = String(cli).replace(/"/g, '')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(npmCmd, `@echo off\r\n"${nodePath}" "${cliPath}" %*\r\n`, 'utf8')
    return npmCmd
  } catch { return '' }
}

// 更新/构建工具链自举（白板原则：任何机器双击即用，不依赖预装 Node/npm/pnpm/git）。
// 返回 { pnpmExe, env }：pnpmExe 可直接执行；env.PATH 已注入 node、pnpm、npm、git 所在目录，
// 保证 DSH build 脚本里的 `node`/`pnpm`/`npm` 命令和更新/插件安装的 `git` 命令都能找到。
async function ensureUpdateToolchain({ nodeExe, toolsDir, onProgress, execute = runWithProgress }) {
  // ★ 目录归一化（1.0.12）：toolsDir 可能是 8.3 短路径，realpath 展开成长路径
  //   （ESM 对短路径解析模块失败，用户朋友机器实测 ERR_MODULE_NOT_FOUND）。
  let dir = toolsDir || path.join(normalToolsDir(), 'zat-tools')
  fs.mkdirSync(dir, { recursive: true })
  try { dir = fs.realpathSync(dir) } catch { /* 保持原样 */ }
  const extraDirs = []
  // 1) node：传入或用自举缓存
  let node = String(nodeExe || findCachedNode(dir) || '').trim()
  if (!node) {
    try {
      const info = await ensureNodeExe({ nodeExe: '', toolsDir: dir, onProgress, execute })
      if (info.ok) node = String(info.nodeExe || '')
    } catch { node = '' }
  }
  if (node && node.toLowerCase() !== 'node') extraDirs.push(path.dirname(node))
  const nodePath = node || 'node'
  // 2) npm.cmd（DSH build 脚本直接调 npm）——必须排在 node 目录之前，
  //    否则命中 node 发行版自带的旧 npm（10.x arborist 崩溃）。zat-tools 里的 npm.cmd 是 11.3.0。
  const npmCmd = await ensureNpmCommand({ nodeExe: nodePath, toolsDir: dir, onProgress, execute })
  const npmFirstDirs = []
  if (npmCmd) npmFirstDirs.push(dir)
  // 3) pnpm：系统 pnpm 优先，否则自举 cjs。绝不生成 .cmd 包装（Node 24 execFile(.cmd) EINVAL），
  //    .cjs 由 executablePnpm 用 node 执行；env.PATH 加 node/pnpm 目录供 DSH build 的 pnpm 命令解析。
  let pnpmExe = ''
  try { pnpmExe = findPnpm() } catch { pnpmExe = '' }
  if (!pnpmExe || !fs.existsSync(pnpmExe)) {
    try { pnpmExe = await ensurePnpm({ nodeExe: nodePath, toolsDir: dir, onProgress, execute }) } catch { pnpmExe = '' }
  }
  if (pnpmExe) {
    if (/\.exe$/i.test(pnpmExe)) {
      extraDirs.push(path.dirname(pnpmExe))
    } else if (/\.cjs$/i.test(pnpmExe)) {
      // node 目录已在 extraDirs（上面 node 分支）；cjs 所在目录一并加入，便于 pnpm 相关工具解析
      extraDirs.push(path.dirname(pnpmExe))
    }
  }
  // ★ 1.4.0：生成 pnpm.cmd 包装——DSH 构建脚本（master 的 build:web = 裸 `pnpm --filter ...`）
  //   由 npm run 经 cmd shell 执行，需要 PATH 上可解析 pnpm；我们自己的 execFile 一律
  //   node <cjs>，不受 Node24 execFile(.cmd) EINVAL 影响（shim 仅供脚本环境解析）。
  //   没有系统 pnpm 的白板机器上，缺这个 shim 会让 build:web ENOENT → 更新永远回滚。
  try {
    const shim = path.join(dir, 'pnpm.cmd')
    // ★ 1.4.2：shim 目标优先官方 standalone（.exe 直接调用，不经 node）；无 exe 才用 mjs/cjs
    const pnpmEntry = /\.exe$/i.test(String(pnpmExe)) ? String(pnpmExe)
      : fs.existsSync(path.join(dir, 'pnpm.exe')) ? path.join(dir, 'pnpm.exe')
        : /\.(mjs|cjs)$/i.test(String(pnpmExe)) ? String(pnpmExe)
          : path.join(dir, 'pnpm.mjs')
    if (pnpmEntry && pnpmEntry.endsWith('.exe')) {
      const want = `@echo off\r\n"${pnpmEntry}" %*\r\n`
      let needWrite = true
      try { needWrite = fs.readFileSync(shim, 'utf8') !== want } catch { needWrite = true }
      if (needWrite) fs.writeFileSync(shim, want, 'utf8')
    } else if (nodePath && fs.existsSync(pnpmEntry)) {
      const want = `@echo off\r\n"${nodePath}" "${pnpmEntry}" %*\r\n`
      let needWrite = true
      try { needWrite = fs.readFileSync(shim, 'utf8') !== want } catch { needWrite = true }
      if (needWrite) fs.writeFileSync(shim, want, 'utf8')
    }
  } catch { /* shim 失败不阻断（有系统 pnpm 的机器不需要） */ }
  // 4) git：系统 git 优先，没有则自举 PortableGit 到 zat-tools\git（官方 GitHub → ghfast/gh-proxy 镜像）
  const gitExe = await ensureGit({ toolsDir: dir, onProgress, execute })
  if (gitExe) extraDirs.push(path.dirname(gitExe))
  // npm 目录必须排最前（覆盖 node 发行版自带的旧 npm）；其后 node/pnpm/git/系统 PATH
  const env = { ...process.env, PATH: [...npmFirstDirs, ...extraDirs, process.env.PATH || ''].filter(Boolean).join(';') }
  return { pnpmExe: pnpmExe || '', nodeExe: nodePath, env }
}

// 定位 git：系统 PATH/常见位置优先；都没有时自举 PortableGit 到 toolsDir/git（幂等，已装则跳过）。
// 返回 git.exe 绝对路径；失败返回 ''（调用方用系统 'git' 兜底）。
// ★ 1.4.2：跟随官方 latest release tag（失败回退内置 2.47.1 列表）。
const GIT_BUILTIN_TAG = 'v2.55.0.windows.5'
const GIT_BUILTIN_VER = '2.55.0'
const GIT_HOSTS = [
  (u) => u,
  (u) => `https://ghfast.top/${u}`,
  (u) => `https://ghproxy.net/${u}`,
  (u) => `https://gh.llkk.cc/${u}`,
  (u) => `https://gh-proxy.com/${u}`,
  (u) => `https://ghproxy.com/${u}`,
]
function gitPortableUrls(tag, ver) {
  const official = `https://github.com/git-for-windows/git/releases/download/${tag}/PortableGit-${ver}-64-bit.7z.exe`
  return GIT_HOSTS.map(f => f(official))
}

function findSystemGit() {
  const candidates = []
  try {
    const which = require('node:child_process').execFileSync('where.exe', ['git'], { stdio: 'pipe', encoding: 'utf8', windowsHide: true })
    for (const line of String(which || '').split(/\r?\n/)) {
      const t = line.trim().toLowerCase()
      if (t && (t.endsWith('git.exe') || t.endsWith('git.cmd'))) candidates.push(line.trim())
    }
  } catch { /* 无系统 git */ }
  const common = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
  ]
  for (const c of common) if (fs.existsSync(c)) candidates.push(c)
  return candidates.find(c => fs.existsSync(c)) || ''
}

// 自举 PortableGit：下载 .7z.exe 自解压包并静默解压（-y -gm2 -o"<dir>"），然后清理自解压壳。
async function ensureGit({ toolsDir, onProgress, execute = run }) {
  try {
    const dir = toolsDir || path.join(normalToolsDir(), 'zat-tools')
    const gitDir = path.join(dir, 'git')
    const gitExe = path.join(gitDir, 'cmd', 'git.exe')
    // ★ 体检后复用（同 npmCliHealthy 的教训）：git.exe 存在但解压不全/DLL 丢失时，
    //   任何 git 调用都崩——更新检查会假报"网络暂不可用"（静默掩蔽故障类）。
    const probeGit = async (exe) => {
      try {
        const r = await run(exe, ['--version'], null, 6000)
        return r.ok && /git version/i.test(r.out) ? true : false
      } catch { return false }
    }
    if (fs.existsSync(gitExe) && await probeGit(gitExe)) return gitExe
    if (fs.existsSync(gitExe)) {
      if (onProgress) onProgress('git', '缓存 PortableGit 自检失败，重新自举…')
      try { fs.rmSync(gitDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
    const system = findSystemGit()
    if (system) return system
    fs.mkdirSync(dir, { recursive: true })
    // ★ 1.4.2：跟随官方 latest（失败回退内置 2.47.1 列表）
    let urls = gitPortableUrls(GIT_BUILTIN_TAG, GIT_BUILTIN_VER)
    try {
      if (onProgress) onProgress('git', '探测 git-for-windows 最新版本…')
      const latestTag = await latestGitTag(String(findNodeExe() || 'node'), dir)
      if (latestTag) {
        const latestVer = latestTag.replace(/^v/, '').replace(/\.windows\.\d+$/, '')
        urls = gitPortableUrls(latestTag, latestVer)
        if (onProgress) onProgress('git', `PortableGit 目标版本：${latestVer}`)
      }
    } catch { /* 探测失败用内置 */ }
    let lastErr = ''
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]
      if (onProgress) onProgress('git', `下载 PortableGit（${i + 1}/${urls.length}：${url.slice(0, 60)}…）`)
      const pkg = path.join(dir, `portable-git-${i}.7z.exe`)
      const r = await downloadFileNative(url, pkg, onProgress)
      if (!r.ok || !fs.existsSync(pkg) || fs.statSync(pkg).size < 1000000) { fs.rmSync(pkg, { force: true }); lastErr = `源 ${i + 1} 下载失败（${r.err || '无输出'}）`; continue }
      if (onProgress) onProgress('git', '解压 PortableGit（自解压，约 1-2 分钟）…')
      const ex = await run(pkg, ['-y', '-gm2', `-o"${gitDir}"`], dir, 10 * 60 * 1000)
      fs.rmSync(pkg, { force: true })
      if (ex.ok && fs.existsSync(gitExe) && await probeGit(gitExe)) {
        if (onProgress) onProgress('git', `PortableGit 就绪：${gitExe}`)
        return gitExe
      }
      lastErr = `解压后自检失败（${(ex.err || '').slice(0, 120)}）`
      fs.rmSync(gitDir, { recursive: true, force: true })
    }
    if (onProgress) onProgress('git', `PortableGit 自举失败：${lastErr || '未知错误'}`)
    return ''
  } catch { return '' }
}

// 确保有可用的 Node.js：给定探测结果为空时，自动下载 Windows 便携版（官方 → 国内镜像，多版本回退）。
// 解决普遍性问题：普通用户机器可能没有 Node，DSH 启动/安装必须能自动获取运行时。
// 返回 { ok, nodeExe, downloaded }；失败返回 { ok:false, message }。
function findCachedNode(toolsDir) {
  try {
    if (!fs.existsSync(toolsDir)) return ''
    for (const ent of fs.readdirSync(toolsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const exe = path.join(toolsDir, ent.name, 'node.exe')
      if (fs.existsSync(exe)) return exe
    }
  } catch { /* 目录不可读 */ }
  return ''
}
async function ensureNodeExe({ nodeExe, toolsDir, onProgress, execute = runWithProgress }) {
  if (nodeExe) {
    // 无论 node 来源（PATH/系统/缓存），都确保共享副本存在（%TEMP%\zat-tools\node.exe），
    // 插件市场按 0.6.4 约定探测该位置，任何电脑上都要对得上。
    try {
      const sharedDir = path.join(normalToolsDir(), 'zat-tools')
      fs.mkdirSync(sharedDir, { recursive: true })
      const sharedNode = path.join(sharedDir, 'node.exe')
      if (!fs.existsSync(sharedNode)) {
        let src = nodeExe
        if (nodeExe === 'node') {
          try { src = require('node:child_process').execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim() } catch { src = '' }
        }
        if (src && fs.existsSync(src)) {
          try { fs.linkSync(src, sharedNode) } catch { fs.copyFileSync(src, sharedNode) }
        }
      }
    } catch { /* 共享目录失败不影响主路径 */ }
    return { ok: true, nodeExe }
  }
  fs.mkdirSync(toolsDir, { recursive: true })
  const cached = findCachedNode(toolsDir)
  if (cached) {
    // 缓存命中也要同步共享副本（%TEMP%\zat-tools\node.exe）——系统清理 TEMP 后市场探测位会缺失
    try {
      const sharedDir = path.join(normalToolsDir(), 'zat-tools')
      fs.mkdirSync(sharedDir, { recursive: true })
      const sharedNode = path.join(sharedDir, 'node.exe')
      if (!fs.existsSync(sharedNode)) {
        try { fs.linkSync(cached, sharedNode) } catch { fs.copyFileSync(cached, sharedNode) }
      }
    } catch { /* 共享目录失败不影响主路径 */ }
    return { ok: true, nodeExe: cached, downloaded: false }
  }
  const versions = ['v24.20.0', 'v22.20.0', 'v22.19.0'] // 全部满足 DSH engines: ^22.19.0 || >=24.0.0（★ 1.4.2 内置最新 LTS）
  // ★ 1.4.2：跟随最新 LTS 优先（内置列表仅兜底）；失败/离线走内置列表
  try {
    const latest = await latestNodeVersion(String(nodeExe || 'node'), toolsDir)
    if (latest) {
      const vv = `v${latest}`
      if (!versions.includes(vv)) versions.unshift(vv)
    }
    if (onProgress && latest) onProgress('Node', `Node 目标版本：最新 LTS（${latest}）`)
  } catch { /* 探测失败走内置列表 */ }
  const bases = ['https://nodejs.org/dist', 'https://npmmirror.com/mirrors/node', 'https://mirrors.huaweicloud.com/nodejs', 'https://mirrors.aliyun.com/nodejs-release']
  let lastErr = ''
  for (const version of versions) {
    for (const base of bases) {
      const folder = `node-${version}-win-x64`
      const url = `${base}/${version}/${folder}.zip`
      const zip = path.join(toolsDir, `${folder}.zip`)
      if (onProgress) onProgress('Node', `下载 Node.js ${version}（${base.includes('npmmirror') ? '国内镜像' : '官方源'}）…`)
      const dl = await downloadFileNative(url, zip, onProgress, 90000)
      if (!dl.ok) { lastErr = String(dl.err || '下载失败'); continue }
      const r = await execute('Node', 'powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Path '${zip}' -DestinationPath '${toolsDir}' -Force`], toolsDir, onProgress, 120000)
      try { fs.rmSync(zip, { force: true }) } catch { /* 忽略 */ }
      const exe = path.join(toolsDir, folder, 'node.exe')
      if (fs.existsSync(exe)) {
        const ver = await execute('Node', exe, ['-v'], toolsDir, onProgress, 10000)
        if (ver.ok) {
          // 与插件市场共享：把 node.exe 同步到 %TEMP%\zat-tools（市场探测位），双方不重复下载。
          // 硬链接优先（同盘省空间），失败退复制；已存在则跳过。
          try {
            const sharedDir = path.join(normalToolsDir(), 'zat-tools')
            fs.mkdirSync(sharedDir, { recursive: true })
            const sharedNode = path.join(sharedDir, 'node.exe')
            if (!fs.existsSync(sharedNode)) {
              try { fs.linkSync(exe, sharedNode) } catch { fs.copyFileSync(exe, sharedNode) }
            }
          } catch { /* 共享目录失败不影响主路径 */ }
          return { ok: true, nodeExe: exe, downloaded: true }
        }
        lastErr = 'Node 校验失败'
      }
    }
  }
  return { ok: false, message: `未找到可用的 Node.js 且自动下载失败（${lastErr || '全部源不可达'}）。请安装 Node.js 后重试。` }
}

// 返回可直接执行的 pnpm：.cjs（自举形态）在 Windows 上不能直接 spawn，
// 生成 pnpm.cmd 包装（node <cjs> %*）并返回包装路径；exe/cmd 原样返回。
// pnpm 可执行形态 → { file, args }（执行器直接展开）。
//  - .exe：直接执行
//  - .cjs：用 node 执行（Node 24 无 shell 时 execFile(.cmd) 直接 EINVAL，
//           .cjs 更不可能被 CreateProcess 直接跑，统一 node <cjs> 是唯一可靠形态）
//  - .cmd（残留包装）：解析内容提取真实 pnpm.cjs 路径，仍用 node 执行；失败返回 null。
// 返回 null 表示不可用（调用方自行回退/报错）。
function executablePnpm(pnpmExe, nodeExe) {
  if (!pnpmExe) return null
  const p = String(pnpmExe)
  if (/\.exe$/i.test(p)) return { file: p, args: [] }
  if (/\.cjs$/i.test(p) || /\.mjs$/i.test(p)) return fs.existsSync(p) ? { file: String(nodeExe || 'node'), args: [p] } : null
  if (/\.cmd$/i.test(p)) {
    // 兜底：从 .cmd 包装里解析真实 pnpm.cjs（内容形如 "@node" "@cjs" %*）
    try {
      const content = fs.readFileSync(p, 'utf8')
      const m = content.match(/"([^"]+\.cjs)"/)
      if (m && fs.existsSync(m[1])) return { file: String(nodeExe || 'node'), args: [m[1]] }
    } catch { /* 解析失败返回 null */ }
    return null
  }
  return fs.existsSync(p) ? { file: p, args: [] } : null
}

// pnpm 参数归一化：调用方可能传 executablePnpm 对象、.exe 路径，或工具链自举返回的
// 原始 .mjs/.cjs 路径。原始 JS 路径直接交给 execFile 会在 Electron Node 20 下同步抛
// spawn UNKNOWN（不能作为可执行文件 CreateProcess），必须统一转成 node <cjs> 组合。
function executablePnpmOrRaw(pnpmExe, nodeExe) {
  if (pnpmExe && typeof pnpmExe === 'object' && typeof pnpmExe.file === 'string') return pnpmExe
  return executablePnpm(pnpmExe || findPnpm(), nodeExe)
}

// ---------------------------------------------------------------------------
// 隐藏控制台启动器（根修弹窗问题）
// 背景：启动器是无控制台 GUI，直接 spawn 控制台程序（node/powershell/curl 等）时
// Windows 会给每个子进程新建可见控制台窗口 → "干活就疯狂弹窗"。官方在终端里跑
// dsh 不弹，是因为子进程继承了终端控制台。
// 修法：用 CreateProcess + CREATE_NEW_CONSOLE + STARTF_USESHOWWINDOW + SW_HIDE
// 启动目标进程，给它一个【隐藏】控制台；其子进程继承同一隐藏控制台，从此不再弹窗。
// 与官方终端启动等效，DSH 代码一行不改；每次启动器启动时自动生效，更新覆盖也不怕。
// ---------------------------------------------------------------------------
const CONSOLE_HOST_DLL = () => path.join(normalToolsDir(), 'zat-tools', 'dsh-console-host.dll')

const CONSOLE_HOST_CSHARP = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class ConsoleHostLauncher {',
  '  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }',
  '  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);',
  '  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);',
  '  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);',
  '  public static int Launch(string app, string args, string cwd, string pidFile) {',
  '    STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO));',
  '    si.dwFlags = 0x00000001 | 0x00000100; si.wShowWindow = 0;',
  '    si.hStdInput = GetStdHandle(-10); si.hStdOutput = GetStdHandle(-11); si.hStdError = GetStdHandle(-12);',
  '    PROCESS_INFORMATION pi;',
  '    string cmd = (args != null && args.Length > 0) ? "\\\"" + app + "\\\" " + args : "\\\"" + app + "\\\"";',
  '    // cwd 为空字符串会让 CreateProcess 报 ERROR_INVALID_NAME(-123)，必须传 null',
  '    string lpCwd = string.IsNullOrEmpty(cwd) ? null : cwd;',
  '    bool ok = CreateProcess(app, cmd, IntPtr.Zero, IntPtr.Zero, true, 0x00000010, IntPtr.Zero, lpCwd, ref si, out pi);',
  '    if (!ok) return -Marshal.GetLastWin32Error();',
  '    // pid 写文件（不写 stdout）：目标进程继承的 stdout 管道完全留给目标进程输出，避免竞争',
  '    try { if (!string.IsNullOrEmpty(pidFile)) System.IO.File.WriteAllText(pidFile, pi.dwProcessId.ToString()); } catch { }',
  '    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);',
  '    return pi.dwProcessId;',
  '  }',
  '}',
].join('\n')

// 确保隐藏控制台启动器 DLL 已编译（缓存到 %TEMP%\zat-tools\dsh-console-host.dll）。
// 缓存带源码哈希校验：C# 代码更新后自动重新编译，避免旧 DLL 不匹配导致静默退回普通 spawn。
async function ensureConsoleHostDll(execute = run) {
  const dll = CONSOLE_HOST_DLL()
  const csFile = path.join(path.dirname(dll), 'dsh-console-host.cs')
  try {
    fs.mkdirSync(path.dirname(dll), { recursive: true })
    fs.writeFileSync(csFile, CONSOLE_HOST_CSHARP, 'utf8')
    // 源码哈希 → 校验文件；不一致则删 DLL 重新编译
    const crypto = require('node:crypto')
    const hash = crypto.createHash('sha1').update(CONSOLE_HOST_CSHARP).digest('hex').slice(0, 12)
    const hashFile = dll + '.hash'
    const cachedHash = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf8').trim() : ''
    if (fs.existsSync(dll) && cachedHash === hash) return dll
    fs.rmSync(dll, { force: true })
    const r = await execute('powershell.exe', ['-NoProfile', '-Command', `Add-Type -Path '${csFile}' -OutputAssembly '${dll}' -ErrorAction Stop`], undefined, 120000)
    if (r.ok && fs.existsSync(dll)) {
      fs.writeFileSync(hashFile, hash, 'utf8')
      return dll
    }
  } catch { /* 编译失败走普通 spawn 兜底 */ }
  return ''
}

/**
 * 以隐藏控制台启动控制台程序（根修弹窗）。返回兼容 ChildProcess 的句柄：
 * { pid, stdout, stderr, on(event, cb), once(event, cb), kill() }。
 * 目标进程经 CreateProcess(CREATE_NEW_CONSOLE + SW_HIDE) 启动，拥有隐藏控制台，
 * 其子进程继承同一隐藏控制台 → 不再弹窗；stdout/stderr 通过继承的管道句柄直达调用方。
 * 失败时返回普通 spawn 结果（保底可用）。
 */
// ★ 1.5.2（黑窗根治）：C# CreateProcess 的 lpApplicationName 传非空且不带路径的
//   "裸程序名"（如 findNodeExe 兜底返回的 'node'）时【不做 PATH 搜索】→ Launch 必失败
//   （8 秒超时）→ 退回普通启动 → DSH 及子进程全无隐藏控制台 → 呼呼弹黑窗。
//   这里统一先把裸程序名解析成绝对路径；Node spawn 自己会搜 PATH，但 C# 不搜。
async function resolveProgramAbsolutePath(program) {
  if (!program || typeof program !== 'string') return program
  if (path.isAbsolute(program) || program.includes('/') || program.includes('\\')) return program
  try {
    const where = require('node:child_process').execFileSync('where.exe', [program], {
      stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 8000, windowsHide: true,
    })
    const first = String(where).split(/\r?\n/).map(s => s.trim()).find(Boolean)
    if (first && fs.existsSync(first)) return first
  } catch { /* 解析失败则原样返回，由调用方兜底 */ }
  return program
}
async function spawnWithHiddenConsole(program, args, options = {}) {
  const { cwd, env, stdio = ['ignore', 'pipe', 'pipe'], detached = true } = options
  program = await resolveProgramAbsolutePath(program)
  const dll = await ensureConsoleHostDll()
  if (dll) {
    try {
      // pid 经文件回传（不写 stdout）：目标进程继承的 stdout 管道完全留给目标进程，
      // 避免 PowerShell 的 pid 行与目标进程输出竞争同一管道导致解析失败。
      const pidFile = path.join(normalToolsDir(), `zat-console-pid-${process.pid}-${Date.now()}.txt`)
      // env 注入：C# CreateProcess 的 lpEnvironment 是 IntPtr.Zero（继承 PS 环境），
      // 调用方传入的 env（DSH_HOME/PNPM_MJS/工具链 PATH）必须显式设置进 PS 进程环境，
      // 否则目标进程拿不到 → D:\2 这类 npm 形态终端会落回默认 ~/.dsh home（串 home 的根因）。
      // 只注入与当前进程不同的变量（通常是 DSH_HOME/PNPM_MJS/PATH 少数几个）：
      //  - 减少 PS 脚本长度，启动更快；
      //  - 避开 process.env 里含单引号/换行等特殊字符的值把 PS 脚本写坏
      //    （曾导致 Launch 从未执行 → 8 秒超时 → 退回普通 spawn → 弹黑色终端 + 启动慢）。
      const envLines = []
      if (env && typeof env === 'object') {
        for (const [k, v] of Object.entries(env)) {
          if (v === undefined || v === null) continue
          if (process.env[k] === String(v)) continue // 与当前进程相同 → 目标进程继承 PS 环境即可
          const safe = String(v).replace(/'/g, "''").replace(/[\r\n]+/g, ' ')
          try { envLines.push(`$env:${k}='${safe}'`) } catch { /* 跳过非法键 */ }
        }
      }
      const psScript = [
        ...envLines,
        `Add-Type -Path '${dll}'`,
        `$r = [ConsoleHostLauncher]::Launch('${String(program).replace(/'/g, "''")}', '${String((args || []).join(' ')).replace(/'/g, "''")}', '${String(cwd || '').replace(/'/g, "''")}', '${pidFile.replace(/'/g, "''")}')`,
        `if ($r -le 0) { Write-Error "Launch failed: $r"; exit 1 }`,
      ].join('; ')
      // PowerShell 自身也隐藏窗口；目标进程的 stdout/stderr 继承 PowerShell 的管道句柄直达这里
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const { PassThrough } = require('node:stream')
      const outStream = new PassThrough()
      const errStream = new PassThrough()
      ps.stdout.on('data', chunk => outStream.write(chunk))
      ps.stderr.on('data', chunk => errStream.write(chunk))
      const pid = await new Promise(resolve => {
        const readPid = () => {
          try {
            const raw = fs.readFileSync(pidFile, 'utf8').trim()
            if (/^\d+$/.test(raw)) return Number(raw)
          } catch { /* 文件未生成 */ }
          return 0
        }
        const timer = setInterval(() => {
          const p = readPid()
          if (p > 0) { clearInterval(timer); resolve(p) }
        }, 100)
        ps.on('error', () => { clearInterval(timer); resolve(0) })
        setTimeout(() => { clearInterval(timer); resolve(readPid()) }, 8000)
      })
      try { fs.rmSync(pidFile, { force: true }) } catch { /* 忽略 */ }
      if (pid > 0) {
        // 目标进程已独立运行（CreateProcess 不挂在 PowerShell 下），stdout/stderr 管道由目标持有，
        // 管道 end = 目标退出（PowerShell 已退出、只剩目标持有写端）。
        // ★ 1.0.13：避免竞态——PowerShell 启动目标后立即退出（PS stdout 'end'），
        //   绝不能因此把存活进程 finish(0)（exitCode=0 → startTerminal 误判进程已退出 → 启动失败）。
        //   目标进程管道持有者退出才算退出；PS 自身的 'exit'/'close' 不触发 finish。
        const handle = new EventEmitter()
        handle.pid = pid
        // exitCode: null = 进程存活（startTerminal 就绪判定与 supervisor degraded 判定都依赖它）
        handle.exitCode = null
        handle.stdout = outStream
        handle.stderr = errStream
        let exited = false
        const finish = (code) => {
          if (exited) return
          exited = true
          handle.exitCode = code == null ? 0 : code
          outStream.end()
          errStream.end()
          handle.emit('exit', handle.exitCode, null)
          handle.emit('close', handle.exitCode, null)
        }
        // 只认目标 stdout 管道 end（目标持有写端）：PS 退出不代表目标退出
        ps.stdout.on('end', () => {
          // PS 可能先退出（Launch 成功即退）——但管道 write 端已被目标进程继承，
          // 若目标仍存活,PS stdout 'end' 不会在此触发(端在目标手上);真正 end = 目标退出。
          // 保守:延迟 200ms 再判定,给管道交接留时间,期间 finish 不会被错误触发。
          setTimeout(() => { if (!exited) finish(0) }, 200)
        })
        ps.on('exit', () => { /* 不 finish：PS 退出不代表目标退出（1.0.13 竞态修复） */ })
        ps.on('error', () => { /* 不 finish，同上 */ })
        handle.kill = (sig) => {
          try {
            require('node:child_process').execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
            return true
          } catch { return false }
        }
        return { ok: true, hiddenConsole: true, child: handle, pid }
      }
    } catch { /* 隐藏控制台启动失败，退回普通 spawn */ }
  }
  // 兜底：普通 spawn（至少能跑；弹窗问题只在极端环境出现）
  const child = spawn(program, args, { cwd, env, windowsHide: true, stdio, detached })
  return { ok: true, hiddenConsole: false, child, pid: child.pid }
}

// 安装 profile 的官方 bundle 依赖（dsh-base / dsh-web-app）到 profile/node_modules，
// 保证 dsh-app-boot 的 resolveBundleDir 能解析全部 bundle（否则启动报 cannot resolve profile bundle）。
// 优先 pnpm（store 命中快），回退自举 npm CLI；以包实装为准（pnpm 可能因构建脚本被忽略返回非 0）。
// force=true：忽略"已存在跳过"，强制重装到 @next（DSH 主包更新后必须同步，
// 否则 rc 错配导致启动崩溃：Unknown file extension .css / ERR_UNKNOWN_FILE_EXTENSION）。
async function installProfileBundles({ nodeExe, profileDir, toolsDir, onProgress, execute = runWithProgress, force = false, version = '' }) {
  const check = () =>
    fs.existsSync(path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-base')) &&
    fs.existsSync(path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-web-app'))
  if (check() && !force) return { ok: true, skipped: true }
  fs.mkdirSync(profileDir, { recursive: true })
  const registry = await pickRegistry(nodeExe)
  // 白板原则：优先用调用方注入的工具链 env（内置 node/pnpm/npm/git PATH）；未注入时才拼 node 目录
  const toolchainEnv = execute && execute.env || null
  const envForCli = toolchainEnv || { ...process.env, PATH: `${path.dirname(nodeExe)};${process.env.PATH || ''}` }
  // bundle 版本必须与 DSH 匹配：registry 上 @latest 指向旧版 0.0.1-rc.1，@next 才是当前 rc（与 @deepseek-ai/dsh 同版本线）。
  // 但 pnpm 的 @next 标签在"已装过"目录解析不可靠（实测 add @next 仍装出旧 rc.7），
  // 必须用 dist-tags 动态解析出的具体版本号（rc.7→rc.8 更新实测 3.9s 成功）；
  // 解析失败才回退 @next 标签。
  // ★ 1.4.0：调用方传入主包 version 时，bundle 与主包【强制同号】——bundle 与主包版本
  //   错位是 "Unknown file extension .css" 启动崩的根因；钉定版本安装失败（registry 无
  //   该版本）才回退旧的独立解析（max(latest,next)）。
  const fallbackSpecs = async () => {
    const baseV = await resolvePackageVersion(nodeExe, '@deepseek-ai/dsh-base')
    const webV = await resolvePackageVersion(nodeExe, '@deepseek-ai/dsh-web-app')
    return [
      baseV ? `@deepseek-ai/dsh-base@${baseV}` : '@deepseek-ai/dsh-base@next',
      webV ? `@deepseek-ai/dsh-web-app@${webV}` : '@deepseek-ai/dsh-web-app@next',
    ]
  }
  const attempts = []
  if (version) attempts.push([`@deepseek-ai/dsh-base@${version}`, `@deepseek-ai/dsh-web-app@${version}`])
  attempts.push(await fallbackSpecs())
  let pnpmExe = executablePnpm(findPnpm(), nodeExe)
  if (!pnpmExe) {
    // pnpm 不可用时自举一次（与主包安装一致），绝不回退 npm（依赖树性能崩塌）
    try {
      const boot = await ensurePnpm({ nodeExe, toolsDir: toolsDir || path.join(normalToolsDir(), 'zat-tools'), onProgress })
      pnpmExe = executablePnpm(boot, nodeExe)
    } catch { pnpmExe = '' }
  }
  if (!pnpmExe) {
    return { ok: false, message: 'profile 官方 bundle 安装失败（pnpm 不可用，自举失败）' }
  }
  if (onProgress) onProgress('依赖', '用 pnpm 安装 profile 官方 bundle（dsh-base / dsh-web-app）…')
  try { fs.writeFileSync(path.join(profileDir, '.npmrc'), 'dangerously-allow-all-builds=true\n', 'utf8') } catch { /* 忽略 */ }
  // package-import-method=copy：与主包安装一致，终端完全独立拷贝，删除/更新互不影响
  let lastErr = ''
  for (const spec of attempts) {
    // ★ 1.4.0：退出码必须检查——旧实现只要目录存在就判成功，pnpm add 失败（网络/磁盘）
    //   或装出旧版时误报 ok → 主包/bundle 版本错位启动崩
    const r = await execute('依赖', pnpmExe, ['add', ...spec, '--dir', profileDir, '--registry', registry, '--config.dangerously-allow-all-builds=true', '--config.package-import-method=copy'], undefined, onProgress, 30 * 60 * 1000, envForCli)
    if (r.ok && check()) return { ok: true, version: version || '' }
    lastErr = (r.err || r.out || lastErr || '').trim().split(/\r?\n/).slice(-2).join(' | ')
    if (check() && !r.ok) {
      // 目录在但退出码非 0：半安装，重试下一组 spec
      if (onProgress) onProgress('依赖', `bundle 安装退出码非 0（${lastErr.slice(-120)}），尝试下一版本策略…`)
    }
  }
  // npm 回退已移除（1.0.9）：npm 对 @deepseek-ai/* 依赖树解析性能崩塌（实测死转），
  // pnpm 均失败时明确报错，绝不掉进 npm 白等。
  return { ok: false, message: `profile 官方 bundle 安装失败（dsh-base / dsh-web-app 未实装）：${lastErr || '无输出'}` }
}

// 修补 DSH 的 subprocess-local 实现：child_process.spawn 加 windowsHide: true，
// 否则引擎/DSH 每次执行 shell/curl/git 命令都会弹出控制台窗口（用户反复反馈的弹窗问题）。
// 兼容多种布局，任何 DSH 版本都能打中：
//  - pnpm 布局：node_modules/.pnpm/@deepseek-ai+dsh-subprocess_*/.../lib/index.js
//  - 平铺布局：node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js
//  - workspace 布局（官方新版源码树）：packages/*/*/subprocess-local/lib/index.js 等
//  - 任意深度的 subprocess-local/lib/index.js（递归，覆盖未来布局变化）
function patchDshSubprocessNoWindow(rootDir) {
  const targets = []
  const pnpmDir = path.join(rootDir, 'node_modules', '.pnpm')
  try {
    if (fs.existsSync(pnpmDir)) {
      for (const ent of fs.readdirSync(pnpmDir, { withFileTypes: true })) {
        if (!ent.isDirectory() || !ent.name.includes('dsh-subprocess')) continue
        targets.push(path.join(pnpmDir, ent.name, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js'))
      }
    }
  } catch { /* 目录不可读则跳过 */ }
  targets.push(path.join(rootDir, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js'))
  // workspace 布局：递归找所有 subprocess-local/lib/index.js（深度限制，避免扫 node_modules）
  const walkForSubprocess = (dir, depth) => {
    if (depth > 4) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist') continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'subprocess-local') {
          const lib = path.join(full, 'lib', 'index.js')
          if (fs.existsSync(lib)) targets.push(lib)
        }
        walkForSubprocess(full, depth + 1)
      }
    }
  }
  walkForSubprocess(rootDir, 0)
  let patched = 0
  const seen = new Set()
  for (const t of targets) {
    try {
      if (!fs.existsSync(t) || seen.has(t)) continue
      seen.add(t)
      let c = fs.readFileSync(t, 'utf8')
      if (c.includes('windowsHide')) continue // 已打过补丁
      const old = '\t\tdetached: platform !== "win32"\n\t});'
      const rep = '\t\tdetached: platform !== "win32",\n\t\twindowsHide: true\n\t});'
      if (c.includes(old)) {
        fs.writeFileSync(t, c.split(old).join(rep), 'utf8')
        patched++
      }
    } catch { /* 单个文件失败不阻断 */ }
  }
  return patched
}

// 动态解析 npm 上 @deepseek-ai/dsh 的最新版本号（dist-tags 中 latest 与 next 比较取新）。
// 用具体版本号安装/更新——pnpm 的 @next 标签解析不可靠（实测 add @next 装出旧 rc.7），
// 而 dist-tags 始终准确（实测 latest=0.1.0-rc.7, next=0.1.0-rc.8 → 返回 rc.8）。
// 返回版本号字符串（如 '0.1.0-rc.8'）；全部源不可达返回 ''（调用方回退标签）。
async function resolveLatestDshVersion(nodeExe, timeoutMs = 3000) {
  const script = 'fetch(process.argv[1]).then(r=>r.json()).then(j=>{console.log((j.latest||"")+" "+(j.next||"")+" "+(j.alpha||""))}).catch(()=>process.exit(1))'
  // ★ 1.4.0：verCmp 换用 harness-update.compareVersions——旧实现 parseInt('rc')=0，
  //   '0.1.2-rc.1' 被判大于同号正式版 '0.1.2'（语义颠倒，可能装到降级预发布版）
  const verCmp = compareVersions
  for (const base of NPM_REGISTRIES) {
    const url = `${String(base).replace(/\/$/, '')}/-/package/${DSH_NPM_PACKAGE}/dist-tags`
    const r = await run(nodeExe, ['-e', script, url], null, timeoutMs)
    if (!r.ok) continue
    const parts = r.out.trim().split(/\s+/).filter(Boolean)
    // ★ 1.4.2：alpha 标签纳入（官方把 alpha 系列发 npm 并打 alpha 标签——不读则永远检测不到）
    const latest = parts[0] || ''
    const next = parts[1] || ''
    const alphaV = parts[2] || ''
    const pick = [latest, next, alphaV].filter(Boolean).reduce((m, v) => (verCmp(v, m) > 0 ? v : m), '')
    if (pick) return pick
  }
  return ''
}

// 解析任意 @deepseek-ai 包的 dist-tags 最新版本（installProfileBundles 用，
// pnpm 的 @next 标签在"已装过"目录解析不可靠，必须用具体版本号）
async function resolvePackageVersion(nodeExe, pkgName, timeoutMs = 3000) {
  const script = 'fetch(process.argv[1]).then(r=>r.json()).then(j=>{console.log((j.latest||"")+" "+(j.next||"")+" "+(j.alpha||""))}).catch(()=>process.exit(1))'
  // ★ 1.4.0：同 resolveLatestDshVersion——统一 compareVersions 语义（预发布 < 正式版）
  const verCmp = compareVersions
  for (const base of NPM_REGISTRIES) {
    const url = `${String(base).replace(/\/$/, '')}/-/package/${pkgName}/dist-tags`
    const r = await run(nodeExe, ['-e', script, url], null, timeoutMs)
    if (!r.ok) continue
    const parts = r.out.trim().split(/\s+/).filter(Boolean)
    const latest = parts[0] || ''
    const next = parts[1] || ''
    const alphaV = parts[2] || ''
    const pick = [latest, next, alphaV].filter(Boolean).reduce((m, v) => (verCmp(v, m) > 0 ? v : m), '')
    if (pick) return pick
  }
  return ''
}

// ★ 主路径：一键安装 = 下载官方预构建包（npm registry 官方优先/国内回退，进度实时）。
// 优先用机器上已装的 pnpm（store 缓存命中快）；没有 pnpm 才自举 npm CLI。
// 装完 lib/bin.js 直接可运行，零编译。targetDir 为独立新环境根目录。
async function installOfficialPackage({ nodeExe, toolsDir, targetDir, onProgress, execute = runWithProgress, pnpmExe = '' }) {
  const dshDir = path.join(targetDir, 'node_modules', '@deepseek-ai', 'dsh')
  if (fs.existsSync(path.join(dshDir, 'lib', 'bin.js'))) {
    if (onProgress) onProgress('下载', `官方 DSH 已存在（${dshDir}），跳过下载`)
    return { ok: true, dshDir, skipped: true }
  }
  fs.mkdirSync(targetDir, { recursive: true })
  const registry = await pickRegistry(nodeExe)
  // 白板原则：优先用调用方注入的工具链 env（内置 node/pnpm/npm/git PATH）；未注入时才拼 node 目录
  const toolchainEnv = execute && execute.env || null
  const envForCli = toolchainEnv || { ...process.env, PATH: `${path.dirname(nodeExe)};${process.env.PATH || ''}` }
  // 动态解析最新版本号（latest/next 取新），解析失败回退标签
  let spec = `${DSH_NPM_PACKAGE}@${DSH_NPM_TAG}`
  try {
    const v = await resolveLatestDshVersion(nodeExe)
    if (v) spec = `${DSH_NPM_PACKAGE}@${v}`
  } catch { /* 回退标签 */ }
  // 1) 优先 pnpm（已装则 store 缓存命中，秒级；.cjs 形态转 pnpm.cmd 包装再执行）
  // 显式传入的 pnpmExe（调用方工具链自举的）优先；没有才回退磁盘探测 + 自举。
  // ★ pnpm 是唯一可靠主路径（npm 对 dsh 依赖树解析性能崩塌，实测 7.5 分钟死转），
  //   自举失败也绝不直接掉进 npm——先尝试 ensurePnpm 自举一次（1.0.9 修复）。
  let pnpmExeResolved = executablePnpmOrRaw(pnpmExe, nodeExe)
  if (!pnpmExeResolved) {
    try {
      if (onProgress) onProgress('下载', '未找到 pnpm，正在自举（微秒级，仅首次）…')
      const boot = await ensurePnpm({ nodeExe, toolsDir: toolsDir || path.join(normalToolsDir(), 'zat-tools'), onProgress })
      pnpmExeResolved = executablePnpm(boot, nodeExe)
    } catch { pnpmExeResolved = '' }
  }
  if (pnpmExeResolved) {
    if (onProgress) onProgress('下载', `用 pnpm 从 ${registry} 安装 ${spec}…`)
    // pnpm 11 需要通过 .npmrc 允许原生构建脚本（node-pty/esbuild/koffi），否则这些包被忽略。
    try { fs.writeFileSync(path.join(targetDir, '.npmrc'), 'dangerously-allow-all-builds=true\n', 'utf8') } catch { /* 忽略 */ }
    // ★ package-import-method=copy：pnpm 默认把 store 文件硬链接进 node_modules，
    //   所有终端共享同一份原生模块（如 sharp）——3080 加载着它时，其它终端里同版本
    //   的文件永远删不掉（0.6.29 删除残留根因，nlink=8 实测证实）。
    //   copy 模式让每个终端完全独立拷贝：删除/更新互不影响，真正"终端 100% 独立"。
    const r = await execute('下载', pnpmExeResolved, ['add', spec, '--dir', targetDir, '--registry', registry, '--config.dangerously-allow-all-builds=true', '--config.package-import-method=copy'], undefined, onProgress, 30 * 60 * 1000, envForCli)
    // ★ EPERM/EBUSY 重试（杀软扫描/文件占用瞬时锁，重试通常通过——朋友实机全新安装失败根因）
    let rFinal = r
    if (!r.ok && /EPERM|EBUSY|EACCES/i.test(String(r.err || '') + String(r.out || ''))) {
      if (onProgress) onProgress('下载', '文件被占用（EPERM/EBUSY，常见于杀软扫描），等待后重试一次…')
      await new Promise(res => setTimeout(res, 1500))
      rFinal = await execute('下载', pnpmExeResolved, ['add', spec, '--dir', targetDir, '--registry', registry, '--config.dangerously-allow-all-builds=true', '--config.package-import-method=copy'], undefined, onProgress, 30 * 60 * 1000, envForCli)
    }
    // 以 bin.js 就位为准：pnpm 可能因原生构建脚本被忽略而返回非 0（ERR_PNPM_IGNORED_BUILDS），
    // 但预构建包本体已安装成功。缺失的原生模块由 DSH 首次启动时按需处理。
    if (fs.existsSync(path.join(dshDir, 'lib', 'bin.js'))) {
      if (onProgress) onProgress('下载', '官方 DSH 下载完成（预构建，直接可用）')
      return { ok: true, dshDir }
    }
    const detail = (rFinal.err || rFinal.out || '').trim().split(/\r?\n/).slice(-3).join(' | ')
    return { ok: false, message: `pnpm 安装失败：${detail || '无输出'}` }
  }
  // pnpm 自举失败：明确报错，绝不回退 npm（npm 对 dsh 依赖树解析性能崩塌，实测 7.5 分钟死转，
  // 回退只会让用户再白等 3~6 分钟 —— 1.0.9 移除 npm 装包路径）。
  return { ok: false, message: '未找到 pnpm 且自举失败（网络或环境问题），请检查网络后重试' }
}

// 更新 npm 包形态的 DSH：pnpm add @deepseek-ai/dsh@latest --dir <终端根>（复用主下载路径，store 命中快）。
// targetDir = 终端根（含 node_modules/@deepseek-ai/dsh）。零编译，更新后等用户启动生效。
async function updateNpmPackage({ nodeExe, targetDir, toolsDir, onProgress, execute = runWithProgress, pnpmExe = '' }) {
  const dshDir = path.join(targetDir, 'node_modules', '@deepseek-ai', 'dsh')
  if (!fs.existsSync(path.join(dshDir, 'package.json'))) return { ok: false, message: '该终端不是 npm 包形态的 DSH，无法用此方式更新' }
  const registry = await pickRegistry(nodeExe)
  // pnpm 三层保障（1.0.10）：调用方自举的 pnpmExe → 磁盘探测 → 自举；绝不裸探测失败即死
  // （同 installOfficialPackage，杜绝"工具链明明自举好却因探测差异找不到"）
  let pnpm = executablePnpmOrRaw(pnpmExe, nodeExe)
  if (!pnpm) {
    try {
      if (onProgress) onProgress('更新', '未找到 pnpm，正在自举…')
      const boot = await ensurePnpm({ nodeExe, toolsDir: toolsDir || path.join(normalToolsDir(), 'zat-tools'), onProgress })
      pnpm = executablePnpm(boot, nodeExe)
    } catch { pnpm = '' }
  }
  if (!pnpm) return { ok: false, message: '未找到 pnpm 且自举失败（网络或环境问题），请检查网络后重试' }
  // 白板原则：优先用调用方注入的工具链 env（内置 node/pnpm/npm/git PATH）；未注入时才拼 node 目录
  const toolchainEnv = execute && execute.env || null
  const envForCli = toolchainEnv || { ...process.env, PATH: `${path.dirname(nodeExe)};${process.env.PATH || ''}` }
  // 动态解析最新版本号（latest/next 取新），解析失败回退标签
  let spec = `${DSH_NPM_PACKAGE}@${DSH_NPM_TAG}`
  try {
    const v = await resolveLatestDshVersion(nodeExe)
    if (v) spec = `${DSH_NPM_PACKAGE}@${v}`
  } catch { /* 回退标签 */ }
  if (onProgress) onProgress('更新', `用 pnpm 从 ${registry} 更新 ${spec}…`)
  // pnpm 11 默认忽略依赖构建脚本并返回非 0（ERR_PNPM_IGNORED_BUILDS）——
  // 必须显式允许，否则原生模块（如 subprocess-local）缺失且更新被误判失败。
  // 宽容兜底：即使返回非 0，只要目标版本已就位就算成功（ignored-builds 场景包已装上）。
  const addArgs = ['add', spec, '--dir', targetDir, '--registry', registry, '--config.package-import-method=copy', '--config.dangerously-allow-all-builds=true']
  let r = await execute('更新', pnpm, addArgs, undefined, onProgress, 10 * 60 * 1000, envForCli)
  if (!r.ok && /EPERM|EBUSY|EACCES/i.test(String(r.err || '') + String(r.out || ''))) {
    if (onProgress) onProgress('更新', '文件被占用（EPERM/EBUSY，常见于杀软扫描），等待后重试一次…')
    await new Promise(res => setTimeout(res, 1500))
    r = await execute('更新', pnpm, addArgs, undefined, onProgress, 10 * 60 * 1000, envForCli)
  }
  if (!r.ok) {
    const detail = (r.err || r.out || '').trim().split(/\r?\n/).slice(-3).join(' | ')
    // 已就位判定：目标版本出现在输出里（pnpm 会打印 "+ @deepseek-ai/dsh <version>"）
    const targetVersion = String(spec.split('@').pop() || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const versionSeated = targetVersion ? new RegExp(targetVersion).test(r.out) : false
    if (!versionSeated || !/ERR_PNPM_IGNORED_BUILDS/.test(String(r.err || '') + String(r.out || ''))) {
      return { ok: false, message: `npm 包更新失败：${detail}` }
    }
  }
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dshDir, 'package.json'), 'utf8')).version
    return { ok: true, version: v }
  } catch {
    return { ok: false, message: '更新完成但无法读取新版本号' }
  }
}

module.exports = {
  run, runWithProgress, probeSource, reachableSource,
  downloadDshTo, ensurePnpm, findPnpm, installDependencies, pickRegistry,
  ensureNpmCli, installOfficialPackage, updateNpmPackage, installProfileBundles,
  ensureNodeExe, findCachedNode, patchDshSubprocessNoWindow, ensureNpmCommand, ensureUpdateToolchain,
  findSystemGit, ensureGit, executablePnpm, ensureConsoleHostDll, spawnWithHiddenConsole, normalToolsDir,
  GIT_MIRRORS: gitPortableUrls, gitPortableUrls,
  executablePnpmOrRaw,
  resolveLatestDshVersion,
  npmCliHealthy, withRetry,
  probeRegistryPnpmLatest, downloadPnpmDist, builtinPnpmVersion,
  DSH_ORIGIN, DSH_NPM_PACKAGE, DSH_NPM_TAG, NPM_REGISTRIES, SOURCE_TIMEOUT_MS,
}




