'use strict'

// 打包后清理：dist 只保留当前最新版本，删除所有旧版便携目录 / zip / Setup exe，
// 避免版本越堆越多。当前最新版本 = 从 package.json 读取。
// 正在被运行的版本文件会被系统锁住，删除失败时自动跳过（不影响其他清理）。

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', 'dist')
let version = ''
try { version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '' } catch { /* 忽略 */ }
if (!version) { console.log('clean-dist: 无法读取版本号，跳过清理'); process.exit(0) }

let removed = 0
let locked = []
const tryRemove = (p, label) => {
  try {
    fs.rmSync(p, { recursive: true, force: true })
    removed++
    console.log(`已删: ${label}`)
  } catch {
    locked.push(label)
  }
}

// ★ 发布产物名已统一为 ASCII（与 GitHub release 资产/下载链接一致）：ZAT-DSH-Launcher-*。
//   旧前缀（ZAT启动器-便携版- / ZAT启动器 Setup ）一并保留匹配，清掉历史版本残骸。
const OLD_PREFIXES = ['ZAT启动器-便携版-', 'ZAT启动器 Setup ']
const isOldArtifact = (name) => OLD_PREFIXES.some(p => name.startsWith(p)) && (name.endsWith('.exe') || name.endsWith('.exe.blockmap') || name.includes('便携版'))

for (const name of fs.readdirSync(root)) {
  if (name.includes(version)) continue // 保留当前版本
  if (name.startsWith('ZAT-DSH-Launcher-')) tryRemove(path.join(root, name), name)
  else if (isOldArtifact(name)) tryRemove(path.join(root, name), name)
}

if (locked.length) console.log(`清理完成（${removed} 项）。以下正被运行锁住，未能删除：${locked.join('、')}`)
else console.log(`清理完成（${removed} 项），dist 只保留 v${version}`)
