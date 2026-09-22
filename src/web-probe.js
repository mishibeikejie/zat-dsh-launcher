/* 客户端模块清单解析（版本差异集中在这里，便于单测）。
 *
 * 页面 HTML 里的客户端模块清单形态随 DSH 版本变化：
 *  - 0.1.5：<link rel="preload" href="/plugins/??a/client.js,b/client.js&rev=...">
 *           —— href 属性 + 绝对路径
 *  - 0.1.7：<script src="plugins/??a/client.js,b/client.js&rev=...">
 *           —— src 属性 + 相对路径（页面带 <base href="./">），且同一页里有 3 处
 *           清单（完整 58 条 / 子包 4 条 / 引导 1 条）
 * 只认 href + 绝对路径时，0.1.7 上一处都匹配不到 → 探测静默失效（永远判健康）；
 * 只取第一处又会把子集当全集 → 误报缺模块。所以：两种属性、两种路径都认，
 * 并在多处清单里取条目最多的那一处（= 完整清单，与顺序无关）。
 */

// 从一段 HTML 里解析客户端模块清单。
// 返回 { pluginPath, moduleIds }；页面里没有清单时 pluginPath 为空串、moduleIds 为空 Set。
function parsePluginManifest(html) {
  const text = String(html || '')
  const re = /(?:href|src)="([^"]*plugins\/\?\?[^"]+)"/g
  let best = { pluginPath: '', moduleIds: new Set() }
  let m
  while ((m = re.exec(text))) {
    const pluginPath = m[1].replace(/&amp;/g, '&')
    const listPart = pluginPath.split('??')[1] || ''
    let ids = []
    try {
      ids = decodeURIComponent(listPart.split('&')[0])
        .split(',').map(s => s.replace(/\/client\.js.*$/i, '').trim()).filter(Boolean)
    } catch { continue } // 单个清单解码失败不影响其它清单
    if (ids.length > best.moduleIds.size) best = { pluginPath, moduleIds: new Set(ids) }
  }
  return best
}

module.exports = { parsePluginManifest }
