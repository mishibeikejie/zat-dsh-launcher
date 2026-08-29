'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')

/* Harness 更新：支持两种安装形态
 *  - git 源码仓库：git fetch + ff-only merge + pnpm install + build
 *  - npm 包安装（一键安装的终端）：npm registry 版本对比 + pnpm add 更新
 * 每个终端独立，只操作当前终端的 dshDir / 终端根目录。
 *
 * 兼容策略（对未来版本变化尽量自适应，不卡死在某一种方式）：
 *  - install：pnpm frozen 官方 → frozen 镜像 → no-frozen 官方 → no-frozen 镜像 四连回退
 *  - build：必须用 npm 触发（新版 DSH 的 scripts/build.ts 用 npm_execpath 并执行
 *    `node <npm_execpath> run ...`；pnpm 的 npm_execpath 指向 @pnpm/exe/pnpm.exe 会被
 *    node 当 JS 加载报 ERR_UNKNOWN_FILE_EXTENSION，npm 的 npm_execpath 是 npm-cli.js 纯 JS）。
 *    npm-cli.js 自动探测（工具链 PATH → %TEMP%\zat-tools 自举 → 系统 node 目录），
 *    失败再分步 build:lib / build:web，最后兜底 pnpm run build（兼容旧版构建）。
 *  - 任何失败都回滚 git 到旧提交并返回完整错误尾部，绝不留下半更新状态。 */

const NPM_REGISTRIES = ['https://registry.npmmirror.com/', 'https://mirrors.cloud.tencent.com/npm/', 'https://mirrors.huaweicloud.com/repository/npm/', 'https://registry.npmjs.org/']

const { expandExec, wrapJsFile } = require('./toolchain-execute')

function run(file, args, cwd, timeout = 120000) {
  return new Promise(resolve => {
    const n = wrapJsFile(expandExec(file, args))
    execFile(n.file, n.args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error && error.code || 0, out: String(stdout || '').trim(), err: String(stderr || error && error.message || '').trim() })
    })
  })
}

// 探测 npm-cli.js（纯 JS 的 npm 入口）：工具链 PATH 目录 → %TEMP%\zat-tools 自举 → 系统 node 目录
// （纯路径探测，不带健康检查；健康校验见 findHealthyNpmCli —— runBuild 用它）
function findNpmCli(env) {
  const candidates = []
  const pathValue = String((env && env.PATH) || process.env.PATH || '')
  for (const d of pathValue.split(';')) {
    const dir = String(d || '').trim()
    if (!dir) continue
    candidates.push(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    candidates.push(path.join(dir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  }
  try {
    const tools = path.join(os.tmpdir(), 'zat-tools')
    const walk = (dir, depth) => {
      if (depth > 4) return ''
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return '' }
      for (const e of entries) {
        if (e.isDirectory()) {
          const r = walk(path.join(dir, e.name), depth + 1)
          if (r) return r
        } else if (e.name === 'npm-cli.js' && path.basename(path.dirname(path.join(dir, e.name))) === 'bin') {
          return path.join(dir, e.name)
        }
      }
      return ''
    }
    const found = walk(tools, 0)
    if (found) candidates.push(found)
  } catch { /* 自举探测失败不阻断 */ }
  candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c } catch { /* 继续 */ }
  }
  return ''
}

// ★ 健康 npm CLI 探测（2026-08 实机根因）：坏缓存（解压残留/杀软删文件）会让候选 npm 存在但
// 任何 `npm run` 都瞬间崩，导致 DSH 更新构建全链失败。逐个候选体检（node <cli> --version），
// 第一个能用的返回；全坏则尝试自举重下修复；仍无返回 ''（调用方走 pnpm 直构兜底）。
async function findHealthyNpmCli(env, nodeFile, execute = run, onStep = null) {
  const tryProbe = async (cli) => {
    if (!cli) return false
    const fi = require('./fresh-install')
    return fi.npmCliHealthy(nodeFile, cli)
  }
  const candidates = []
  const existing = findNpmCli(env)
  if (existing) candidates.push(existing)
  // 追加兜底候选：fresh fast-check 之前已知形态（结构兼容）
  candidates.push(path.join(os.tmpdir(), 'zat-tools', 'package', 'bin', 'npm-cli.js'))
  for (const c of candidates) {
    if (await tryProbe(c)) return c
  }
  // 全坏：重新自举（ensureNpmCli 内部也会体检）
  try {
    const fi = require('./fresh-install')
    const step = onStep || (() => {})
    step('npm CLI 自检异常，正在重新下载修复…')
    const cli = await fi.ensureNpmCli({
      nodeExe: nodeFile,
      toolsDir: path.join(os.tmpdir(), 'zat-tools'),
      onProgress: (d, m) => step(`[${d}] ${m}`),
    })
    if (cli && (await fi.npmCliHealthy(nodeFile, cli))) return cli
  } catch { /* 修复失败 → 返回 '' 走 pnpm 兜底 */ }
  return ''
}

