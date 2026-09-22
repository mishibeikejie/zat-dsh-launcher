'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { zstdDecompressSync } = require('node:zlib')

/* DSH 会话活动提取：读取终端 DSH_HOME/sessions 下每个会话的事件流（zstd 逐帧），
 * 提取「这个对话做过什么」——会话标题、完整对话消息（用户/助手）、每次工具调用的
 * 人类可读摘要、目标/任务清单/预设/权限等变更。
 * 只读不写，每终端独立，绝不跨终端。
 *
 * DSH 0.7.x 会话流是「流式」结构，真正的有内容事件是：
 *   - agent/inbox/spliced  完整消息插入对话（含用户原文，role=user/assistant）
 *   - text-chunks          助手文本流式碎片（按 turn|step 聚合为完整消息）
 *   - tool-call-chunks     工具调用流式碎片（按 id 聚合 name+args）
 *   - assistant/chunk      块级事件，block-end 时含完整 tool-call
 *   - tool/call|result     少量非流式工具事件
 *   - goal/change|session/title|agent-preset/selected|llm/retry-started|session/end-seed 等
 * 纯噪音（跳过）：reasoning-chunks、step/start、step/end、*chunks 碎片本身（聚合后）。 */

// 工具参数 → 人类可读摘要（关键字段截断，避免整段参数进 UI）
function summarizeArgs(name, args) {
  let a
  try { a = typeof args === 'string' ? JSON.parse(args) : (args || {}) } catch { a = {} }
  const pick = key => {
    const v = a[key]
    if (v === undefined || v === null) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return s.slice(0, 120)
  }
  switch (String(name || '')) {
    case 'web_search': return pick('query') ? `搜索「${pick('query')}」` : '联网搜索'
    case 'web': return pick('url') ? `访问 ${pick('url')}` : '访问网页'
    case 'pwsh': {
      const c = pick('command') || pick('pwsh')
      if (!c) return '运行命令'
      // 命令原文可能很长（调试脚本/多行命令），压掉换行后截断到 80 字符，
      // 避免整段命令文本（含多行 here-string）刷进会话日志（用户反馈 1.0.8）。
      const flat = c.replace(/\s+/g, ' ').trim()
      return flat.length > 80 ? `运行命令：${flat.slice(0, 80)}…` : `运行命令：${flat}`
    }
    case 'read': return pick('file_path') ? `读取文件 ${pick('file_path')}` : '读取文件'
    case 'read_image': return pick('file_path') ? `查看图片 ${pick('file_path')}` : '查看图片'
    case 'write': return pick('file_path') ? `写入文件 ${pick('file_path')}` : '写入文件'
    case 'edit': return pick('file_path') ? `编辑文件 ${pick('file_path')}` : '编辑文件'
    case 'grep': return pick('pattern') ? `检索 ${pick('pattern')}${pick('path') ? ' in ' + pick('path') : ''}` : '检索内容'
    case 'glob': return pick('pattern') ? `查找文件 ${pick('pattern')}` : '查找文件'
    case 'find_plugin': return pick('query') ? `搜索插件「${pick('query')}」` : '搜索插件'
    case 'subagent': return pick('description') ? `派生子代理：${pick('description')}` : '派生子代理'
    case 'subagent_fork': return pick('description') ? `派生子代理(fork)：${pick('description')}` : '派生子代理'
    case 'workflow': return pick('name') ? `运行工作流 ${pick('name')}` : '运行工作流'
    case 'ask_user_question': return '向用户提问'
    case 'skill': return pick('name') ? `加载技能 ${pick('name')}` : '加载技能'
    case 'create_goal': return '创建目标'
    case 'update_goal': return '更新目标'
    case 'todo_write': return '更新任务清单'
    case 'cordis_define': return '定义 Cordis 插件'
    case 'cordis_run': return '运行 Cordis 插件'
    case 'cordis_stop': return '停止 Cordis 插件'
    case 'cordis_undefine': return '删除 Cordis 插件'
    default: return String(name || '工具调用')
  }
}

// 消息摘要（用户/助手对话内容进运行日志时的显示文本）：
// 压掉换行/连续空白 + 截断。完整对话内容保留在会话记录里，
// 运行日志只显示"谁说了什么"的开头，避免长回复/多行代码刷屏（用户反馈 1.0.8）。
const MSG_SUMMARY_LEN = 120
function summarizeMessage(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > MSG_SUMMARY_LEN ? `${s.slice(0, MSG_SUMMARY_LEN)}…` : s
}

