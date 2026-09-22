'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { zstdCompressSync } = require('node:zlib')
const { readSessions, extractSession, summarizeArgs, summarizeMessage, listSessionFiles, findSessionFile } = require('../src/session-activity')
function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zat-sess-${label}-`))
}

function writeZstdSession(file, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const frames = events.map(ev => zstdCompressSync(Buffer.from(JSON.stringify(ev), 'utf8')))
  fs.writeFileSync(file, Buffer.concat(frames))
}

// DSH 批量 flush 时一帧包含多行 JSONL。回归测试（0.6.19）：
// 旧实现把整帧文本当单行 JSON.parse，多行帧整体失败 → 用户消息/助手完整消息随机消失。
function writeZstdSessionWithMultiLineFrames(file, framesOfLines) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const frames = framesOfLines.map(lines =>
    zstdCompressSync(Buffer.from(lines.map(l => JSON.stringify(l)).join('\n'), 'utf8')))
  fs.writeFileSync(file, Buffer.concat(frames))
}

test('extractSession parses multi-line frames (DSH batch flush) without losing events', () => {
  const dir = tmpDir('multiline')
  try {
    const file = path.join(dir, 'session.jsonl.zstd')
    // 帧1：单行（end-seed 单独 flush）；帧2：批量帧，含用户消息+完整助手消息+结束标记
    writeZstdSessionWithMultiLineFrames(file, [
      [{ type: 'session/end-seed', seq: 1, time: 1000, data: {} }],
      [
        { type: 'agent/inbox/spliced', seq: 2, time: 1001, data: { target: 'next-turn', start: 0, inserted: [{ content: [{ type: 'text', text: '你随便说上两句话' }], role: 'user', id: 'u-1' }] } },
        { type: 'turn/start', seq: 3, time: 1002, data: { turn: 1 } },
        { type: 'text-chunks', seq0: 4, time0: 1003, data: { turn: 1, step: 1, index: 0, dt: [], texts: ['好'] } },
        { type: 'assistant/chunk', seq: 5, time: 1004, data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: '好' } } } },
        { type: 'assistant/message', seq: 6, time: 1005, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好,那就随便聊两句' }] } } },
        { type: 'step/end', seq: 7, time: 1006, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 8, time: 1007, data: { turn: 1 } },
      ],
    ])
    const ex = extractSession(file)
    assert.ok(ex)
    const summaries = ex.events.map(e => e.summary).join('|')
    // 用户消息来自批量帧里的 spliced（旧实现整帧解析失败会丢）
    assert.ok(summaries.includes('用户：你随便说上两句话'), `缺用户消息: ${summaries}`)
    // 助手完整消息来自 assistant/message（旧实现无此事件类型处理）
    assert.ok(summaries.includes('助手：好,那就随便聊两句'), `缺助手完整消息: ${summaries}`)
    // 碎片聚合不重复推送同一回复（asmSteps 让位）
    assert.ok(!summaries.includes('助手：好|助手：'), `碎片与完整消息重复: ${summaries}`)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('extractSession parses title and tool calls from zstd frames', () => {
  const dir = tmpDir('ext')
  try {
    const file = path.join(dir, 'session.jsonl.zstd')
    writeZstdSession(file, [
      { type: 'session', id: 's1', createdAt: 1000, cwd: 'C:\\work' },
      { type: 'session/title', data: { title: '检查插件' } },
      { type: 'tool/call', time: 1100, data: { name: 'web_search', arguments: JSON.stringify({ query: 'DeepSeek' }) } },
      { type: 'tool/call', time: 1200, data: { name: 'pwsh', arguments: JSON.stringify({ command: 'Get-Process' }) } },
      { type: 'tool/call', time: 1300, data: { name: 'read', arguments: JSON.stringify({ file_path: 'C:\\a.txt' }) } },
      { type: 'reasoning-chunks' },
    ])
    const ex = extractSession(file)
    assert.ok(ex)
    assert.equal(ex.title, '检查插件')
    assert.equal(ex.tools.length, 3)
    assert.equal(ex.tools[0].summary, '搜索「DeepSeek」')
    assert.ok(ex.tools[1].summary.includes('Get-Process'))
    assert.equal(ex.tools[2].summary, '读取文件 C:\\a.txt')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('readSessions scans hash-nested session dirs and sorts by time desc', () => {
  const dir = tmpDir('scan')
  try {
    const home = path.join(dir, 'home')
    writeZstdSession(path.join(home, 'sessions', '--hash--', 's-old', 'session.jsonl.zstd'), [
      { type: 'session', id: 's-old', createdAt: 100 },
      { type: 'session/title', data: { title: '旧会话' } },
    ])
    writeZstdSession(path.join(home, 'sessions', '--hash--', 's-new', 'session.jsonl.zstd'), [
      { type: 'session', id: 's-new', createdAt: 200 },
      { type: 'session/title', data: { title: '新会话' } },
      { type: 'tool/call', data: { name: 'glob', arguments: JSON.stringify({ pattern: '**/*.js' }) } },
    ])
    const sessions = readSessions(home)
    assert.equal(sessions.length, 2)
    assert.equal(sessions[0].id, 's-new')
    assert.equal(sessions[0].title, '新会话')
    assert.equal(sessions[0].tools[0].summary, '查找文件 **/*.js')
    assert.equal(sessions[1].id, 's-old')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('readSessions tolerates missing sessions dir and plain jsonl', () => {
  const dir = tmpDir('plain')
  try {
    const home = path.join(dir, 'home')
    fs.mkdirSync(path.join(home, 'sessions', '--h--', 's1'), { recursive: true })
    fs.writeFileSync(path.join(home, 'sessions', '--h--', 's1', 'session.jsonl'),
      '{"type":"session","id":"s1","createdAt":300,"cwd":"C:\\\\w"}\n{"type":"session/title","data":{"title":"明文会话"}}\n')
    const sessions = readSessions(home)
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].title, '明文会话')
    const none = readSessions(path.join(dir, 'nope'))
    assert.deepEqual(none, [])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('summarizeArgs covers common tools safely', () => {
  assert.equal(summarizeArgs('web_search', '{"query":"x"}'), '搜索「x」')
  assert.equal(summarizeArgs('edit', '{"file_path":"a"}'), '编辑文件 a')
  assert.equal(summarizeArgs('unknown', '{"x":1}'), 'unknown')
  assert.equal(summarizeArgs('web_search', 'not-json'), '联网搜索')
})

// 1.0.8 日志刷屏回归：长回复/多行命令必须摘要化（压换行 + 截断），运行日志不被全文刷屏。
test('summarizeMessage flattens newlines and truncates long text (1.0.8 刷屏回归)', () => {
  const long = `## 结论\n\n| 问题 | 状态 |\n|---|---|\n| 3 终端名悬停全名 | ✅ 已解决 |\n\n**修复方向**：摘要时先把所有空白（含换行）压成单个空格，再截断。`.repeat(3)
  const s = summarizeMessage(long)
  assert.ok(!s.includes('\n'), '换行必须被压平')
  assert.ok(s.length <= 123, `截断后长度超限: ${s.length}`)
  assert.ok(s.endsWith('…'), '长文本应带省略号')
  // 短消息保持原样
  assert.equal(summarizeMessage('请帮我检查配置'), '请帮我检查配置')
  // 多行 here-string 命令：压平后单行可读
  const cmd = summarizeMessage('$sig = @\nusing System;\npublic class A { }\n@\nAdd-Type $sig')
  assert.ok(!cmd.includes('\n'), '命令换行必须压平')
})

