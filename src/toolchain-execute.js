'use strict'

// 工具链执行器：启动器所有 git/pnpm/npm/node 子进程调用的统一出口。
// 历史教训（0.6.19/0.6.20 一键安装两次失败的根因）：
//  1. Node 24 无 shell 时 execFile/spawn 对 .cmd 文件直接抛 EINVAL —— 绝不 execFile .cmd
//  2. pnpm 的可执行形态是 executablePnpm 返回的 { file, args } 对象（node <pnpm.cjs> 组合）
//     —— 两种调用风格都必须正确展开对象，否则参数错位报
//     "callback must be of type function. Received an instance of Object"
// 本模块是唯一执行出口，两种签名都归一化，测试覆盖，防止再次分叉。

const { execFile } = require('node:child_process')

// pnpm 对象展开：{ file, args } → (file, [...prefixArgs, ...args])
function expandExec(file, args) {
  if (file && typeof file === 'object' && typeof file.file === 'string') {
    return { file: file.file, args: [...(file.args || []), ...(args || [])] }
  }
  return { file, args }
}

// .cjs/.mjs 文件不能直接作为 Windows 可执行文件 CreateProcess（Electron Node 20 抛 spawn UNKNOWN），
// 统一转成 node <file> 组合。执行器携 env 均有 node 目录注入 PATH，"node" 可解析。
function wrapJsFile(n) {
  if (typeof n.file === 'string' && /\.(cjs|mjs)$/i.test(n.file)) {
    return { file: 'node', args: [n.file, ...(n.args || [])] }
  }
  return n
}

// makeToolchainExecute(env) → fn
// fn 兼容两种调用风格：
//  - run 风格：fn(file, args, cwd, timeout[, envOverride])
//  - runWithProgress 风格：fn(description, file, args, cwd, onProgress, timeout[, env])
// file 可为字符串或 executablePnpm 返回的 { file, args } 对象。
function makeToolchainExecute(env) {
  const execWithEnv = (file, args, cwd, timeout, envOverride) => {
    const n = wrapJsFile(expandExec(file, args))
    return new Promise(resolve => {
      // ★ 执行器不可用（如 pnpm 自举失败传 null）→ 明确失败结果而不是 execFile(null) 同步抛
      //   ERR_INVALID_ARG_TYPE 变成未捕获 reject（曾让更新在 merge 后无回滚无提示）
      if (!n.file || typeof n.file !== 'string') {
        return resolve({ ok: false, code: -1, out: '', err: '执行器不可用（可执行文件为空，多为工具链自举失败）' })
      }
      execFile(n.file, n.args, {
        cwd,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        timeout,
        env: envOverride || env,
      }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error && error.code || 0,
          out: String(stdout || '').trim(),
          err: String(stderr || (error && error.message) || '').trim(),
        })
      })
    })
  }
  const fn = (a1, a2, a3, a4, a5, a6, a7) => {
    // runWithProgress 风格：第一个参数是 description（字符串），第二个是 file
    // （pnpm 可为 { file, args } 对象，必须展开为 node <cjs> 组合，不能掉进 run 风格）
    if (typeof a1 === 'string' && (typeof a2 === 'string' || (a2 && typeof a2 === 'object' && typeof a2.file === 'string'))) {
      const description = a1
      const onProgress = a5
      const timeout = a6 || 600000
      const n = wrapJsFile(expandExec(a2, a3))
      return new Promise(resolve => {
        if (!n.file || typeof n.file !== 'string') {
          return resolve({ ok: false, code: -1, out: '', err: '执行器不可用（可执行文件为空，多为工具链自举失败）' })
        }
        const child = execFile(n.file, n.args, {
          cwd: a4,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          timeout,
          env: a7 || env,
        }, (error, stdout, stderr) => {
          resolve({
            ok: !error,
            code: error && error.code || 0,
            out: String(stdout || '').trim(),
            err: String(stderr || (error && error.message) || '').trim(),
          })
        })
        const pump = stream => {
          if (!stream || typeof onProgress !== 'function') return
          let pending = ''
          stream.on('data', chunk => {
            pending += chunk.toString()
            const lines = pending.split(/\r?\n/)
            pending = lines.pop() || ''
            for (const line of lines) {
              const t = line.trim()
              if (t) onProgress(description, t)
            }
          })
          stream.on('end', () => { if (pending.trim()) onProgress(description, pending.trim()) })
        }
        if (child.stdout) pump(child.stdout)
        if (child.stderr) pump(child.stderr)
      })
    }
    // run 风格：(file, args, cwd, timeout[, envOverride]) —— ★ 第 5 参 envOverride 此前被
    //   硬编码丢弃，runBuild 精心构造的 buildEnv（pnpm 目录前置）全部失效；现真实生效。
    return execWithEnv(a1, a2, a3, a4, a5)
  }
  fn.env = env
  return fn
}

module.exports = { makeToolchainExecute, expandExec, wrapJsFile }
