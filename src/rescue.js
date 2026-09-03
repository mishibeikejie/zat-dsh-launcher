'use strict'

const fs = require('node:fs')
const path = require('node:path')

/* 救援系统：每个终端一份 profile 关键文件快照，装坏插件/改坏配置后一键还原 + 重启 DSH 生效；
 * 并从终端启动日志诊断崩溃原因（缺失插件 / 插件加载失败 / profile 损坏），支持排除崩溃插件。
 * 纯逻辑、不依赖 Electron，便于单元测试。作用域 = 当前终端自己的 profile，绝不触碰外部 DSH。 */

// profile 关键文件：还原这几个就能让 DSH 重新起得来（不含 node_modules，避免慢/大）
const RESCUE_FILES = ['cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']

function rescueDirFor(userData, terminalId) {
  return path.join(userData, 'rescue', String(terminalId))
}

// 快照 profile 关键文件到救援目录（单份最新快照 + snapshot.json 元数据）
function createRescueSnapshot(profileDir, rescueDir, now = Date.now()) {
  if (!fs.existsSync(profileDir)) return { ok: false, message: 'profile 目录不存在，无法创建救援点' }
  const files = RESCUE_FILES.filter(f => fs.existsSync(path.join(profileDir, f)))
  if (!files.length) return { ok: false, message: 'profile 内没有可快照的关键文件' }
  fs.mkdirSync(rescueDir, { recursive: true })
  const copied = []
  for (const f of files) {
    fs.copyFileSync(path.join(profileDir, f), path.join(rescueDir, f))
    copied.push(f)
  }
  fs.writeFileSync(path.join(rescueDir, 'snapshot.json'), JSON.stringify({ at: now, profileDir, files: copied }, null, 2) + '\n', 'utf8')
  return { ok: true, dir: rescueDir, files: copied, at: now }
}

function crashFileFor(rescueDir) {
  return path.join(rescueDir, 'last-crash.json')
}

function recordCrash(rescueDir, record) {
  fs.mkdirSync(rescueDir, { recursive: true })
  const next = { ...record, at: Number(record && record.at) || Date.now(), recoveredAt: 0 }
  fs.writeFileSync(crashFileFor(rescueDir), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

function readCrashRecord(rescueDir) {
  try {
    const file = crashFileFor(rescueDir)
    if (!fs.existsSync(file)) return null
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    return record && typeof record === 'object' ? record : null
  } catch { return null }
}

function markCrashRecovered(rescueDir, recoveredAt = Date.now()) {
  const record = readCrashRecord(rescueDir)
  if (!record) return null
  record.recoveredAt = recoveredAt
  fs.writeFileSync(crashFileFor(rescueDir), JSON.stringify(record, null, 2) + '\n', 'utf8')
  return record
}

// 查询救援点状态（是否存在、时间、文件清单、上一次崩溃记录）
function rescueStatus(rescueDir) {
  const metaFile = path.join(rescueDir, 'snapshot.json')
  let snapshot = { exists: false, at: 0, files: [] }
  if (fs.existsSync(metaFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
      snapshot = { exists: true, at: Number(meta.at) || 0, files: Array.isArray(meta.files) ? meta.files : [] }
    } catch { /* 返回无快照，同时仍允许显示事故记录 */ }
  }
  return { ...snapshot, lastCrash: readCrashRecord(rescueDir) }
}

// 从救援目录还原 profile 关键文件（覆盖回 profile 目录）
function restoreRescueSnapshot(profileDir, rescueDir) {
  const metaFile = path.join(rescueDir, 'snapshot.json')
  if (!fs.existsSync(metaFile)) return { ok: false, message: '没有救援点，请先「创建救援点」' }
  let meta
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) } catch { return { ok: false, message: '救援点元数据损坏，请重新创建救援点' } }
  const files = Array.isArray(meta.files) ? meta.files : RESCUE_FILES
  fs.mkdirSync(profileDir, { recursive: true })
  const restored = []
  for (const f of files) {
    const src = path.join(rescueDir, f)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(profileDir, f))
      restored.push(f)
    }
  }
  if (!restored.length) return { ok: false, message: '救援点内没有可还原的文件' }
  return { ok: true, files: restored, at: meta.at }
}