// 事件统一摘要。返回 { key, summary, name, time, seq } 或 null（跳过）。
// key 用于增量去重（同一条消息/调用只推送一次，跨轮询稳定）；
// seq 用于游标增量（只输出 seq 大于已见最大 seq 的事件，key 可安全裁剪）。
function summarizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return null
  const t = ev.type || ''
  const d = ev.data && typeof ev.data === 'object' ? ev.data : {}
  const time = ev.time || ev.time0 || 0
  const seq = ev.seq0 !== undefined ? ev.seq0 : (ev.seq !== undefined ? ev.seq : time)
  const pick = (key) => {
    const v = d[key]
    if (v === undefined || v === null) return ''
    return typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 120)
  }
  switch (t) {
    // ---- 完整消息（agent/inbox/spliced）：对话真实内容，含用户原文 ----
    case 'agent/inbox/spliced': {
      const inserted = Array.isArray(d.inserted) ? d.inserted : []
      const out = []
      for (const msg of inserted) {
        if (!msg || typeof msg !== 'object') continue
        const role = msg.role === 'user' ? '用户' : '助手'
        const text = extractContentText(msg.content)
        if (!text) continue
        const id = msg.id || `${seq}-${out.length}`
        out.push({
          key: `msg|${id}`,
          summary: `${role}：${summarizeMessage(text)}`,
          name: role === '用户' ? 'user-message' : 'assistant-message',
          time,
          seq,
        })
      }
      return out // 数组（一条 spliced 可含多条消息）
    }
    // ---- 助手完整消息（DSH 在消息写完时追加，含完整 content；text-chunks 只是流式碎片） ----
    case 'assistant/message': {
      const msg = d.message && typeof d.message === 'object' ? d.message : {}
      const text = extractContentText(msg.content)
      if (!text) return null
      const id = msg.id || `asm|${d.turn}|${d.step}`
      return {
        key: `msg|${id}`,
        summary: `助手：${summarizeMessage(text)}`,
        name: 'assistant-message',
        time,
        seq,
      }
    }
    // ---- 非流式工具事件 ----
    case 'tool/call': {
      const s = summarizeArgs(d.name, d.arguments)
      return { key: `toolc|${seq}`, summary: s, name: 'tool:' + (d.name || ''), time, seq }
    }
    case 'tool/result':
      return d.error ? { key: `toolr|${seq}`, summary: `工具结果出错：${String(d.error).slice(0, 120)}`, name: 'tool-result', time, seq } : null
    // ---- 直接事件 ----
    case 'goal/change':
      return { key: `goal|${seq}`, summary: `目标变更：${pick('summary') || pick('objective') || ''}`, name: 'goal-change', time, seq }
    case 'session/title':
      return pick('title') ? { key: `title|${seq}`, summary: `会话标题：${pick('title')}`, name: 'session-title', time, seq } : null
    case 'agent-preset/selected':
      return { key: `preset|${seq}`, summary: `选择预设：${pick('agentPreset') || pick('id') || pick('name') || ''}`, name: 'agent-preset', time, seq }
    case 'llm/retry-started':
      return { key: `retry|${seq}`, summary: `LLM 重试（第 ${pick('retry') || 1} 次）`, name: 'llm-retry', time, seq }
    case 'session/end-seed':
      // DSH 语义：会话构造函数把历史播种(seed)完成后追加的边界标记，
      // 出现在恢复/重启/子会话场景。不是"会话结束"，文案改为恢复提示。
      return { key: `endseed|${seq}`, summary: '对话已恢复（历史重新载入）', name: 'session-end-seed', time, seq }
    case 'web/deepseek-search-llm-request': {
      // 搜索请求：query 在 body.messages 里
      let query = ''
      try {
        const body = typeof d.body === 'string' ? JSON.parse(d.body) : (d.body || {})
        const messages = Array.isArray(body.messages) ? body.messages : []
        for (const m of messages) {
          const c = m && m.content
          if (typeof c === 'string' && c) { query = c; break }
          if (Array.isArray(c)) {
            const t = c.find(x => x && typeof x === 'object' && x.type === 'text' && x.text)
            if (t) { query = t.text; break }
          }
        }
      } catch { /* 解析失败忽略 */ }
      if (!query) return null
      const clean = query.replace(/^Perform a web search for the query:\s*/i, '').slice(0, 120)
      return { key: `searchreq|${seq}`, summary: `联网搜索请求：${clean}`, name: 'search-request', time, seq }
    }
    default:
      return null // reasoning-chunks / step/* / chunks 碎片等噪音跳过
  }
}

