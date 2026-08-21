import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";
import path from "node:path";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));

async function readAllSources() {
  const files = [
    "manifest.json",
    "background.js",
    "content.js",
    "deepseek-api.js",
    "options.html",
    "options.js",
    "options.css",
    "sidepanel.html",
    "sidepanel.js",
    "sidepanel.css",
    "capture-overlay.js"
  ];
  return Promise.all(files.map(async (f) => ({
    name: f,
    text: await readFile(new URL(f, root), "utf8")
  })));
}

/** 按花括号配平从源码提取自包含函数（用于执行 renderMarkdown 回归测试） */
function extractFunction(src, name) {
  const marker = "function " + name + "(";
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `function ${name} must exist`);
  const brace = src.indexOf("{", start);
  let depth = 0;
  let i = brace;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

test("manifest declares the cysider contract", () => {
  assert.equal(manifest.name, "cysider");
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.background.service_worker, "background.js");
  assert.ok(!manifest.permissions.includes("declarativeNetRequest"), "must not request DNR");
  assert.ok(!manifest.host_permissions.includes("<all_urls>"), "must not request <all_urls>");
  assert.equal(manifest.update_url, undefined);
  assert.equal(manifest.key, undefined);
  assert.match(manifest.content_security_policy.extension_pages, /wasm-unsafe-eval/);
  assert.match(manifest.content_security_policy.extension_pages, /worker-src 'self'/);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.equal(manifest.options_ui.page, "options.html");
  assert.ok(manifest.permissions.includes("contextMenus"));
  assert.ok(manifest.permissions.includes("scripting"));
});

test("no Alibaba / third-party tracking references anywhere", async () => {
  const forbidden = [
    "qianwen", "Qianwen", "QWEN", "Qwen",
    "dashscope", "aliyuncs", "alibaba", "tongyi",
    "redream", "feishuhub", "qcloud", "curl.qcloud",
    "千问", "通义"
  ];
  for (const { name, text } of await readAllSources()) {
    for (const token of forbidden) {
      assert.ok(!text.includes(token), `${name} must not contain "${token}"`);
    }
  }
});