// ★ pnpm 直构兜底（npm 完全不可用时）：DSH 的 build:lib 包装脚本用 npm 串联，
// 但真实工作脚本（build:lib:host / build:lib:client / build:web）本身不依赖 npm——
// 跳过包装直接用 pnpm 跑这些脚本即可完成构建（实测 rc.2 与 master 均适用）。
async function runPnpmDirect(dshDir, execute, pnpmExe, env, step) {
  const fail = (why) => ({ ok: false, err: why })
  // pnpm 三段保障（与 runBuild 兜底一致）：传入 → 探测 → 自举
  let pnpm = pnpmExe || null
  if (!pnpm) {
    const fi = require('./fresh-install')
    pnpm = fi.executablePnpm(fi.findPnpm(), 'node')
    if (!pnpm) {
      try { pnpm = fi.executablePnpm(await fi.ensurePnpm({ nodeExe: 'node', toolsDir: path.join(os.tmpdir(), 'zat-tools'), onProgress: (d, m) => step(`[${d}] ${m}`) }), 'node') } catch { pnpm = null }
    }
  }
  if (!pnpm) return fail('pnpm 不可用（探测与自举均失败），无法直构')
  const runScript = (name) => execute(pnpm, ['run', name], dshDir, 25 * 60 * 1000, env)
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dshDir, 'package.json'), 'utf8'))
    const scripts = pkg.scripts || {}
    const libParts = ['build:lib:host', 'build:lib:client']
    for (const s of libParts) {
      if (!scripts[s]) return fail(`缺少脚本 ${s}，无法 pnpm 直构`)
      step(`pnpm 直构：${s}`)
      const r = await runScript(s)
      if (!r.ok) return fail(`pnpm 直构 ${s} 失败：${String(r.err || r.out || '').slice(-800)}`)
    }
    if (scripts['build:web']) {
      step('pnpm 直构：build:web（上游可能引用不存在的 filter 包，可容忍跳过）')
      const r = await runScript('build:web')
      if (!r.ok && !/No projects matched the filters/i.test(String(r.err || r.out || ''))) {
        return fail(`pnpm 直构 build:web 失败：${String(r.err || r.out || '').slice(-800)}`)
      }
    }
    return { ok: true, used: 'pnpm 直构（npm 不可用变通）' }
  } catch (e) {
    return fail(`pnpm 直构失败：${e && e.message || e}`)
  }
}

// ★ 幽灵工作区目录清理（2026-08-29 实机根因之二）：git 回滚不会删除「合并时新建、回滚后残留」
// 的未跟踪包目录（实测上次更新从 master 合并出 27 个新包目录，回滚后仅剩 node_modules 空壳）。
// tsdown 的 workspace glob（packages/*/*、vendor/*、apps/cli）会匹配到这些幽灵目录 →
// 解析共享入口（lib/types/*）失败 → 整个构建秒败（Cannot find entry: ["lib/types/..."]）。
// 规则：workspace glob 覆盖的目录中，git 未跟踪、且内容仅剩构建残留（node_modules/lib/dist/
// .typecheck/tsbuildinfo）的一律删除；含其他文件（用户自己的内容）则保护不动。
async function cleanUntrackedWorkspaceDirs(dshDir, execute, step) {
  const RESIDUE = new Set(['node_modules', 'lib', 'dist', '.typecheck'])
  let removed = 0
  for (const group of ['packages', 'vendor', 'apps']) {
    const groupDir = path.join(dshDir, group)
    let children
    try { children = fs.readdirSync(groupDir, { withFileTypes: true }) } catch { continue }
    for (const c of children) {
      if (!c.isDirectory()) continue
      // vendor/* 与 packages/*/* 是两级；apps/* 是一级
      const first = path.join(groupDir, c.name)
      let candidates = [first]
      if (group !== 'apps') {
        let inner
        try { inner = fs.readdirSync(first, { withFileTypes: true }) } catch { continue }
        candidates = inner.filter(x => x.isDirectory()).map(x => path.join(first, x.name))
      }
      for (const cand of candidates) {
        const rel = path.relative(dshDir, cand).replace(/\\/g, '/')
        if (!rel || rel.startsWith('..')) continue
        // 只处理 git 未跟踪的目录（已跟踪 = 真实包，跳过）
        try {
          const tracked = await execute('git', ['ls-files', '--error-unmatch', rel], dshDir, 10000)
          if (tracked.ok) continue
        } catch { continue }
        let entries
        try { entries = fs.readdirSync(cand, { withFileTypes: true }) } catch { continue }
        const onlyResidue = entries.every(e => RESIDUE.has(e.name) || e.name.endsWith('.tsbuildinfo'))
        if (!onlyResidue) continue
        try {
          fs.rmSync(cand, { recursive: true, force: true })
          removed += 1
          step(`清理幽灵目录（上次更新残留）：${rel}`)
        } catch { /* 个别失败不阻断 */ }
      }
    }
  }
  return removed
}