test('extractSession aggregates streamed text/tool chunks and user messages', () => {
  const dir = tmpDir('agg')
  try {
    const file = path.join(dir, 'session.jsonl.zstd')
    writeZstdSession(file, [
      { type: 'session', id: 's1', createdAt: 1000, cwd: 'C:\\work' },
      { type: 'step/start' },
      { type: 'reasoning-chunks', seq0: 1, time0: 1001, data: { texts: ['思考碎片'] } },
      // 流式工具调用碎片（拼成完整调用）
      { type: 'tool-call-chunks', seq0: 2, time0: 1002, data: { turn: 1, step: 1, id: 'call_1', name: 'web_search', args: ['{"query":"', 'DeepSeek', '"}'] } },
      // 助手文本碎片（聚合为完整消息）
      { type: 'text-chunks', seq0: 3, time0: 1003, data: { turn: 1, step: 2, texts: ['这是', '助手', '回复'] } },
      { type: 'text-chunks', seq0: 4, time0: 1004, data: { turn: 1, step: 2, texts: ['的完整', '内容'] } },
      // 完整用户消息插入
      { type: 'agent/inbox/spliced', seq: 5, time: 1005, data: { target: 'next-step', inserted: [{ role: 'user', id: 'msg-1', content: [{ type: 'text', text: '请帮我检查配置' }] }] } },
      // 块级完整工具调用
      { type: 'assistant/chunk', seq: 6, time: 1006, data: { chunk: { type: 'block-end', block: { type: 'tool-call', id: 'call_2', name: 'pwsh', arguments: '{"command":"Get-Process"}' } } } },
    ])
    const ex = extractSession(file)
    assert.ok(ex)
    const keys = ex.events.map(e => e.key)
    const summaries = ex.events.map(e => e.summary)
    // 碎片被聚合：没有单独的 chunk 噪音条目
    assert.ok(!summaries.some(s => s.includes('思考碎片')), 'reasoning-chunks 不应出现')
    assert.ok(summaries.some(s => s.startsWith('助手：') && s.includes('这是助手回复的完整内容')), '文本碎片应聚合为完整助手消息')
    assert.ok(summaries.some(s => s.includes('搜索「DeepSeek」')), '工具碎片应聚合出 web_search')
    assert.ok(summaries.some(s => s.startsWith('用户：请帮我检查配置')), 'spliced 用户消息应保留原文')
    assert.ok(summaries.some(s => s.includes('Get-Process')), 'block-end 工具调用应出现')
    // 每个事件都有稳定去重 key
    for (const k of keys) assert.ok(k && k.length > 2, `key 缺失: ${k}`)
    // 聚合事件的 key 跨轮询稳定（text|turn|step、tool|id、msg|id）
    assert.ok(keys.some(k => k === 'text|1|2'))
    assert.ok(keys.some(k => k === 'tool|call_1'))
    assert.ok(keys.some(k => k === 'msg|msg-1'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('extractSession keeps direct events and skips pure noise', () => {
  const dir = tmpDir('direct')
  try {
    const file = path.join(dir, 'session.jsonl.zstd')
    writeZstdSession(file, [
      { type: 'session', id: 's2', createdAt: 2000 },
      { type: 'session/title', data: { title: '修日志' } },
      { type: 'goal/change', seq: 1, time: 2001, data: { summary: '重写日志系统' } },
      { type: 'agent-preset/selected', seq: 2, time: 2002, data: { id: 'coder' } },
      { type: 'llm/retry-started', seq: 3, time: 2003, data: { retry: 2 } },
      { type: 'session/end-seed', seq: 4, time: 2004 },
      { type: 'step/start' }, { type: 'step/end' }, { type: 'turn/start' }, { type: 'turn/end' },
    ])
    const ex = extractSession(file)
    assert.ok(ex)
    const summaries = ex.events.map(e => e.summary).join('|')
    assert.ok(summaries.includes('目标变更：重写日志系统'))
    assert.ok(summaries.includes('选择预设：coder'))
    assert.ok(summaries.includes('LLM 重试（第 2 次）'))
    assert.ok(summaries.includes('对话已恢复（历史重新载入）'))
    assert.ok(summaries.includes('会话标题：修日志'))
    assert.ok(!summaries.includes('开始执行步骤') && !summaries.includes('步骤完成'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// 终端独立性核心保证（0.6.19 回归）：worker 按 DSH_HOME 隔离扫描，
// homeA 的会话事件绝不能出现在 homeB 的输出里，反之亦然。
test('worker output keeps every terminal home isolated (no cross-terminal mixing)', async () => {
  const dir = tmpDir('iso')
  try {
    const homeA = path.join(dir, 'homeA')
    const homeB = path.join(dir, 'homeB')
    writeZstdSessionWithMultiLineFrames(path.join(homeA, 'sessions', '--hashA--', 's-A1', 'session.jsonl.zstd'), [
      [{ type: 'session', id: 's-A1', createdAt: 1000 }],
      [
        { type: 'agent/inbox/spliced', seq: 1, time: 1001, data: { target: 'next-turn', inserted: [{ role: 'user', id: 'a-1', content: [{ type: 'text', text: '终端A的消息：你在终端A里说了什么' }] }] } },
        { type: 'assistant/message', seq: 2, time: 1002, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '终端A的助手回复' }] } } },
      ],
    ])
    writeZstdSessionWithMultiLineFrames(path.join(homeB, 'sessions', '--hashB--', 's-B1', 'session.jsonl.zstd'), [
      [{ type: 'session', id: 's-B1', createdAt: 2000 }],
      [
        { type: 'agent/inbox/spliced', seq: 1, time: 2001, data: { target: 'next-turn', inserted: [{ role: 'user', id: 'b-1', content: [{ type: 'text', text: '终端B的消息：完全不同的内容' }] }] } },
      ],
    ])
    // 用真实 worker 跑两个 home（同一进程同一轮）
    const { spawnSync } = require('node:child_process')
    const nodeExe = process.execPath
    const worker = path.join(__dirname, '..', 'scripts', 'session-tail.cjs')
    const r = spawnSync(nodeExe, [worker, homeA, homeB], { encoding: 'utf8', timeout: 30000 })
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    // 输出按 home 分区，且互不含对方内容
    assert.ok(out[homeA] && out[homeA]['s-A1'], 'homeA 应有 s-A1')
    assert.ok(out[homeB] && out[homeB]['s-B1'], 'homeB 应有 s-B1')
    assert.ok(!out[homeA]['s-B1'], 'homeA 输出混入了 homeB 的会话')
    assert.ok(!out[homeB]['s-A1'], 'homeB 输出混入了 homeA 的会话')
    const sumsA = out[homeA]['s-A1'].events.map(e => e.summary).join('|')
    const sumsB = out[homeB]['s-B1'].events.map(e => e.summary).join('|')
    assert.ok(sumsA.includes('终端A的消息'), `homeA 缺自己的消息: ${sumsA}`)
    assert.ok(sumsA.includes('终端A的助手回复'), `homeA 缺自己的助手回复: ${sumsA}`)
    assert.ok(sumsB.includes('终端B的消息'), `homeB 缺自己的消息: ${sumsB}`)
    assert.ok(!sumsA.includes('终端B'), 'homeA 混入了 homeB 的消息内容')
    assert.ok(!sumsB.includes('终端A'), 'homeB 混入了 homeA 的消息内容')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ★ 1.6.0：会话文件名随 DSH 版本变化（0.1.5 起 session.v3.jsonl.zstd，0.1.7 起 V4）。
// 旧实现硬编码 session.jsonl(.zstd)：实测本机 0.1.5 环境 110 个会话里
// 104 个 session.v3.jsonl.zstd + 4 个 session.v2.jsonl.zstd 全部读不到。
test('findSessionFile 认版本化文件名（session.v3/v4.jsonl.zstd）', () => {
  const dir = tmpDir('names')
  try {
    // 0.1.5 实际落盘名
    fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), 'x')
    assert.equal(path.basename(findSessionFile(dir)), 'session.v3.jsonl.zstd')

    // 0.1.7 的 V4 会话
    fs.rmSync(path.join(dir, 'session.v3.jsonl.zstd'))
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'x')
    assert.equal(path.basename(findSessionFile(dir)), 'session.v4.jsonl.zstd')

    // 明文 V4
    fs.rmSync(path.join(dir, 'session.v4.jsonl.zstd'))
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), 'x')
    assert.equal(path.basename(findSessionFile(dir)), 'session.v4.jsonl')

    // 老名字仍然认（不回归）
    fs.rmSync(path.join(dir, 'session.v4.jsonl'))
    fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), 'x')
    assert.equal(path.basename(findSessionFile(dir)), 'session.jsonl.zstd')

    // 无关文件不算会话
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    fs.rmSync(path.join(dir, 'session.jsonl.zstd'))
    assert.equal(findSessionFile(dir), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('同一目录多份会话文件：优先 .zstd，其次版本号大的', () => {
  const dir = tmpDir('prefer')
  try {
    // 明文 V4 与压缩 V3：压缩优先（真实环境同一会话只会有一种）
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), 'x')
    fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), 'x')
    assert.equal(path.basename(findSessionFile(dir)), 'session.v3.jsonl.zstd')

    // 同为压缩：V4 胜 V3
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'x')
    assert.equal(path.basename(findSessionFile(dir)), 'session.v4.jsonl.zstd')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('listSessionFiles 列出新版命名会话（两层与单层目录都认）', () => {
  const home = tmpDir('listnames')
  try {
    const two = path.join(home, 'sessions', '--hash--', 's-v3')
    const one = path.join(home, 'sessions', 's-v4')
    writeZstdSession(path.join(two, 'session.v3.jsonl.zstd'), [{ type: 'session', id: 's-v3', createdAt: 1000 }])
    writeZstdSession(path.join(one, 'session.v4.jsonl.zstd'), [{ type: 'session', id: 's-v4', createdAt: 2000 }])
    const files = listSessionFiles(home)
    assert.equal(files.length, 2, `应列出 2 个会话，实际 ${files.length}`)
    assert.deepEqual(files.map(f => f.sid).sort(), ['s-v3', 's-v4'])
    for (const f of files) assert.ok(f.fileSize > 0, '文件大小应可读')
    // 端到端：readSessions 能读到内容（旧实现此处返回空数组）
    const sessions = readSessions(home)
    assert.equal(sessions.length, 2)
    assert.deepEqual(sessions.map(s => s.id).sort(), ['s-v3', 's-v4'])
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
