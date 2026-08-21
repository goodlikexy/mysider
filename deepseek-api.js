/**
 * cysider · DeepSeek API 共享模块
 *
 * 纯本地实现：API Key 只保存在 chrome.storage.local，
 * 唯一网络请求发往用户自己配置的 DeepSeek API 地址（默认官方端点）。
 * 同时兼容 background service worker（importScripts）与 sidepanel/options 页面（<script>）。
 */
(() => {
  "use strict";

  const STORAGE_KEY = "cysiderConfig";
  const DEFAULT_URL = "https://api.deepseek.com/chat/completions";
  const DEFAULT_MODEL = "deepseek-v4-flash";
  // 官方模型列表（2026-07-24 起 deepseek-chat / deepseek-reasoner 已停止使用）
  const MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"];

  const DEFAULTS = Object.freeze({
    apiKey: "",
    apiUrl: DEFAULT_URL,
    model: DEFAULT_MODEL,
    temperature: 0.7,
    // 思考模式：官方默认开启；思考模式不支持 temperature
    thinking: true,
    effort: "high"
  });

  function storage() {
    if (globalThis.chrome && chrome.storage && chrome.storage.local) {
      return chrome.storage.local;
    }
    // 测试环境降级：内存存储
    const mem = {};
    return {
      async get(keys) {
        const out = {};
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) if (k in mem) out[k] = mem[k];
        return out;
      },
      async set(obj) { Object.assign(mem, obj); },
      async remove(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) delete mem[k];
      }
    };
  }

  function normalizeConfig(raw) {
    const cfg = Object.assign({}, DEFAULTS, raw || {});
    cfg.apiUrl = String(cfg.apiUrl || DEFAULT_URL).trim() || DEFAULT_URL;
    cfg.model = MODELS.includes(cfg.model) ? cfg.model : DEFAULT_MODEL;
    const t = Number(cfg.temperature);
    cfg.temperature = Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : 0.7;
    cfg.thinking = cfg.thinking !== false; // 默认开启
    cfg.effort = ["low", "high", "max"].includes(cfg.effort) ? cfg.effort : "high";
    return cfg;
  }

  async function getConfig() {
    const data = await storage().get(STORAGE_KEY);
    return normalizeConfig(data[STORAGE_KEY]);
  }

  async function saveConfig(patch) {
    const current = await getConfig();
    const next = normalizeConfig(Object.assign({}, current, patch || {}));
    await storage().set({ [STORAGE_KEY]: next });
    return next;
  }

  async function clearKey() {
    const current = await getConfig();
    await saveConfig({ apiKey: "" });
    return current.apiKey ? "已清除" : "没有已保存的 Key";
  }

  /**
   * 发送一次对话。
   * @param {Array<{role:string,content:string}>} messages
   * @param {{onDelta?: (text:string)=>void, onUsage?: (usage:object)=>void, signal?: AbortSignal}} options
   * @returns {Promise<string>} 完整回复文本
   */
  async function chat(messages, options = {}) {
    const cfg = await getConfig();
    if (!cfg.apiKey) {
      throw new Error("尚未配置 DeepSeek API Key，请先打开设置页配置（chrome-extension 内点设置 ⚙）。");
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("没有可发送的消息。");
    }

    const useStream = typeof options.onDelta === "function";
    const body = {
      model: cfg.model,
      messages: messages.map((m) => ({ role: m.role, content: String(m.content || "") })),
      stream: useStream,
      // 思考模式开关；思考模式下不支持 temperature
      thinking: { type: cfg.thinking ? "enabled" : "disabled" }
    };
    if (cfg.thinking) {
      body.reasoning_effort = cfg.effort;
    } else {
      body.temperature = cfg.temperature;
    }

    const resp = await fetch(cfg.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg.apiKey
      },
      body: JSON.stringify(body),
      signal: options.signal
    });

    if (!resp.ok) {
      let detail = "";
      try {
        const err = await resp.json();
        detail = (err && err.error && (err.error.message || err.error.code)) || "";
      } catch (e) { /* ignore */ }
      throw new Error("DeepSeek 接口错误 " + resp.status + (detail ? "：" + detail : ""));
    }

    if (!useStream) {
      const data = await resp.json();
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (typeof content !== "string") throw new Error("DeepSeek 返回内容为空。");
      if (typeof options.onUsage === "function" && data.usage) {
        options.onUsage(data.usage);
      }
      return content;
    }

    // SSE 流式解析（usage 出现在最后一个 chunk 中）
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let full = "";
    let usage = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload);
            if (obj.usage) usage = obj.usage;
            const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
            const piece = (delta && (delta.content || delta.reasoning_content)) || "";
            if (piece) {
              full += piece;
              options.onDelta(piece);
            }
          } catch (e) { /* 跳过无法解析的行 */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (usage && typeof options.onUsage === "function") {
      options.onUsage(usage);
    }
    return full;
  }

  /**
   * 测试连接：发一条极短的请求验证 Key 与地址可用。
   */
  async function testConnection() {
    const cfg = await getConfig();
    if (!cfg.apiKey) throw new Error("请先填写 API Key。");
    const reply = await chat(
      [{ role: "user", content: "ping" }],
      { signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined }
    );
    return reply || "连接成功（返回为空）";
  }

  const api = {
    STORAGE_KEY,
    DEFAULT_URL,
    DEFAULT_MODEL,
    MODELS,
    getConfig,
    saveConfig,
    clearKey,
    chat,
    testConnection
  };

  globalThis.CysiderDeepSeek = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
