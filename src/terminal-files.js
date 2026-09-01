'use strict'

const path = require('node:path')
const os = require('node:os')

function normalizeNonEmpty(value) {
  const text = String(value || '').trim()
  return text ? path.resolve(text) : ''
}

function isSameOrInside(parent, child) {
  const base = normalizeNonEmpty(parent)
  const candidate = normalizeNonEmpty(child)
  if (!base || !candidate) return false
  const rel = path.relative(base, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function pathsOverlap(a, b) {
  return isSameOrInside(a, b) || isSameOrInside(b, a)
}

function uniqueTopRoots(values) {
  const roots = [...new Set(values.map(normalizeNonEmpty).filter(Boolean))]
  return roots.filter(root => !roots.some(other => other !== root && isSameOrInside(other, root)))
}

function planTerminalDeletion(terminal, others, userData) {
  const home = normalizeNonEmpty(terminal.dshHome)
  const dshDir = normalizeNonEmpty(terminal.dshDir)
  const sourceType = String(terminal && terminal.sourceType || '')
  const terminalsRoot = path.join(path.resolve(userData), 'terminals')
  const defaultHome = path.join(os.homedir(), '.dsh')
  const managedContainer = value => {
    if (!value || !isSameOrInside(terminalsRoot, value)) return ''
    const rel = path.relative(terminalsRoot, value)
    const first = rel.split(path.sep).filter(Boolean)[0]
    return first ? path.join(terminalsRoot, first) : ''
  }
  let roots = []

  if (sourceType === 'fresh-empty') {
    // ★ 数据安全（1.4.0）：fresh-empty 允许用户选任意目录建终端，删除时会整棵物理删除。
    //   若用户选的是 ~/.dsh（真实 DSH 数据）、其内部、用户主目录本身或其一级子目录
    //   （Desktop/Documents/Downloads 等），删除等于清掉用户真实数据 —— 一律拒绝删除。
    const homeDirNorm = normalizeNonEmpty(os.homedir())
    const defaultNorm = normalizeNonEmpty(defaultHome)
    const insideHomedirDepth = (() => {
      const rel = path.relative(homeDirNorm, home)
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return -1
      return rel.split(path.sep).filter(Boolean).length
    })()
    if (pathsOverlap(defaultHome, home) || homeDirNorm === home || (insideHomedirDepth >= 0 && insideHomedirDepth <= 1)) {
      return { registrationOnly: false, roots: [], blocked: true, reason: 'protected-home', conflict: home }
    }
    roots = [home]
  } else {
    // 删除范围 = 该终端独占的目录：
    //  - launcher 自建终端（fresh-installed/cloned）：整个 terminals/<id> 容器一起删
    //  - 手动/扫描接入：安装目录（dshDir）+ 非共享 home（~/.dsh 保留——可能被其他终端/DSH 使用）
    const candidates = []
    if (dshDir) candidates.push(dshDir)
    const homeNorm = normalizeNonEmpty(home)
    const defaultNorm = normalizeNonEmpty(defaultHome)
    if (homeNorm && homeNorm.toLowerCase() !== defaultNorm.toLowerCase() && homeNorm !== normalizeNonEmpty(dshDir)) candidates.push(home)
    const containers = candidates.map(managedContainer).filter(Boolean)
    if (containers.length) roots = uniqueTopRoots(containers)
    else roots = uniqueTopRoots(candidates)
  }

  const protectedPaths = [path.parse(userData).root, os.homedir(), path.resolve(userData)].map(normalizeNonEmpty)
  roots = roots.filter(root => root && !protectedPaths.some(protectedPath => root.toLowerCase() === protectedPath.toLowerCase()))

  const otherPaths = (others || []).flatMap(item => [normalizeNonEmpty(item.dshHome), normalizeNonEmpty(item.dshDir)]).filter(Boolean)
  const conflict = roots.find(root => otherPaths.some(other => pathsOverlap(root, other)))
  if (conflict) return { registrationOnly: false, roots: [], blocked: true, reason: 'shared-or-nested', conflict }
  return { registrationOnly: false, roots, blocked: false, reason: '' }
}

module.exports = { normalizeNonEmpty, isSameOrInside, pathsOverlap, planTerminalDeletion }