test("the only external endpoint is the user-configured DeepSeek API", async () => {
  const { text } = (await readAllSources()).find((s) => s.name === "deepseek-api.js");
  assert.ok(text.includes("https://api.deepseek.com/chat/completions"));
  // 全库扫描：除默认 DeepSeek 端点外不得出现其他 http(s) 字面量
  for (const { name, text: src } of await readAllSources()) {
    if (name === "manifest.json") continue; // host_permissions 通配符不是外链
    const urls = [...src.matchAll(/https?:\/\/[^"'\s)]+/g)].map((m) => m[0]);
    for (const url of urls) {
      assert.ok(
        url.startsWith("https://api.deepseek.com") || url.startsWith("http://www.w3.org"),
        `${name} contains unexpected URL: ${url}`
      );
    }
  }
});

test("storage keys and message actions use the cysider prefix", async () => {
  const { text: bg } = (await readAllSources()).find((s) => s.name === "background.js");
  const { text: panel } = (await readAllSources()).find((s) => s.name === "sidepanel.js");
  const { text: api } = (await readAllSources()).find((s) => s.name === "deepseek-api.js");
  const { text: overlay } = (await readAllSources()).find((s) => s.name === "capture-overlay.js");
  assert.ok(api.includes("cysiderConfig"));
  assert.ok(bg.includes("cysiderMenus"));
  assert.ok(panel.includes("cysiderOcrCapture"));
  assert.ok(panel.includes("cysiderChatHistory"));
  assert.ok(bg.includes("cysider_prompt"));
  assert.ok(bg.includes("CYSIDER_OCR_REGION"));
  assert.ok(overlay.includes("CYSIDER_OCR_REGION"));
  assert.ok(overlay.includes("cysider-ocr-capture-layer"));
});

test("side panel supports multi-session and streaming perf", async () => {
  const { text: panel } = (await readAllSources()).find((s) => s.name === "sidepanel.js");
  const { text: html } = (await readAllSources()).find((s) => s.name === "sidepanel.html");
  const { text: api } = (await readAllSources()).find((s) => s.name === "deepseek-api.js");
  const { text: bg } = (await readAllSources()).find((s) => s.name === "background.js");
  // 多会话：新聊天 / 历史 / 旧数据迁移
  assert.ok(panel.includes("cysiderSessions"));
  assert.ok(panel.includes("cysiderActiveSessionId"));
  assert.ok(panel.includes("LEGACY_HISTORY_KEY"));
  assert.ok(html.includes("newBtn"));
  assert.ok(html.includes("historyBtn"));
  assert.ok(html.includes("historyPanel"));
  // 上下文窗口：防无限增长
  assert.ok(panel.includes("CTX_WINDOW"));
  assert.ok(panel.includes("slice(-CTX_WINDOW)"));
  // 流式性能：按帧节流渲染
  assert.ok(panel.includes("requestAnimationFrame"));
  // 回答不自动折叠（仅思考过程折叠）：不再出现 maybeCollapse / expand-btn
  assert.ok(!panel.includes("maybeCollapse"), "long answers must not be auto-collapsed");
  assert.ok(!panel.includes("expand-btn"), "no expand button for answers");
  // 点击工具栏图标打开侧边栏兜底（Chrome 114/115）
  assert.ok(bg.includes("setPanelBehavior"));
});

test("side panel uses the bundled LXGW WenKai font for messages", async () => {
  const { text: css } = (await readAllSources()).find((s) => s.name === "sidepanel.css");
  const { text: panel } = (await readAllSources()).find((s) => s.name === "sidepanel.js");
  // 消息区/输入框字体栈必须以霞鹜文楷开头，且不能退回到纯系统字体
  assert.match(css, /\.messages, \.msg, \.markdown-body, #input \{\s*\n\s*font-family: "LXGW WenKai"/);
  assert.ok(!css.includes(".expand-btn"), "collapsed-answer styles must be removed");
  // 思考过程折叠块仍保留
  assert.ok(panel.includes("makeReasoningBlock"), "thinking fold must remain");
});

test("DeepSeek module uses current V4 models and thinking switch", async () => {
  const { text } = (await readAllSources()).find((s) => s.name === "deepseek-api.js");
  const { text: opts } = (await readAllSources()).find((s) => s.name === "options.html");
  const { text: panel } = (await readAllSources()).find((s) => s.name === "sidepanel.js");
  assert.ok(text.includes("deepseek-v4-flash"), "default model must be v4-flash");
  assert.ok(text.includes("deepseek-v4-pro"), "v4-pro must be listed");
  assert.ok(!/deepseek-(chat|reasoner)["']/.test(text), "deprecated model names must not be used");
  assert.ok(text.includes('thinking: { type: cfg.thinking ? "enabled" : "disabled" }'));
  assert.ok(text.includes("reasoning_effort"));
  assert.ok(opts.includes('value="deepseek-v4-flash"'));
  assert.ok(panel.includes("toggleThinking"));
  assert.ok(panel.includes("thinkBtn"));
  assert.ok(panel.includes("toggleModel"), "model tag must be clickable to switch models");
});

test("thinking is separated from the answer and replies default to Chinese", async () => {
  const { text: api } = (await readAllSources()).find((s) => s.name === "deepseek-api.js");
  const { text: panel } = (await readAllSources()).find((s) => s.name === "sidepanel.js");
  const { text: css } = (await readAllSources()).find((s) => s.name === "sidepanel.css");
  // 思考与正文分离：禁止把 reasoning_content 拼进正文
  assert.ok(!api.includes("delta.content || delta.reasoning_content"), "reasoning must not be concatenated into the answer");
  assert.ok(api.includes("onReasoning"), "chat must expose an onReasoning callback");
  assert.ok(api.includes("contentPiece"), "stream must extract content piece separately");
  assert.ok(api.includes("reasoningPiece"), "stream must extract reasoning piece separately");
  // 默认中文回复系统提示
  assert.ok(panel.includes("CHAT_SYSTEM"), "chat must inject a default system prompt");
  assert.ok(panel.includes("默认使用中文"), "system prompt must default to Chinese");
  // 思考折叠展示
  assert.ok(panel.includes("makeReasoningBlock"), "panel must build a collapsible reasoning block");
  assert.ok(panel.includes("reasoning-body"), "panel must render the reasoning body");
  assert.ok(panel.includes("m.reasoning"), "history rebuild must carry stored reasoning");
  assert.ok(css.includes(".reasoning-body"), "css must style the reasoning body");
});

test("markdown table rows must not infinite-loop (Invalid array length regression)", async () => {
  const { text } = (await readAllSources()).find((s) => s.name === "sidepanel.js");
  // 表格收集循环必须推进 i：缺失 i++ 会在遇到表格回答时死循环塞同一行，
  // 直至内存爆掉抛 RangeError: Invalid array length（表现为"发送失败"）
  assert.match(text, /while \(i < lines\.length && lines\[i\]\.trim\(\)\.includes\("\|"\)\) \{\s*\n\s*rows\.push\(lines\[i\]\.trim\(\)\);\s*\n\s*i\+\+;/);
  assert.ok(!text.includes(") rows.push(lines[i].trim());"), "table row loop body must include i++");
});

test("renderMarkdown renders markdown and survives hostile input", async () => {
  const { text } = (await readAllSources()).find((s) => s.name === "sidepanel.js");
  const code = [
    extractFunction(text, "escapeHtml"),
    extractFunction(text, "inlineMarkdown"),
    extractFunction(text, "renderMarkdown")
  ].join("\n");
  const { renderMarkdown } = new Function(code + "\n;return { renderMarkdown };")();

  // 正常内容：标题/表格/加粗全部渲染，无原始 Markdown 残片
  const content = `## 先厘清两个概念

### 插件（Plugin）

这是**加粗**。

| 列A | 列B |
|---|---|
| 1 | 2 |`;
  const out = renderMarkdown(content);
  assert.ok(out.includes("<h2>"), "h2 must render");
  assert.ok(out.includes("<h3>"), "h3 must render");
  assert.ok(out.includes("<table>"), "table must render");
  assert.ok(out.includes("<strong>"), "bold must render");
  assert.ok(!out.includes("##"), "no raw heading residue");
  assert.ok(!out.includes("| 列A"), "no raw table residue");

  // 整段被 ```markdown 围栏包裹 → 解包渲染，而不是按代码块原样显示
  const fenced = "```markdown\n" + content + "\n```";
  const fencedOut = renderMarkdown(fenced);
  assert.ok(fencedOut.includes("<h2>"), "fenced markdown must be unwrapped");
  assert.ok(!fencedOut.includes("<pre>"), "fenced markdown must not render as a code block");

  // 字面 \n 转义（全文无真实换行）→ 归一化后正常渲染
  const escaped = content.replace(/\n/g, "\\n");
  const escapedOut = renderMarkdown(escaped);
  assert.ok(escapedOut.includes("<h2>"), "escaped newlines must be normalized");

  // 混合换行（少量真实换行 + 字面 \n 占主导）→ 同样归一化，不再挤成一行的原始格式
  const mixed = "开头真实换行段。\n\n\\n\\n---\\n\\n## 混合标题\\n\\n结尾段。";
  const mixedOut = renderMarkdown(mixed);
  assert.ok(mixedOut.includes("<h2>"), "mixed escaped newlines must be normalized");
  assert.ok(mixedOut.includes("<hr>"), "mixed content must render the hr");
  assert.ok(!mixedOut.includes("##"), "no raw heading residue in mixed content");

  // \r-only 行尾（旧 Mac 风格，只有回车没有换行）→ 归一化后正常渲染
  const crOnly = "开头段。\r\r---\r\r## 标题\r\r- 项1\r- 项2";
  const crOut = renderMarkdown(crOnly);
  assert.ok(crOut.includes("<h2>"), "carriage-return-only content must be normalized");
  assert.ok(crOut.includes("<hr>"), "cr-only content must render the hr");
  assert.ok(crOut.includes("<ul>"), "cr-only content must render the list");
  assert.ok(!crOut.includes("---"), "no raw hr residue in cr-only content");

  // 真实换行占主导 + 代码示例里的字面 \n → 必须保留（保护本意的转义字符串）
  const codeSample = "第一行真实换行。\n第二行真实换行。\n\n```js\nconsole.log(\"a\\nb\");\n```";
  const codeSampleOut = renderMarkdown(codeSample);
  assert.ok(codeSampleOut.includes("\\n"), "literal \\n inside real code must be preserved");

  // 带明确代码语言的整体围栏 → 保持代码块，不解包
  const js = "```js\nconst a = 1;\n```";
  assert.ok(renderMarkdown(js).includes("<pre>"), "real code fence stays a code block");

  // 永不抛异常（含过往触发 RangeError 的畸形输入）
  assert.doesNotThrow(() => renderMarkdown("**".repeat(100000)));
  assert.doesNotThrow(() => renderMarkdown("[".repeat(100000)));
  assert.doesNotThrow(() => renderMarkdown("| ".repeat(100000)));
});

test("side panel OCR stays fully local", async () => {
  const { text } = (await readAllSources()).find((s) => s.name === "sidepanel.js");
  assert.match(text, /workerBlobURL:\s*false/);
  assert.match(text, /vendor\/tesseract\/worker\.min\.js/);
  assert.match(text, /vendor\/tesseract-core\//);
  assert.match(text, /vendor\/lang-data\//);
  assert.ok(!text.includes("fetch("), "OCR must not fetch anything");
});

test("all required assets exist", async () => {
  const required = [
    "background.js", "content.js", "deepseek-api.js",
    "capture-overlay.js",
    "options.html", "options.js", "options.css",
    "sidepanel.html", "sidepanel.js", "sidepanel.css",
    "icon-16.png", "icon-34.png", "icon-48.png", "icon-128.png",
    "vendor/tesseract/tesseract.min.js",
    "vendor/tesseract/worker.min.js",
    "vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js",
    "vendor/lang-data/eng.traineddata.gz",
    "vendor/lang-data/chi_sim.traineddata.gz",
    "vendor/fonts/lxgw-wenkai.css",
    "vendor/fonts/lxgwwenkai-regular-subset-4.woff2",
    "vendor/fonts/lxgwwenkai-bold-subset-4.woff2"
  ];
  for (const relativePath of required) {
    const url = new URL(relativePath, root);
    await access(url);
    assert.ok((await stat(url)).size > 0, `${relativePath} should not be empty`);
  }
});

test("no leftover original bundles or boilerplate pages", async () => {
  const files = await readdir(root);
  for (const f of files) {
    assert.ok(!/\.bundle\.js$/.test(f), `bundle file must be removed: ${f}`);
    assert.ok(!["newtab.html", "popup.html", "panel.html", "devtools.html"].includes(f), `boilerplate page must be removed: ${f}`);
  }
});

test("selection overlay keeps square-cornered capture", async () => {
  const { text } = (await readAllSources()).find((s) => s.name === "capture-overlay.js");
  assert.match(text, /borderRadius:\s*"0"/);
  assert.match(text, /viewportWidth:\s*window\.innerWidth/);
});
