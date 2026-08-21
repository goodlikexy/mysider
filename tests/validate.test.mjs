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

test("side panel supports multi-session, token stats and streaming perf", async () => {
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
  // Token 统计：本次 + 累计 + 缓存命中
  assert.ok(html.includes("tokenStat"));
  assert.ok(panel.includes("handleUsage"));
  assert.ok(panel.includes("prompt_cache_hit_tokens"));
  assert.ok(api.includes("onUsage"), "DeepSeek module must surface usage via onUsage callback");
  // 流式性能：按帧节流渲染
  assert.ok(panel.includes("requestAnimationFrame"));
  // 长回答折叠
  assert.ok(panel.includes("maybeCollapse"));
  assert.ok(panel.includes("expand-btn"));
  // 点击工具栏图标打开侧边栏兜底（Chrome 114/115）
  assert.ok(bg.includes("setPanelBehavior"));
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
