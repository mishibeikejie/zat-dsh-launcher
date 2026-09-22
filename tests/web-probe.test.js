/* 客户端模块清单解析回归（1.6.0）
 *
 * 实机夹具：0.1.5 页面是 href="/plugins/??…"（绝对路径），0.1.7 页面是
 * src="plugins/??…"（相对路径 + 同页 3 处清单）。旧解析只认前者，
 * 在 0.1.7 上一处都匹配不到 → 探测静默失效（永远判健康）。
 */
const test = require('node:test')
const assert = require('node:assert')

const { parsePluginManifest } = require('../src/web-probe')

// 0.1.5 形态：href + 绝对路径，页面只有一处清单
const PAGE_015 = `<!doctype html><html><head>
<link rel="preload" as="script" href="/plugins/??@deepseek-ai/dsh-client-connection/client.js,@deepseek-ai/dsh-client-runtime/client.js,zat-dsh-engine/client.js&amp;rev=abc123">
</head><body></body></html>`

// 0.1.7 形态（实测截取）：src + 相对路径，同页 3 处清单，
// 第一处 58 条（完整）、第二处 4 条（子包）、第三处 1 条（引导）
const PAGE_017 = `<!doctype html><html><head><base href="./">
<script src="plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=d57a8fd4eb21"></script>
<link rel="preload" as="script" href="plugins/??@deepseek-ai/dsh-client-connection/client.js,@deepseek-ai/dsh-client-locale/client.js,@deepseek-ai/dsh-client-runtime/client.js,zat-dsh-engine/client.js&amp;rev=2b4dfdbadb28">
<script src="plugins/??@deepseek-ai/dsh-client-ui-deliverables/client.js,@deepseek-ai/dsh-session-log-export/client.js,zat-dsh-engine/client.js,@deepseek-ai/dsh-typert-registry/client.js&amp;rev=5da7cd336fd5"></script>
</head><body></body></html>`

test('0.1.5 页面：href + 绝对路径仍能解析（不回归）', () => {
  const { pluginPath, moduleIds } = parsePluginManifest(PAGE_015)
  assert.equal(pluginPath.startsWith('/plugins/??'), true)
  assert.equal(moduleIds.size, 3)
  assert.equal(moduleIds.has('zat-dsh-engine'), true)
})

test('0.1.7 页面：src + 相对路径能解析（旧解析此处为空）', () => {
  const { pluginPath, moduleIds } = parsePluginManifest(PAGE_017)
  assert.notEqual(pluginPath, '', '旧解析在 0.1.7 页面上匹配不到任何清单')
  assert.equal(moduleIds.size, 4)
  assert.equal(moduleIds.has('zat-dsh-engine'), true)
})

test('多处清单取条目最多的那一处（避免把子集当全集造成误报）', () => {
  // 把完整清单放在文档最后：取“第一处”会拿到 1 条子集的旧行为，取“最多”才拿到 4 条
  const reordered = `<html><head>
<script src="plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=x"></script>
<script src="plugins/??a/client.js,b/client.js,c/client.js,d/client.js&amp;rev=y"></script>
</head></html>`
  const { moduleIds } = parsePluginManifest(reordered)
  assert.deepEqual([...moduleIds].sort(), ['a', 'b', 'c', 'd'])
})

test('页面没有清单时返回空（探测按“无清单”处理，不误报缺失）', () => {
  const { pluginPath, moduleIds } = parsePluginManifest('<html><body>dsh web authentication required</body></html>')
  assert.equal(pluginPath, '')
  assert.equal(moduleIds.size, 0)
})

test('畸形 URL 编码的清单被跳过，不影响其它清单', () => {
  const mixed = `<html><head>
<script src="plugins/??%E0%A4%A/client.js&amp;rev=x"></script>
<script src="plugins/??good-a/client.js,good-b/client.js&amp;rev=y"></script>
</head></html>`
  const { moduleIds } = parsePluginManifest(mixed)
  assert.deepEqual([...moduleIds].sort(), ['good-a', 'good-b'])
})

test('client.js 后缀与 rev 参数都被剥掉，模块名是包名', () => {
  const { moduleIds } = parsePluginManifest(
    '<html><head><script src="plugins/??@deepseek-ai/dsh-client-ui-chat/client.js&amp;rev=zzz"></script></head></html>'
  )
  assert.deepEqual([...moduleIds], ['@deepseek-ai/dsh-client-ui-chat'])
})