// 读取 profile 的 bundle 清单（package.json -> dsh.profile.bundles）
function listBundles(profileDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    return Array.isArray(pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  } catch { return [] }
}

// 从启动日志诊断崩溃原因。返回 { issues: [{ type, plugin, message, fix }] }
// type: missing-bundle / plugin-failed / bad-profile / missing-module
// fix:  exclude-bundle（从 bundles 移除该插件）| restore（还原救援点）
function diagnoseCrash(logLines) {
  const lines = Array.isArray(logLines) ? logLines : String(logLines || '').split(/\r?\n/)
  const issues = []
  const seen = new Set()
  const add = (type, plugin, message, fix) => {
    const key = `${type}:${String(plugin || '').toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    issues.push({ type, plugin: plugin || '', message, fix })
  }
  for (const raw of lines) {
    const text = String(raw || '')
    let m
    m = text.match(/cannot resolve profile bundle ["']([^"']+)["']/i)
    if (m) { add('missing-bundle', m[1], `profile 声明了插件「${m[1]}」但未安装，导致启动失败`, 'exclude-bundle'); continue }
    m = text.match(/plugin\(s\) failed to load:\s*([^\n;]+)/i)
    if (m) {
      for (const name of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
        add('plugin-failed', name, `插件「${name}」加载失败导致启动中止`, 'exclude-bundle')
      }
      continue
    }
    if (/failed to parse (patches|overlay|config file)/i.test(text) || /must be a top-level YAML array/i.test(text)) {
      add('bad-profile', '', text.replace(/^Error:\s*/i, '').slice(0, 160), 'restore')
      continue
    }
    m = text.match(/Cannot find package ['"]([^'"]+)['"]/i) || text.match(/ERR_MODULE_NOT_FOUND[^"]*['"]([^'"]+)['"]/i)
    if (m) {
      const dep = m[1]
      // 源码形态缺 devDependency（如 tsx）：克隆源码未 pnpm install 的典型报错。
      // 修复 = 安装依赖（install-deps），排除插件/还原救援点都没用。
      if (/^tsx$|tsx[/\\]esm|esbuild/i.test(dep) || /tsx[/\\]esm/i.test(text)) {
        add('source-deps', dep, `源码形态依赖缺失（${dep}）：克隆源码后未安装依赖，需要安装源码依赖后重启`, 'install-deps')
        continue
      }
      add('missing-module', dep, `缺少依赖包「${dep}」`, 'exclude-bundle')
      continue
    }
    // profile 插件与 DSH 版本不匹配：更新主包后 profile bundle 未同步，
    // rc.8 加载旧 bundle 时报 "Unknown file extension .css / ERR_UNKNOWN_FILE_EXTENSION"，
    // 或 bundle 引用主包不存在的模块（failed to import loader entry ... missed the module table）。
    // 这类崩溃在依赖层面，救援点（仅配置文件）救不了，修复 = 重装 profile 依赖 + 重启（reinstall）。
    m = text.match(/Unknown file extension ["']?\.([a-z0-9]+)["']?/i) || text.match(/ERR_UNKNOWN_FILE_EXTENSION/i)
    if (m) {
      add('bundle-mismatch', '', `profile 插件与 DSH 版本不匹配（加载 .${m[1] || '资源'} 失败）：更新 DSH 后 profile 依赖未同步，需要重新安装 profile 依赖后重启`, 'reinstall')
      continue
    }
    if (/failed to import loader entry/i.test(text)) {
      add('bundle-mismatch', '', 'profile 插件加载失败（版本不匹配）：bundle 引用了主包不存在的模块，需要重新安装 profile 依赖后重启', 'reinstall')
      continue
    }
    // DSH 更新失败回滚后最常见的崩法：git 只回滚源码，packages/**/lib 编译产物与依赖新旧混装，
    // 启动时 plugin tree 报 xxx is not a function（如 ctx.subagents.registerContinuableSetup）。
    // 救援点只有 profile 配置文件，救不了源码目录，必须 clean + 完整重建。
    if (/plugin tree failed to load|failed to apply loader entry/i.test(text) && /is not a function/i.test(text)) {
      add('source-mixed', '', 'DSH 更新回滚后源码与编译产物混装（loader 调用不存在的函数）：需要清理全部编译产物并重建源码后重启', 'rebuild-source')
      continue
    }
    // 工具调度器未注册（#1677/#2130）：根因多为重复安装的 @deepseek-ai/* 依赖拷贝，
    // 与 bundle 错配同类，同样需要重装 profile 依赖。
    m = text.match(/Cannot read properties of undefined \(reading ['"]([^'"]+)['"]\)/i)
    if (m && /prepare|ToolRuntime|scheduler/i.test(text)) {
      add('bundle-mismatch', '', `工具调度器未注册（reading '${m[1]}'）：多为重复安装的 @deepseek-ai/* 依赖导致，需要重新安装 profile 依赖后重启`, 'reinstall')
      continue
    }
    // 插件重复注册（#3263/#2889）：插件市场安装/更新插件后 `duplicate loader entry id: <id>`，
    // 同一 loader entry 被注册两次（cordis.patch.yml 与 bundle 重复）。修复 = 排除重复注册。
    m = text.match(/duplicate loader entry id: ([a-z0-9_-]+)/i)
    if (m) {
      add('duplicate-plugin', m[1], `插件「${m[1]}」重复注册（duplicate loader entry）：插件市场安装/更新后与已有注册冲突，需要移除重复注册`, 'exclude-bundle')
      continue
    }
    // 工具链命令缺失（#2990）：Windows 下 spawn bash 等子进程 ENOENT，harness 未捕获整体崩溃。
    // 启动器会自动重新自举 node/pnpm/npm/git 工具链，重启即可。
    if (/ENOENT/i.test(text) && /spawn|bash|exec|createProcess/i.test(text)) {
      add('tool-missing', '', '工具链命令缺失（spawn ENOENT）：启动器会自动重新自举 node/pnpm/npm/git 工具链，重新启动即可', 'restart')
      continue
    }
    // CLI 参数不兼容：如 npm 预构建包 rc.7 不认 --no-open → "unknown option '--no-open'"
    // 启动器 0.6.22 起启动前自动探测参数兼容性，遇到此错误直接重试启动即可。
    m = text.match(/unknown option ['"]([^'"]+)['"]/i)
    if (m) { add('cli-arg', '', `启动参数「${m[1]}」当前 DSH 版本不支持（启动器已自动适配参数，直接重新启动即可）`, 'restart'); continue }
    if (/^error:\s+/.test(text) && !/ECONNREFUSED|EADDRINUSE/i.test(text)) {
      add('cli-error', '', text.replace(/^error:\s*/i, '').slice(0, 200), 'restart')
      continue
    }
  }
  return { ok: true, issues }
}