// 从消息 content 提取纯文本（content 可为字符串或 [{type:'text',text}] 数组）
function extractContentText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    let out = ''
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'text' && typeof part.text === 'string') out += part.text
    }
    return out.trim()
  }
  return ''
}

// 提取单个会话文件的活动。返回 { header, title, tools, events } 或 null。
// tools = 兼容旧字段（仅非流式工具调用）；events = 全部有意义事件
// （完整消息/工具调用/目标/标题/预设/重试等，带 key 与 seq 供增量推送）。
// fromByte：增量模式，只从该字节附近开始解压新帧（zstd 帧独立可解）。
// 向前回退 64KB 重新扫描，避免上次轮询时正在写入的半帧丢失；重复帧由主进程按 seq 游标去重。
function extractSession(file, fromByte = 0) {
  let buf
  try { buf = fs.readFileSync(file) } catch { return null }
  const isZstd = String(file).endsWith('.zstd')
  let lines
  if (isZstd) {
    lines = []
    let off = Math.max(0, (Number(fromByte) || 0) - 65536)
    if (off > 0) {
      // 从回退点起扫描到下一个完整帧边界（魔数 28 B5 2F FD）
      let found = -1
      for (let i = off; i + 4 <= buf.length; i++) {
        if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) { found = i; break }
      }
      if (found === -1) return { header: null, title: '', tools: [], events: [] } // 没有新帧
      off = found
      // 增量模式也要拿最新标题：解压文件头部（最多 100KB）找 session/title 帧，
      // 否则标题变更后下拉/日志前缀不会实时更新（用户反馈：标题不更新、下拉乱）。
      const headEnd = Math.min(buf.length, 100 * 1024)
      if (headEnd > 0) {
        let hOff = 0
        while (hOff < headEnd) {
          let next = -1
          for (let i = hOff + 4; i + 4 <= headEnd; i++) {
            if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) { next = i; break }
          }
          const end = next === -1 ? headEnd : next
          try { lines.push(zstdDecompressSync(buf.subarray(hOff, end)).toString('utf8')) } catch { /* 跳过坏帧 */ }
          hOff = end
          if (next === -1) break
        }
      }
    }
    while (off < buf.length) {
      let next = -1
      for (let i = off + 4; i + 4 <= buf.length; i++) {
        if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) { next = i; break }
      }
      const end = next === -1 ? buf.length : next
      try { lines.push(zstdDecompressSync(buf.subarray(off, end)).toString('utf8')) } catch { /* 跳过坏帧 */ }
      off = end
      if (next === -1) break
    }
  } else {
    lines = buf.toString('utf8').split(/\r?\n/)
  }
  let header = null
  let title = ''
  const tools = []
  const events = []
  // ---- 流式碎片聚合器 ----
  const textAgg = new Map() // `${turn}|${step}` -> { parts: [], time }
  const toolAgg = new Map() // id -> { name, parts: [], time, maxSeq }
  const asmSteps = new Set() // 已有 assistant/message 完整消息的 turn|step（碎片让位，防重复推送）
  const flushText = () => {
    for (const [key, agg] of textAgg) {
      if (asmSteps.has(key)) continue // 完整消息已在 assistant/message 输出，跳过碎片
      const text = agg.parts.join('').trim()
      if (text) events.push({ key: `text|${key}`, summary: `助手：${summarizeMessage(text)}`, name: 'assistant-message', time: agg.time, seq: agg.maxSeq || 0 })
    }
    textAgg.clear()
  }
  const flushTools = () => {
    for (const [id, agg] of toolAgg) {
      const args = agg.parts.join('').trim()
      const s = args ? summarizeArgs(agg.name, args) : String(agg.name || '工具调用')
      events.push({ key: `tool|${id}`, summary: s, name: 'tool:' + (agg.name || ''), time: agg.time, seq: agg.maxSeq || 0 })
    }
    toolAgg.clear()
  }
  // 帧文本可能是多行 JSONL（DSH 批量 flush：一轮结束的 spliced/assistant-message/
  // step-end 会打包在同一帧）。必须逐行解析——整帧 JSON.parse 会失败并丢整帧，
  // 这是「用户消息/助手完整消息随机消失」的根因（修复 0.6.19）。
  for (const seg of lines) {
    for (const rawLine of String(seg).split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      if (!ev || typeof ev !== 'object') continue
    const t = ev.type || ''
    const d = ev.data && typeof ev.data === 'object' ? ev.data : {}
    if (t === 'session') {
      header = { id: ev.id, createdAt: ev.createdAt, cwd: ev.cwd }
      continue
    }
    if (t === 'session/title') {
      const tt = (d.title || '').trim()
      // 取最后一个 title 事件 = 最新标题（用户重命名后 DSH 会追加新 title 事件，
      // 之前只取第一个导致日志永远显示旧名字）
      if (tt) title = tt
      // 不 continue：同时作为事件输出（summarizeEvent 处理，key 去重防刷屏）
    } else if (t === 'reasoning-chunks' || t === 'step/start' || t === 'step/end' || t === 'turn/start' || t === 'turn/end') {
      continue // 纯噪音
    }
    // ---- 流式碎片：先聚合，不直接输出 ----
    if (t === 'text-chunks') {
      const k = `${d.turn}|${d.step}`
      let agg = textAgg.get(k)
      if (!agg) { agg = { parts: [], time: ev.time0 || ev.time || 0, maxSeq: 0 }; textAgg.set(k, agg) }
      if (Array.isArray(d.texts)) for (const piece of d.texts) if (typeof piece === 'string') agg.parts.push(piece)
      const sq = ev.seq0 !== undefined ? ev.seq0 : (ev.seq !== undefined ? ev.seq : 0)
      if (sq > agg.maxSeq) agg.maxSeq = sq
      continue
    }
    if (t === 'tool-call-chunks') {
      const id = d.id || `${d.turn}|${d.step}|${d.name || ''}`
      let agg = toolAgg.get(id)
      if (!agg) { agg = { name: d.name || '', parts: [], time: ev.time0 || ev.time || 0, maxSeq: 0 }; toolAgg.set(id, agg) }
      if (Array.isArray(d.args)) for (const piece of d.args) if (typeof piece === 'string') agg.parts.push(piece)
      const sq = ev.seq0 !== undefined ? ev.seq0 : (ev.seq !== undefined ? ev.seq : 0)
      if (sq > agg.maxSeq) agg.maxSeq = sq
      continue
    }
    // ---- 块级事件：block-end 时含完整工具调用 ----
    if (t === 'assistant/chunk') {      const chunk = d.chunk && typeof d.chunk === 'object' ? d.chunk : {}
      const block = chunk.block && typeof chunk.block === 'object' ? chunk.block : {}
      if (chunk.type === 'block-end' && block.type === 'tool-call' && block.id) {
        events.push({
          key: `tool|${block.id}`,
          summary: summarizeArgs(block.name, block.arguments),
          name: 'tool:' + (block.name || ''),
          time: ev.time || ev.time0 || 0,
          seq: ev.seq0 !== undefined ? ev.seq0 : (ev.seq !== undefined ? ev.seq : (ev.time || 0)),
        })
      }
      continue
    }
    // ---- 非流式工具（兼容旧会话文件） ----
    if (t === 'tool/call' && d.name) {
      const s = summarizeArgs(d.name, d.arguments)
      const sq = ev.seq0 !== undefined ? ev.seq0 : (ev.seq !== undefined ? ev.seq : (ev.time || 0))
      tools.push({ name: d.name, summary: s, time: ev.time || 0 })
      events.push({ key: `toolc|${sq}`, summary: s, name: 'tool:' + d.name, time: ev.time || 0, seq: sq })
      continue
    }
    // ---- 助手完整消息：记录该 turn|step 已有完整版（text-chunks 碎片让位防重复） ----
    if (t === 'assistant/message') {
      asmSteps.add(`${d.turn}|${d.step}`)
    }
    // ---- 其余有意义事件 ----
    const s = summarizeEvent(ev)
      if (s) {
        if (Array.isArray(s)) {
          for (const item of s) if (item) events.push(item)
        } else {
          events.push(s)
        }
      }
    }
  }
  flushText()
  flushTools()
  return { header, title, tools, events }
}