// ★ 根包工作区入口占位修复（2026-08 实机）：@deepseek-ai/dsh-root 是仓库根元数据包，
// 没有任何源码，但 tsdown 的 workspace 共享入口 lib/types/{index,invariant,startup}.js
// 会在构建开始前解析【每一个】工作区包（含根包）的入口——根包无此产物时全构建秒败
// （Cannot find entry: ["lib/types/{index,invariant,startup}.js"]，实测 rc.2 与 master 均如此）。
// 该产物是旧版布局的历史遗留（8/21 构建时尚在，之后缺失），上游无命令可重新生成。
// 用惰性 ESM 占位补位：根包无运行时消费方（npm 发布也明确排除 dsh-root），export {} 完全惰性。
function ensureRootTypeStubs(dshDir, step) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dshDir, 'package.json'), 'utf8'))
    if (pkg.name !== '@deepseek-ai/dsh-root') return
    if (fs.existsSync(path.join(dshDir, 'src'))) return // 有源码的项目不需要占位
    const dir = path.join(dshDir, 'lib', 'types')
    let created = 0
    for (const name of ['index.js', 'invariant.js', 'startup.js']) {
      const f = path.join(dir, name)
      if (fs.existsSync(f)) continue
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(f, '// ZAT-DSH Launcher 占位：@deepseek-ai/dsh-root（仓库根元数据包）无源码，\n// tsdown 工作区入口需要此文件存在；惰性 ESM，无运行时消费方。\nexport {}\n', 'utf8')
      created += 1
    }
    if (created) step(`根包工作区入口缺失（lib/types/*），已生成 ${created} 个惰性占位模块`)
  } catch { /* 非根包或不可读：跳过 */ }
}

