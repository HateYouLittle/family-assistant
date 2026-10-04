/**
 * 极小的 HTML 组装件。设计 §9:服务端模板字符串渲染,**不引前端框架**。
 *
 * ## 为什么这个文件存在
 * 页面上的每一个动态值(标题、备注、地点、金额、成员名、日期)都来自家人在对话里
 * 说的自由文本 —— 也就是说**它可能是 `<script>alert(1)</script>`**。
 * 所以转义必须是**一个不可绕过的函数**,而不是"记得在拼接时手写 &lt;":
 * 这里只有一个出口 `h()`,页面里凡是要塞进 HTML 的动态串都必须过它。
 *
 * 转义表覆盖 5 个字符(而不是只做 `<`):文本节点里 `<`/`&` 必需,
 * 而 `>` 挡住 `]]>`/`-->` 之类的边界闭合,`"` 与 `'` 挡住属性值里的引号逃逸
 * (将来某个模板不小心把用户串放进属性值时,不至于当场变成注入)。
 */

/** 转义映射。顺序无关(逐字符替换)。 */
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * HTML 转义。**所有**拼进 HTML 的动态值都要过这里。
 * 不用正则替换表是刻意的:逐字符查表不会漏掉"某个字符只匹配一次"的边界情况。
 */
export function h(value: string): string {
  let out = "";
  for (const ch of value) out += HTML_ESCAPES[ch] ?? ch;
  return out;
}

/**
 * URL 参数编码。用于 `?ledger=personal` 这类链接 —— 参数值同样来自用户输入
 * (月份、成员名),不编码就等于把引号和 `&` 拼进 href(属性注入的另一条路)。
 */
export function urlParam(name: string, value: string): string {
  return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
}

/** 拼一个站内查询串(自动带 `?`)。`params` 为空时返回空串。 */
export function query(params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(urlParam(name, value));
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** 内联样式。零依赖、零请求:页面不加载任何外部资源(局域网里也不该有 CDN 这回事)。 */
const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
         margin: 0; padding: 0 0 3rem; line-height: 1.6; }
  header { padding: 1rem 1rem .5rem; border-bottom: 1px solid #8884; }
  nav a { margin-right: 1rem; }
  main { padding: 1rem; max-width: 46rem; }
  h1 { font-size: 1.25rem; margin: .2rem 0; }
  h2 { font-size: 1.05rem; margin: 1.4rem 0 .5rem; }
  ul { padding-left: 1.2rem; }
  li { margin: .35rem 0; }
  .meta { opacity: .75; font-size: .85em; }
  .empty { opacity: .7; font-style: italic; }
  .notice { background: #fde68a; color: #111; padding: .6rem .8rem; border-radius: .4rem; margin: .6rem 0; }
  .denied { background: #fecaca; color: #111; padding: .6rem .8rem; border-radius: .4rem; margin: .6rem 0; }
  form { margin: 0; }
  input, select, button { font: inherit; padding: .35rem .5rem; }
  button { cursor: pointer; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; }
  th, td { text-align: left; padding: .3rem .4rem; border-bottom: 1px solid #8883; vertical-align: top; }
  .amount { white-space: nowrap; }
  .tabs a { display: inline-block; padding: .25rem .6rem; border: 1px solid #8886; border-radius: .3rem;
            margin-right: .4rem; text-decoration: none; }
  .tabs a.on { background: #8883; }
  footer { padding: 0 1rem; opacity: .6; font-size: .8em; }
`;

/**
 * 页面骨架。`content` 由各页面自己拼好(已转义),这里只负责文档外壳与导航。
 *
 * `viewer` 为 null 表示未登录(登录页):此时不渲染导航(导航里的链接会立刻 302 回来,没意义)。
 */
export function layout(args: { title: string; viewer: { memberName: string } | null; content: string }): string {
  const nav =
    args.viewer === null
      ? ""
      : `<nav>
      <a href="/todos">待办</a>
      <a href="/calendar">日程</a>
      <a href="/ledger">账本</a>
      <span class="meta">当前:${h(args.viewer.memberName)}</span>
      <form method="post" action="/logout" style="display:inline">
        <button type="submit">退出登录</button>
      </form>
    </nav>`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(args.title)} · 家庭助手</title>
<style>${STYLE}</style>
</head>
<body>
<header>${nav}</header>
<main>
${args.content}
</main>
<footer>本页只读:一切写操作走对话(设计方案 §6)。局域网内没有 HTTPS,口令以明文经过 Wi-Fi —— 这是家庭自托管的已知代价(R9)。</footer>
</body>
</html>`;
}

/** `Content-Type: text/html; charset=utf-8`(所有页面同一形状;转义再严格,编码错了照样是乱码)。 */
export const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