// 文本级：按顶层条目块整体删除包含该插件名的条目（cordis.yml 的 `- id:` / cordis.patch.yml 的 `- insert:` 块）。
// 不能只删单行——官方 #880 案例里坏条目是 `- insert: … - id: … name: '@deepseek-ai/dsh-client-ui-xxx'`，
// 只删 name 行会留下残缺的 `- id:`，仍然崩溃。
function stripEntryContaining(text, name) {
  const lines = text.split(/\r?\n/)
  const blocks = []
  let cur = []
  for (const line of lines) {
    if (/^\s*-\s+/.test(line) && !/^\s*-\s*$/.test(line) && line === line.trimStart()) {
      if (cur.length) blocks.push(cur)
      cur = [line]
    } else {
      cur.push(line)
    }
  }
  if (cur.length) blocks.push(cur)
  const kept = blocks.filter(block => !block.some(l => l.includes(name)))
  const result = kept.map(b => b.join('\n')).join('\n')
  return result ? result + '\n' : ''
}

// 从 profile 的 bundles 中排除崩溃插件（保留其它 bundle 与 node_modules，不重装）。
// 同时按顶层条目块清理 cordis.yml / cordis.patch.yml 中引用该插件名的条目。
function excludePlugin(profileDir, pluginName) {
  const name = String(pluginName || '').trim()
  if (!name) return { ok: false, message: '未指定要排除的插件' }
  const pkgFile = path.join(profileDir, 'package.json')
  let pkg
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) } catch { return { ok: false, message: 'profile package.json 读取失败' } }
  const bundles = Array.isArray(pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  const next = bundles.filter(b => String(b).toLowerCase() !== name.toLowerCase())
  const removedFromBundle = next.length !== bundles.length
  if (removedFromBundle) {
    pkg.dsh.profile.bundles = next
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  }
  let removedFromPatch = false
  for (const f of ['cordis.yml', 'cordis.patch.yml']) {
    const file = path.join(profileDir, f)
    if (!fs.existsSync(file)) continue
    const before = fs.readFileSync(file, 'utf8')
    const stripped = stripEntryContaining(before, name)
    if (stripped !== before) {
      // patch 文件必须仍是合法顶层数组（parsePatchList 要求）。删除条目后若只剩注释/空，补上 []
      let final = stripped
      if (!/^\s*-\s+/.test(stripped) || !stripped.trim()) {
        final = stripped.trim() ? `${stripped.trimEnd()}\n[]\n` : '[]\n'
      }
      fs.writeFileSync(file, final, 'utf8')
      removedFromPatch = true
    }
  }
  if (!removedFromBundle && !removedFromPatch) return { ok: false, message: `bundle 与配置中均未找到插件「${name}」` }
  return { ok: true, removed: name, removedFromBundle, removedFromPatch, bundles: listBundles(profileDir) }
}