// 构建：多级自适应。返回 { ok }，失败带完整错误尾部。
// 兼容矩阵：
//  - 旧版 build script（npm run build:lib && npm run build:web）与新版（tsx scripts/build.ts）
//    都用 npm 触发（npm_execpath=npm-cli.js 纯 JS，pnpm 的 npm_execpath=pnpm.exe 会让 node 报错）
//  - build:lib 是核心（tsc/tsdown 编译全部包），必须成功
//  - build:web 的上游 script 长期引用 workspace 中不存在的 filter 包（新旧版都是历史遗留失效
//    脚本；真实 web UI 由 profile bundles @deepseek-ai/dsh-web-app 提供，不依赖此构建）——
//    失败且错误为「No projects matched the filters」时智能跳过，其余失败照常报错
//  - pnpm run build 作为最后兜底（兼容未来上游修正后 pnpm 也可用的场景）
async function runBuild(dshDir, execute, env, pnpmExe, onStep) {
  const nodeFile = process.env.npm_node_execpath || 'node'
  const step = (msg) => { try { if (onStep) onStep(msg) } catch { /* 日志失败不阻断 */ } }
  // ★ 幽灵工作区目录清理（见 cleanUntrackedWorkspaceDirs 注释）：上次更新残留的
  //   未跟踪包目录会直接让 tsdown 全建秒败——构建前先清。
  await cleanUntrackedWorkspaceDirs(dshDir, execute, step)
  // ★ 上游根包工作区入口缺失的自动补位（见 ensureRootTypeStubs 注释）
  ensureRootTypeStubs(dshDir, step)
  // ★ 体检后选 npm-cli（1.2.3 修复）：坏缓存（解压残留/杀软删文件）会让 npm 存在但任何
  //   `npm run` 都瞬间崩（2026-08 实机：更新构建全链失败）。坏则触发自举重下修复。
  const npmCli = await findHealthyNpmCli(env, nodeFile, execute, step)
  // build:web 的 script 是 `pnpm --filter ... run build`，npm 执行 script 时必须在 PATH 里
  // 能找到 pnpm——把 pnpm 所在目录显式前置进构建环境（工具链 PATH 缺 pnpm 时也能构建）。
  const extraPath = []
  if (pnpmExe) {
    // pnpm 可能是 { file, args } 对象（executablePnpm：node <pnpm.cjs>），取 file 的目录加 PATH
    const pnpmFile = pnpmExe && typeof pnpmExe === 'object' ? pnpmExe.file : pnpmExe
    const d = path.dirname(String(pnpmFile).replace(/\.cmd$/i, ''))
    if (d && d !== '.') extraPath.push(d)
  }
  const buildEnv = { ...(env || process.env), PATH: [...extraPath, String((env && env.PATH) || process.env.PATH || '')].filter(Boolean).join(';') }
  const runNpm = (script) => npmCli
    ? execute(nodeFile, [npmCli, 'run', script], dshDir, 25 * 60 * 1000, buildEnv)
    // 无可用 npm-cli（体检全败且重下修复失败）→ 跳过 npm 路径，走 pnpm 直构
    : Promise.resolve({ ok: false })

  // 0) npm 完全不可用：直接 pnpm 直构（跳过 npm 包装脚本）
  if (!npmCli) {
    step('npm CLI 自检失败且无法修复，改用 pnpm 直接构建…')
    const direct = await runPnpmDirect(dshDir, execute, pnpmExe, buildEnv, step)
    if (direct.ok) return direct
    return { ok: false, err: direct.err }
  }

  // 1) 整体 build
  step('构建中：npm run build（全量编译，约需 2~5 分钟，请耐心等待）')
  let r = await runNpm('build')
  if (r.ok) return { ok: true, used: 'npm run build' }

  // 2) 分步：build:lib（核心，必须成功）
  step('整体构建未通过，分步重试：build:lib')
  r = await runNpm('build:lib')
  if (!r.ok) {
    const libErr = String(r.err || r.out || '').slice(-1500)
    // 3) 兜底：pnpm run build
    step('build:lib 未通过，最后兜底：pnpm run build')
    // pnpm 三段保障（1.0.10）：传入 → 探测 → 自举；null 时 execute(null) 必败（误导"兜底失败"）
    let pnpmFallback = pnpmExe || null
    if (!pnpmFallback) {
      const fi = require('./fresh-install')
      pnpmFallback = fi.executablePnpm(fi.findPnpm(), 'node')
      if (!pnpmFallback) {
        try { pnpmFallback = fi.executablePnpm(await fi.ensurePnpm({ nodeExe: 'node', toolsDir: path.join(os.tmpdir(), 'zat-tools') }), 'node') } catch { /* 放弃兜底 */ }
      }
    }
    const p = await execute(pnpmFallback || null, ['run', 'build'], dshDir, 25 * 60 * 1000, buildEnv)
    if (p.ok) return { ok: true, used: 'pnpm run build（兜底）' }
    // 3.5) pnpm run build 也失败：跳过包装脚本，直接 pnpm 直构真实工作脚本（最终变通）
    step('pnpm run build 未通过，改用 pnpm 直构（跳过 npm 包装）…')
    const direct = await runPnpmDirect(dshDir, execute, pnpmFallback, buildEnv, step)
    if (direct.ok) return direct
    return { ok: false, err: `build:lib 失败：${libErr}；pnpm 兜底也失败：${String(p.err || p.out || '').slice(-800)}；${direct.err}` }
  }

  // 4) build:web：识别上游失效脚本（filter 包不存在），智能跳过
  step('build:lib 完成，继续 build:web')
  r = await runNpm('build:web')
  if (r.ok) return { ok: true, used: 'npm run build:lib + build:web' }
  const webErr = String(r.err || r.out || '')
  if (/No projects matched the filters/i.test(webErr)) {
    return { ok: true, used: 'npm run build:lib（build:web 上游脚本引用不存在的包，已智能跳过）', skippedWeb: true }
  }
  return { ok: false, err: `build:web 失败：${webErr.slice(-1500)}` }
}

function readVersion(dshDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dshDir, 'package.json'), 'utf8')).version || '未知' } catch { return '未知' }
}

// npm 包形态的包根：项目根/node_modules/@deepseek-ai/dsh（包自己的 package.json 才是 name=@deepseek-ai/dsh）
function npmPkgDir(dshDir) {
  const direct = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh')
  const binJs = path.join(direct, 'lib', 'bin.js')
  if (fs.existsSync(path.join(direct, 'package.json')) && fs.existsSync(binJs)) return direct
  return ''
}

// 识别安装形态：npm 包（name=@deepseek-ai/dsh 且无 .git）还是 git 源码仓库。
// dshDir 可能是包根（node_modules/@deepseek-ai/dsh，旧登记格式）或项目根（一键安装/扫描接入，
// 根 package.json 只有 dependencies，DSH 包在 node_modules 里）——两者都识别为 npm 形态。
function detectKind(dshDir) {
  if (!dshDir || typeof dshDir !== 'string') return { kind: 'invalid' }
  const pkgFile = path.join(dshDir, 'package.json')
  if (!fs.existsSync(pkgFile)) return { kind: 'invalid' }
  let pkg
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) } catch { return { kind: 'invalid' } }
  // 包根形态：package.json 自身就是 dsh 包
  if (pkg && pkg.name === '@deepseek-ai/dsh' && !fs.existsSync(path.join(dshDir, '.git'))) {
    return { kind: 'npm', pkg }
  }
  // 项目根形态：根 package.json 依赖 @deepseek-ai/dsh，node_modules 里有包 → npm 形态
  if (!fs.existsSync(path.join(dshDir, '.git'))) {
    const pkgDir = npmPkgDir(dshDir)
    if (pkgDir) {
      try {
        const npmPkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
        if (npmPkg && npmPkg.name === '@deepseek-ai/dsh') return { kind: 'npm', pkg: npmPkg }
      } catch { /* 包损坏则按 git 分支走，最终由 git 命令给出明确错误 */ }
    }
  }
  return { kind: 'git', pkg }
}