// 会话文件名随 DSH 版本变化：早期 session.jsonl(.zstd)，0.1.5 起 session.v3.jsonl.zstd，
// 0.1.7 起 V4 会话（session.v4.jsonl.zstd）。硬编码 session.jsonl(.zstd) 会漏掉全部带版本号的
// 会话——实测本机 0.1.5 环境 110 个会话里 104 个 v3 + 4 个 v2 都读不到（统计只剩零星老会话）。
// 统一按 session[.版本].jsonl[.zstd] 匹配。
const SESSION_FILE_RE = /^session(?:\.[a-z0-9]+)?\.jsonl(?:\.zstd)?$/i

// 版本号大小：session.v4.jsonl.zstd > session.v3.jsonl.zstd > session.jsonl.zstd（无版本号记 0）
function sessionFileRank(name) {
  const m = String(name).match(/^session\.v(\d+)\./i)
  return m ? Number(m[1]) : 0
}

// 在会话目录里定位会话文件：优先压缩(.zstd)，同为压缩/明文时取版本号大的
function findSessionFile(sessionDir) {
  let names = []
  try { names = fs.readdirSync(sessionDir) } catch { return null }
  const matched = names.filter(n => SESSION_FILE_RE.test(n)).sort((a, b) => {
    const az = /\.zstd$/i.test(a) ? 1 : 0
    const bz = /\.zstd$/i.test(b) ? 1 : 0
    if (az !== bz) return bz - az
    return sessionFileRank(b) - sessionFileRank(a) || a.localeCompare(b)
  })
  return matched.length ? path.join(sessionDir, matched[0]) : null
}