// 自动恢复阶梯 L3 工厂重置：备份现有 profile 关键配置，重建最小可用 profile（仅官方 bundle）。
// 用于依赖/配置已烂到对症修复和完整恢复都无效时，让小白无感回到"能用"状态。
// 返回 { ok, backupDir, files }；备份目录含被替换前的配置文件，可手动找回。
const FACTORY_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
function factoryResetProfile(profileDir, backupDir) {
  try {
    if (!fs.existsSync(profileDir)) return { ok: false, message: 'profile 目录不存在' }
    fs.mkdirSync(backupDir, { recursive: true })
    const backed = []
    for (const f of RESCUE_FILES) {
      const src = path.join(profileDir, f)
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, f))
        backed.push(f)
      }
    }
    // 重建最小可用 profile：仅官方 bundle，无任何 patch / 自定义插件
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: FACTORY_BUNDLES } } }, null, 2) + '\n', 'utf8')
    fs.writeFileSync(path.join(profileDir, 'cordis.yml'), '[]\n', 'utf8')
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')
    return { ok: true, backupDir, files: backed, bundles: FACTORY_BUNDLES }
  } catch (e) {
    return { ok: false, message: `工厂重置失败：${e && e.message || e}` }
  }
}

module.exports = {
  RESCUE_FILES,
  rescueDirFor,
  createRescueSnapshot,
  rescueStatus,
  recordCrash,
  readCrashRecord,
  markCrashRecovered,
  restoreRescueSnapshot,
  listBundles,
  diagnoseCrash,
  excludePlugin,
  factoryResetProfile,
  FACTORY_BUNDLES,
}