async function localInfo(dshDir, execute = run) {
  const det = detectKind(dshDir)
  if (det.kind === 'invalid') return { ok: false, message: 'DSH 目录无效' }
  if (det.kind === 'npm') {
    return {
      ok: true,
      kind: 'npm',
      version: det.pkg.version || '未知',
      commit: '',
      branch: 'npm 包',
      origin: '',
      dirty: false,
      dirtyCount: 0,
    }
  }
  const [head, branch, status, origin] = await Promise.all([
    execute('git', ['rev-parse', '--short', 'HEAD'], dshDir),
    execute('git', ['branch', '--show-current'], dshDir),
    execute('git', ['status', '--porcelain'], dshDir),
    execute('git', ['remote', 'get-url', 'origin'], dshDir),
  ])
  if (!head.ok || !branch.ok) return { ok: false, message: '该 DSH 目录不是可更新的 Git 仓库' }
  return {
    ok: true,
    kind: 'git',
    version: det.pkg.version || readVersion(dshDir),
    commit: head.out,
    branch: branch.out || 'master',
    origin: origin.ok ? origin.out : '',
    dirty: !!status.out,
    dirtyCount: status.out ? status.out.split(/\r?\n/).filter(Boolean).length : 0,
  }
}

function updateSources(origin) {
  const official = origin || 'https://github.com/deepseek-ai/deepseek-harness.git'
  if (!/^https:\/\/github\.com\//i.test(official)) return [official]
  return [
    official,
    `https://ghfast.top/${official}`,
    `https://gh-proxy.com/${official}`,
    `https://ghproxy.net/${official}`,
    `https://gh.llkk.cc/${official}`,
  ]
}

// 版本号比较：0.1.0-rc.7 -> [0,1,0,-1,7]；数字段比较，预发布段（rc/beta/alpha）比正式段旧
function versionParts(v) {
  return String(v || '').split(/[.\-]/).map(p => /^\d+$/.test(p) ? parseInt(p, 10) : (p === 'rc' || p === 'beta' || p === 'alpha' ? -1 : 0))
}
function compareVersions(a, b) {
  const pa = versionParts(a)
  const pb = versionParts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = i < pa.length ? pa[i] : 0
    const y = i < pb.length ? pb[i] : 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// npm 形态检查：探测 registry 最新版本（node -e fetch），官方优先、npmmirror 回退，每个源 3 秒超时快速切换。
// 2026-08 实测：@deepseek-ai/dsh 的 latest=0.1.0-rc.7、next=0.1.0-rc.8 —— 必须取 dist-tags 中较新者，
// 只看 latest 会"检查不到更新"（本地 rc.7 永远最新）。URL 必须带 -/package/ 前缀（否则 404）。
function npmLatestProbe(nodeExe) {
  return async function probeLatest(registry) {
    const base = String(registry).replace(/\/$/, '')
    const script = 'fetch(process.argv[1]).then(r=>r.json()).then(j=>{console.log((j.latest||"")+" "+(j.next||""))}).catch(()=>process.exit(1))'
    const r = await run(nodeExe, ['-e', script, `${base}/-/package/@deepseek-ai/dsh/dist-tags`], null, 3000)
    if (!r.ok) return ''
    const parts = r.out.trim().split(/\s+/).filter(Boolean)
    const latest = parts[0] || ''
    const next = parts[1] || ''
    if (latest && next) return compareVersions(next, latest) > 0 ? next : latest
    return latest || next || ''
  }
}

async function checkUpdate(dshDir, execute = run, probeLatest = null) {
  const local = await localInfo(dshDir, execute)
  if (!local.ok) return local
  if (local.kind === 'npm') {
    if (!probeLatest) return { ...local, ok: true, checkFailed: true, updateAvailable: false, canInstall: false, message: '更新检查不可用（缺少 registry 探测）' }
    let remoteVersion = ''
    for (const base of NPM_REGISTRIES) {
      remoteVersion = await probeLatest(base)
      if (remoteVersion) break
    }
    if (!remoteVersion) return { ...local, ok: true, checkFailed: true, updateAvailable: false, canInstall: false, message: '网络暂不可用，未完成更新检查' }
    const newer = compareVersions(remoteVersion, local.version) > 0
    return {
      ...local,
      ok: true,
      remoteRef: 'npm:latest',
      remoteCommit: remoteVersion,
      remoteVersion,
      behindCount: newer ? 1 : 0,
      updateAvailable: newer,
      canInstall: newer,
      message: newer ? `发现新版本 ${remoteVersion}（当前 ${local.version}）` : `当前已是最新版本（${local.version}）`,
    }
  }
  const remoteRef = `refs/remotes/zat-update/${local.branch}`
  let source = ''
  for (const candidate of updateSources(local.origin)) {
    const fetched = await execute('git', ['fetch', '--force', '--no-tags', candidate, `${local.branch}:${remoteRef}`], dshDir, 3000)
    if (fetched.ok) { source = candidate; break }
  }
  if (!source) return { ...local, ok: true, checkFailed: true, updateAvailable: false, canInstall: false, message: '网络暂不可用，未完成更新检查' }
  const [remoteHead, behind, remotePackage] = await Promise.all([
    execute('git', ['rev-parse', '--short', remoteRef], dshDir),
    execute('git', ['rev-list', '--count', `HEAD..${remoteRef}`], dshDir),
    execute('git', ['show', `${remoteRef}:package.json`], dshDir),
  ])
  if (!remoteHead.ok || !behind.ok) return { ...local, ok: false, message: `无法读取远端分支 ${remoteRef}` }
  let remoteVersion = '未知'
  try { remoteVersion = JSON.parse(remotePackage.out).version || '未知' } catch { /* keep unknown */ }
  const behindCount = Number(behind.out) || 0
  return {
    ...local,
    ok: true,
    remoteRef,
    source,
    remoteCommit: remoteHead.out,
    remoteVersion,
    behindCount,
    updateAvailable: behindCount > 0,
    // 有本地修改也能安装：安装时会自动 stash 暂存备份，更新完成后恢复（见 installUpdate）
    canInstall: behindCount > 0,
    message: behindCount > 0 ? `发现 ${behindCount} 个新提交（远端 ${remoteVersion}）` : `当前已是最新版本（${local.version}，HEAD ${local.commit}）`,
  }
}

// tsc 增量缓存处理策略（1.0.7 提速）：
// 旧逻辑更新前全删 *.tsbuildinfo 强制全量编译（源码树 50 包全量编译要 2~5 分钟），
// 因为 0.6.x 时代曾发生「旧缓存让 tsc -b 误判已最新 → 产物缺失 → 启动起不来」。
// 新策略：保留缓存走增量编译（tsc -b 只重编译变化的包，通常几十秒），
// 编译后用 verifyKeyArtifacts 验证关键产物 + 启动前 DSH 自身校验，产物缺失才清缓存全量重编。
// 这样大多数更新是增量秒级，极端情况才回退全量，对所有用户都快且稳。
function clearTsBuildInfo(dshDir) {
  try {
    const walk = (dir) => {
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue
          walk(full)
        } else if (e.name.endsWith('.tsbuildinfo')) {
          try { fs.rmSync(full, { force: true }) } catch { /* 忽略 */ }
        }
      }
    }
    walk(dshDir)
  } catch { /* 清理失败不阻断 */ }
}