// 扫描一个 DSH_HOME 的会话目录，只列文件信息（不读内容），按创建时间倒序。
// 目录结构：<home>/sessions/<workspace-hash>/<sessionId>/session[.vN].jsonl(.zstd)，兼容无 hash 层。
// 返回 [{ sid, file, fileSize, fileMtime }]（最多 limit 个）。
// 供增量 worker 先对比文件变化再决定是否解压（避免每轮全量解压所有会话）。
function listSessionFiles(home, limit = 50) {
  const dir = path.join(home, 'sessions')
  if (!fs.existsSync(dir)) return []
  const results = []
  const consider = (sessionDir, sid) => {
    const f = findSessionFile(sessionDir)
    if (!f) return
    let st
    try { st = fs.statSync(f) } catch { return }
    results.push({ sid, file: f, fileSize: st.size, fileMtime: st.mtimeMs })
  }
  let entries
  try { entries = fs.readdirSync(dir) } catch { return [] }
  for (const entry of entries) {
    const full = path.join(dir, entry)
    let st
    try { st = fs.statSync(full) } catch { continue }
    if (!st.isDirectory()) continue
    // 两层结构：<hash>/<sessionId>/；单层：<sessionId>/
    let sub
    try { sub = fs.readdirSync(full) } catch { continue }
    if (sub.some(s => findSessionFile(path.join(full, s)))) {
      for (const sid of sub) consider(path.join(full, sid), sid)
    } else {
      consider(full, entry)
    }
  }
  // 文件 mtime 近似创建时间（会话文件只增不改），按修改时间倒序，活跃的排前面
  results.sort((a, b) => (b.fileMtime || 0) - (a.fileMtime || 0))
  return results.slice(0, limit)
}

// 读取一个 DSH_HOME 的会话活动列表（按创建时间倒序，默认最多 20 个）。全量读取，供列表展示。
function readSessions(home, limit = 20) {
  const files = listSessionFiles(home, Math.max(limit, 50))
  const results = []
  for (const f of files) {
    const ex = extractSession(f.file)
    if (!ex) continue
    results.push({
      id: f.sid,
      createdAt: (ex.header && ex.header.createdAt) || f.fileMtime || 0,
      cwd: (ex.header && ex.header.cwd) || '',
      title: ex.title || f.sid,
      tools: ex.tools,
      events: ex.events || [],
      fileSize: f.fileSize,
      fileMtime: f.fileMtime,
    })
  }
  results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return results.slice(0, limit)
}

module.exports = { readSessions, extractSession, listSessionFiles, findSessionFile, summarizeArgs, summarizeEvent, summarizeMessage }