// 在仓库内按「包名（package.json name）」找包目录（排除 node_modules/.git/dist）。
// 注意：包目录名 ≠ 包名（如 @deepseek-ai/dsh-host-apiproxy 的目录是 packages/host/apiproxy）。
function findPkgByName(dshDir, name) {
  const walk = (dir, depth) => {
    if (depth > 5) return ''
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return '' }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = path.join(dir, e.name)
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue
      try {
        const pj = path.join(full, 'package.json')
        if (fs.existsSync(pj)) {
          const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'))
          if (pkg.name === name) return full
        }
      } catch { /* 非包目录 */ }
      const r = walk(full, depth + 1)
      if (r) return r
    }
    return ''
  }
  return walk(dshDir, 0)
}

// 验证关键包编译产物存在（更新/恢复后 DSH 能启动的最低要求）
function verifyKeyArtifacts(dshDir) {
  const keys = ['@deepseek-ai/dsh-host-apiproxy', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-session-persistence-jsonl', '@deepseek-ai/dsh-client-runtime']
  for (const pkg of keys) {
    const dir = findPkgByName(dshDir, pkg)
    if (!dir) continue
    if (!fs.existsSync(path.join(dir, 'lib', 'index.js'))) return { ok: false, missing: pkg }
  }
  return { ok: true }
}

// 恢复旧版本到可运行状态：回滚代码 + 清增量缓存 + 重装依赖 + 重建旧代码产物
async function restoreOldVersion(dshDir, oldHead, execute, installAttempts, pnpm) {
  const steps = []
  // ★ 结果必须核验（1.2.3 修复）：旧实现 push('代码已回滚') 不看 reset 结果与 HEAD，
  //   真实回滚失败时仍谎称"已回滚"（实测 0.1.1-rc.2 树回滚失败但提示"代码已回滚"）。
  const reset = await execute('git', ['reset', '--hard', oldHead], dshDir, 120000)
  if (!reset.ok) return { ok: false, err: `代码回滚失败：${String(reset.err || reset.out || '').slice(-300)}` }
  const headAfter = await execute('git', ['rev-parse', 'HEAD'], dshDir)
  if (!headAfter.ok || String(headAfter.out).trim() !== String(oldHead).trim()) {
    return { ok: false, err: `代码回滚未生效（HEAD=${String(headAfter.out || '').trim()}，期望 ${String(oldHead).trim()}）` }
  }
  steps.push('代码已回滚')
  clearTsBuildInfo(dshDir)
  // ★ 回滚后清理幽灵工作区目录（更新合并时新建、回滚后残留的未跟踪包目录）
  await cleanUntrackedWorkspaceDirs(dshDir, execute, () => {})
  let restoreInstall = { ok: false }
  for (const args of installAttempts) {
    restoreInstall = await execute(pnpm, args, dshDir, 15 * 60 * 1000)
    if (restoreInstall.ok) break
  }
  if (!restoreInstall.ok) return { ok: false, err: `依赖恢复失败：${String(restoreInstall.err || '').slice(-500)}（${steps.join('、')}）` }
  steps.push('依赖已重装')
  const restore = await runBuild(dshDir, execute, execute && execute.env || process.env, pnpm)
  if (!restore.ok) return { ok: false, err: `旧版本重建失败：${String(restore.err || '').slice(-500)}（${steps.join('、')}）` }
  const artifact = verifyKeyArtifacts(dshDir)
  if (!artifact.ok) return { ok: false, err: `旧版本产物缺失：${artifact.missing}（${steps.join('、')}）` }
  return { ok: true, detail: `${steps.join(' + ')} + 产物重建` }
}

async function installUpdate(dshDir, snapshotDir, execute = run, options = {}) {
  const info = await checkUpdate(dshDir, execute, options.probeLatest)
  if (!info.ok) return info
  if (info.kind === 'npm') {
    if (!info.updateAvailable) return { ...info, message: '当前已是最新版本' }
    if (!options.npmUpdater) return { ...info, ok: false, message: 'npm 包形态更新器不可用' }
    fs.mkdirSync(snapshotDir, { recursive: true })
    fs.writeFileSync(path.join(snapshotDir, 'update.json'), `${JSON.stringify({ createdAt: Date.now(), dshDir, kind: 'npm', from: info.version, target: info.remoteVersion }, null, 2)}\n`, 'utf8')
    const updated = await options.npmUpdater()
    if (!updated.ok) return { ...info, ok: false, message: updated.message }
    const next = await localInfo(dshDir, execute)
    return { ...next, updateAvailable: false, message: `Harness 已更新到 ${updated.version || next.version}` }
  }
  if (!info.updateAvailable) return { ...info, message: '当前已是最新版本' }
  const oldHead = (await execute('git', ['rev-parse', 'HEAD'], dshDir)).out
  const step = options.onStep || (() => {})
  fs.mkdirSync(snapshotDir, { recursive: true })
  fs.writeFileSync(path.join(snapshotDir, 'update.json'), `${JSON.stringify({ createdAt: Date.now(), dshDir, oldHead, target: info.remoteRef, targetCommit: info.remoteCommit }, null, 2)}\n`, 'utf8')
  // 有本地修改：ff-only merge 需要干净工作区，先 stash 清空（含未跟踪文件）。
  // 按用户要求「本地修改不要了，就要官方版本」：更新成功后不恢复、不提示；
  // 失败回滚后也不恢复（修改留在 stash 里可自行 git stash pop 找回，界面不打扰）。
  let stashed = false
  if (info.dirty) {
    const stash = await execute('git', ['stash', 'push', '--include-untracked', '-m', `zat-update-${Date.now()}`], dshDir, 120000)
    if (!stash.ok) return { ...info, ok: false, message: `工作区清理失败（${stash.err || stash.out}），未开始更新` }
    stashed = true
  }
  const merge = await execute('git', ['merge', '--ff-only', info.remoteRef], dshDir, 120000)
  if (!merge.ok) return { ...info, ok: false, message: `更新快进失败：${merge.err || merge.out}` }
  step(`代码已更新（${info.behindCount} 个新提交），正在安装依赖…`)
  let pnpm = options.pnpmExe || null
  if (!pnpm) {
    // pnpm 三层保障（1.0.10）：显式传入 → 磁盘探测 → 自举，否则 git 形态更新的
    // 依赖安装 execute(null) 直接失败（"依赖安装失败"误导用户）。
    const fi = require('./fresh-install')
    pnpm = fi.executablePnpm(fi.findPnpm(), 'node')
    if (!pnpm) {
      step('未找到 pnpm，正在自举…')
      try {
        const boot = await fi.ensurePnpm({ nodeExe: 'node', toolsDir: path.join(os.tmpdir(), 'zat-tools'), onProgress: step })
        pnpm = fi.executablePnpm(boot, 'node')
      } catch (e) {
        step(`pnpm 自举失败：${e && e.message || e}`)
      }
    }
  }
  // 依赖安装四连：frozen 镜像 → frozen 官方 → 非 frozen 镜像 → 非 frozen 官方。
  // 国内网络直连 npmjs 常断（UND_ERR_DESTROYED），镜像优先命中率最高；
  // 非 frozen（--no-frozen-lockfile）专门解决 lockfile 与 package.json 失配
  // —— 重新解析生成匹配的 lockfile，而不是失败回滚。
  let install = { ok: false, err: '依赖安装失败' }
  const installAttempts = [
    ['install', '--frozen-lockfile', '--registry', 'https://registry.npmmirror.com/'],
    ['install', '--frozen-lockfile'],
    ['install', '--no-frozen-lockfile', '--registry', 'https://registry.npmmirror.com/'],
    ['install', '--no-frozen-lockfile'],
  ]
  for (const args of installAttempts) {
    install = await execute(pnpm, args, dshDir, 15 * 60 * 1000)
    if (install.ok) break
    step(`依赖安装未通过（${args[0]}），切换下一策略…`)
  }
  // build 必须用 npm 触发（新版 DSH build.ts 用 npm_execpath + `node <path> run ...`，
  // pnpm 的 npm_execpath 是 pnpm.exe 会被 node 当 JS 加载报错；npm 的是 npm-cli.js 纯 JS）。
  // runBuild 内部多级自适应：npm run build → 分步 build:lib/build:web → pnpm run build 兜底。
  // 1.0.7 提速：先保留 tsc 增量缓存编译（只重编译变化的包，通常几十秒）；
  // 产物验证不通过才清缓存强制全量重编（旧逻辑每次全量 2~5 分钟）。
  step('开始编译（增量模式：仅重编译变化的包）…')
  let build = install.ok ? await runBuild(dshDir, execute, execute && execute.env || process.env, pnpm, step) : { ok: false, err: '依赖安装失败' }
  let artifact = install.ok && build.ok ? verifyKeyArtifacts(dshDir) : { ok: true }
  if (install.ok && (!build.ok || artifact.ok === false)) {
    // 增量编译失败/产物缺失：清缓存强制全量编译（旧版可靠路径）
    step('增量编译未满足要求，切换全量编译（清 tsc 缓存，约 2~5 分钟）…')
    clearTsBuildInfo(dshDir)
    build = await runBuild(dshDir, execute, execute && execute.env || process.env, pnpm, step)
    artifact = build.ok ? verifyKeyArtifacts(dshDir) : { ok: true }
  }
  if (!install.ok || !build.ok || !artifact.ok) {
    // 失败：完整恢复旧版本可运行状态（代码回滚 + 清缓存 + 重装依赖 + 重建旧代码产物），
    // 绝不留「新代码 + 旧产物 / 旧代码 + 新产物」的混合状态（曾导致更新后 DSH 起不来）。
    let fail = (install.ok ? build.err : install.err || '依赖安装失败') || '未知错误'
    if (artifact.ok === false) fail = `编译产物缺失（${artifact.missing}）：${fail}`
    const restored = await restoreOldVersion(dshDir, oldHead, execute, installAttempts, pnpm)
    const restoredNote = restored.ok
      ? `已完整恢复旧版本（${restored.detail}），DSH 可正常启动`
      : `已回滚代码，但旧版本恢复失败：${restored.err}`
    return { ...info, ok: false, rolledBack: true, message: `更新验证失败：${String(fail).slice(-1500)}。${restoredNote}` }
  }
  return { ...(await localInfo(dshDir, execute)), updateAvailable: false, message: 'Harness 已更新到官方版本' }
}

module.exports = { run, readVersion, localInfo, updateSources, checkUpdate, installUpdate, npmLatestProbe, compareVersions, detectKind, NPM_REGISTRIES, runBuild, verifyKeyArtifacts, clearTsBuildInfo, findNpmCli, findHealthyNpmCli, runPnpmDirect, cleanUntrackedWorkspaceDirs }
