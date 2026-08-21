/**
 * cysider · 侧边栏主逻辑
 *
 * 功能：
 *  1. DeepSeek 流式聊天（API Key 读本地配置，请求仅发往 DeepSeek）
 *  2. 右键/划词消息（cysider_prompt）自动发送
 *  3. 网页框选截图 + 本地 Tesseract OCR，结果填入输入框
 *  4. 笔记精炼：最后一条回答 → DeepSeek 精炼 → 保存本地 .md
 *  5. 会话导出：一键保存 .md 到本地
 *  6. 多会话：新聊天 / 历史聊天切换 / 上下文自动截取最近 N 条
 *  7. Token 统计：输入/输出/缓存命中（本次 + 当前会话累计）
 *  8. 性能优化：流式按帧渲染、消息增量追加、延迟保存、智能滚动跟随
 * 无任何第三方网络请求。
 */
(() => {
  "use strict";

  const api = globalThis.CysiderDeepSeek;
  const SESSIONS_KEY = "cysiderSessions";
  const ACTIVE_KEY = "cysiderActiveSessionId";
  const LEGACY_HISTORY_KEY = "cysiderChatHistory";
  const CTX_WINDOW = 20;      // 发送给 API 的最近消息条数
  const MAX_SESSIONS = 20;    // 本地保留的最大会话数
  const COLLAPSE_LIMIT = 320; // 回答高度超过此值（px）自动折叠
  const NOTE_SYSTEM = "你是笔记整理助手。把用户提供的内容精炼成一份结构化中文笔记：保留关键结论、步骤、数据、代码示例；删除冗余和客套；用 Markdown 格式（标题、要点列表、代码块）；控制在 200-500 字。只输出笔记正文。";

  const state = {
    sessions: [],
    activeId: "",
    busy: false,
    controller: null,
    worker: null,
    workerLanguage: "",
    ocrBusy: false,
    lastCaptureId: "",
    statusTimer: null,
    // token 统计：本次 + 当前会话累计
    lastUsage: null,
    totalUsage: { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 }
  };

  let messagesEl, inputEl, sendBtn, statusEl, modelTag, sessionTitleEl,
      ocrBtn, noteBtn, thinkBtn, effortSel, exportBtn, clearBtn, settingsBtn,
      newBtn, historyBtn, historyPanel, historyList, historyCloseBtn, historyNewBtn,
      tokenStat;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheDom();
    bindEvents();
    loadSessions();
    renderAll();
    renderHistory();
    updateModelTag();
    updateThinkBtn();
    updateSessionTitle();
    chrome.runtime.sendMessage({ action: "cysider_ready" }).catch(() => {});
  }

  function cacheDom() {
    const $ = (id) => document.getElementById(id);
    messagesEl = $("messages");
    inputEl = $("input");
    sendBtn = $("sendBtn");
    statusEl = $("status");
    modelTag = $("modelTag");
    sessionTitleEl = $("sessionTitle");
    ocrBtn = $("ocrBtn");
    noteBtn = $("noteBtn");
    thinkBtn = $("thinkBtn");
    effortSel = $("effortSel");
    exportBtn = $("exportBtn");
    clearBtn = $("clearBtn");
    settingsBtn = $("settingsBtn");
    newBtn = $("newBtn");
    historyBtn = $("historyBtn");
    historyPanel = $("historyPanel");
    historyList = $("historyList");
    historyCloseBtn = $("historyCloseBtn");
    historyNewBtn = $("historyNewBtn");
    tokenStat = $("tokenStat");
  }

  function bindEvents() {
    sendBtn.addEventListener("click", () => {
      if (state.busy) {
        abortStream();
      } else {
        sendFromInput();
      }
    });
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendFromInput();
      }
    });
    inputEl.addEventListener("input", autoGrow);
    ocrBtn.addEventListener("click", beginCapture);
    noteBtn.addEventListener("click", onNoteClick);
    thinkBtn.addEventListener("click", toggleThinking);
    effortSel.addEventListener("change", onEffortChange);
    modelTag.addEventListener("click", toggleModel);
    exportBtn.addEventListener("click", saveExport);
    clearBtn.addEventListener("click", onClear);
    settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
    newBtn.addEventListener("click", onNewChat);
    historyBtn.addEventListener("click", () => { renderHistory(); historyPanel.hidden = false; });
    historyCloseBtn.addEventListener("click", () => { historyPanel.hidden = true; });
    historyNewBtn.addEventListener("click", () => { onNewChat(); historyPanel.hidden = true; });

    // 智能滚动跟随：用户向上翻阅历史时不要强制拉回底部，回到底部附近后恢复自动跟随
    messagesEl.addEventListener("scroll", () => {
      const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
      userScrolledUp = !nearBottom;
    }, { passive: true });

    chrome.runtime.onMessage.addListener((message) => {
      switch (message && message.action) {
        case "cysider_prompt":
          sendPrompt(message);
          break;
        case "CYSIDER_OCR_CAPTURE_READY":
          acceptCapture(message.capture);
          break;
        case "CYSIDER_OCR_CAPTURE_ERROR":
          finishOcrError(message.error?.message || "截图失败");
          break;
        case "CYSIDER_OCR_BEGIN_ERROR":
          finishOcrError(message.error || "无法启动框选");
          break;
        case "CYSIDER_OCR_CANCELLED":
          setOcrBusy(false);
          showStatus("已取消框选。", "info", 1600);
          break;
        default:
          break;
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "session") return;
      if (changes.cysiderOcrCapture?.newValue) {
        acceptCapture(changes.cysiderOcrCapture.newValue);
      }
      if (changes.cysiderOcrError?.newValue) {
        finishOcrError(changes.cysiderOcrError.newValue.message || "截图失败");
      }
    });
  }

  /* ============ 会话持久化（多会话） ============ */

  function loadSessions() {
    try {
      const raw = localStorage.getItem(SESSIONS_KEY);
      const list = raw ? JSON.parse(raw) : null;
      if (Array.isArray(list) && list.length) {
        state.sessions = list
          .filter((s) => s && s.id && Array.isArray(s.messages))
          .map((s) => ({ id: s.id, title: s.title || "新会话", createdAt: s.createdAt || Date.now(), updatedAt: s.updatedAt || Date.now(), messages: s.messages }));
      } else {
        migrateLegacyHistory();
      }
    } catch (e) {
      migrateLegacyHistory();
    }

    // 确保存在当前会话
    const active = state.sessions.find((s) => s.id === localStorage.getItem(ACTIVE_KEY));
    if (!active) {
      if (state.sessions.length === 0) {
        state.sessions.push(makeSession());
      }
      state.activeId = state.sessions[0].id;
      localStorage.setItem(ACTIVE_KEY, state.activeId);
    } else {
      state.activeId = active.id;
    }
  }

  /** 迁移旧版单一聊天记录为第一个会话 */
  function migrateLegacyHistory() {
    let legacy = [];
    try {
      const raw = localStorage.getItem(LEGACY_HISTORY_KEY);
      const list = raw ? JSON.parse(raw) : [];
      legacy = Array.isArray(list) ? list.filter((m) => m && m.role && m.content) : [];
    } catch (e) { /* ignore */ }
    state.sessions = legacy.length ? [makeSession(legacy)] : [makeSession()];
  }

  function makeSession(messages = []) {
    const now = Date.now();
    return {
      id: "s_" + now.toString(36) + Math.random().toString(36).slice(2, 7),
      title: "新会话",
      createdAt: now,
      updatedAt: now,
      messages: messages.slice()
    };
  }

  function currentSession() {
    return state.sessions.find((s) => s.id === state.activeId) || state.sessions[0] || null;
  }

  function saveSessions() {
    try {
      // 会话上限：保留最近 MAX_SESSIONS 个
      if (state.sessions.length > MAX_SESSIONS) {
        state.sessions = state.sessions.slice(-MAX_SESSIONS);
        if (!state.sessions.some((s) => s.id === state.activeId)) {
          state.activeId = state.sessions[state.sessions.length - 1].id;
          localStorage.setItem(ACTIVE_KEY, state.activeId);
        }
      }
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(state.sessions));
    } catch (e) { /* ignore */ }
  }

  /** 用首条用户消息自动命名（不可改） */
  function ensureTitle(session) {
    if (session.messages.length === 0) {
      session.title = "新会话";
      return;
    }
    const first = session.messages.find((m) => m.role === "user");
    const base = (first && first.content || "新会话").replace(/\s+/g, " ").trim();
    session.title = base.length > 20 ? base.slice(0, 20) + "…" : base || "新会话";
  }

  function touchSession(session) {
    session.updatedAt = Date.now();
    ensureTitle(session);
  }

  function updateSessionTitle() {
    const s = currentSession();
    sessionTitleEl.textContent = (s && s.title) || "cysider";
    sessionTitleEl.title = (s && s.title) || "cysider";
  }

  /* ============ 渲染 ============ */

  function renderAll() {
    messagesEl.textContent = "";
    const session = currentSession();
    const messages = session ? session.messages : [];
    if (messages.length === 0) {
      const tip = document.createElement("div");
      tip.className = "empty-tip";
      tip.textContent = "你好，我是 cysider ✦\n在下方输入消息，或右键选中网页文字发送给 DeepSeek\n也可以框选截图用本地 OCR 识别文字";
      messagesEl.appendChild(tip);
      return;
    }
    // DocumentFragment 一次性插入，减少重排
    const frag = document.createDocumentFragment();
    for (const m of messages) {
      frag.appendChild(buildMessageEl(m.role, m.content, false));
    }
    messagesEl.appendChild(frag);
    // 折叠判断依赖真实布局高度，须在插入 DOM 后进行
    for (const el of messagesEl.querySelectorAll(".msg.assistant")) {
      maybeCollapse(el);
    }
    scrollToBottom();
  }

  function renderHistory() {
    historyList.textContent = "";
    const sorted = [...state.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const s of sorted) {
      const item = document.createElement("div");
      item.className = "history-item" + (s.id === state.activeId ? " active" : "");

      const title = document.createElement("span");
      title.className = "h-title";
      title.textContent = s.title || "新会话";
      title.title = s.title || "新会话";

      const time = document.createElement("span");
      time.className = "h-time";
      time.textContent = formatTime(s.updatedAt || s.createdAt);

      const del = document.createElement("button");
      del.className = "h-del";
      del.type = "button";
      del.textContent = "✕";
      del.title = "删除该会话";
      del.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteSession(s.id);
      });

      item.append(title, time, del);
      item.addEventListener("click", () => switchSession(s.id));
      historyList.appendChild(item);
    }
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const pad = (n) => String(n).padStart(2, "0");
    if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  /* ============ 会话操作 ============ */

  function onNewChat() {
    if (state.busy) {
      showStatus("正在生成中，请先停止再新建聊天。", "error", 2500);
      return;
    }
    const session = makeSession();
    state.sessions.push(session);
    state.activeId = session.id;
    localStorage.setItem(ACTIVE_KEY, session.id);
    saveSessions();
    updateSessionTitle();
    renderAll();
    renderHistory();
    inputEl.focus();
    showStatus("已创建新聊天。", "info", 1500);
  }

  function switchSession(id) {
    if (state.busy) {
      showStatus("正在生成中，请先停止再切换会话。", "error", 2500);
      return;
    }
    if (!state.sessions.some((s) => s.id === id)) return;
    state.activeId = id;
    localStorage.setItem(ACTIVE_KEY, id);
    historyPanel.hidden = true;
    updateSessionTitle();
    renderAll();
    showStatus("已切换到历史会话。", "info", 1500);
  }

  function deleteSession(id) {
    if (state.sessions.length <= 1) {
      // 至少保留一个会话：清空后新建
      const s = currentSession();
      s.messages = [];
      s.title = "新会话";
      s.updatedAt = Date.now();
      saveSessions();
      updateSessionTitle();
      renderAll();
      renderHistory();
      showStatus("仅剩一个会话，已清空。", "info", 1800);
      return;
    }
    const idx = state.sessions.findIndex((s) => s.id === id);
    if (idx < 0) return;
    state.sessions.splice(idx, 1);
    if (state.activeId === id) {
      state.activeId = state.sessions[state.sessions.length - 1].id;
      localStorage.setItem(ACTIVE_KEY, state.activeId);
      updateSessionTitle();
      renderAll();
    }
    saveSessions();
    renderHistory();
    showStatus("会话已删除。", "info", 1500);
  }

  function buildMessageEl(role, content, streaming) {
    const el = document.createElement("div");
    el.className = "msg " + role + (streaming ? " streaming" : "");
    if (role === "assistant" && !streaming) {
      const wrap = document.createElement("div");
      wrap.className = "markdown-body";
      wrap.innerHTML = renderMarkdown(content);
      el.appendChild(wrap);
    } else {
      el.textContent = content;
    }
    return el;
  }

  /* ============ 性能优化：按帧节流渲染 / 增量追加 / 延迟保存 ============ */

  let streamRaf = 0;
  let pendingStreamEl = null;
  let pendingStreamText = "";
  let userScrolledUp = false;
  let saveTimer = null;

  /** 流式输出按 requestAnimationFrame 合并，避免每个 chunk 强制布局（layout thrashing）导致卡顿 */
  function scheduleStreamRender(el, text) {
    pendingStreamEl = el;
    pendingStreamText = text;
    if (streamRaf) return;
    streamRaf = requestAnimationFrame(() => {
      streamRaf = 0;
      if (pendingStreamEl) {
        pendingStreamEl.textContent = pendingStreamText;
        scrollToBottom();
      }
    });
  }

  /** 增量追加一条消息（不清空重建消息区，消息多时流畅） */
  function appendMessage(role, content, streaming) {
    if (!messagesEl.querySelector(".msg")) messagesEl.textContent = "";
    const el = buildMessageEl(role, content, streaming);
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  /** 延迟保存会话，合并连续写入；页面关闭时强制 flush */
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveSessions(); }, 400);
  }

  window.addEventListener("pagehide", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      saveSessions();
    }
  });

  /** 智能滚动：仅在用户位于底部附近时自动滚到底部 */
  function scrollToBottom() {
    if (!userScrolledUp) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /** 回答过长时自动折叠，点击展开/收起（只影响显示，不影响数据） */
  function maybeCollapse(el) {
    if (!el || el.classList.contains("collapsible")) return;
    const body = el.querySelector(".markdown-body");
    if (!body || el.scrollHeight <= COLLAPSE_LIMIT) return;
    el.classList.add("collapsible");
    body.classList.add("collapsed");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "expand-btn";
    btn.textContent = "展开全部 ▾";
    btn.addEventListener("click", () => {
      const isCollapsed = body.classList.toggle("collapsed");
      btn.textContent = isCollapsed ? "展开全部 ▾" : "收起 ▴";
      scrollToBottom();
    });
    el.appendChild(btn);
  }

  /* ============ 模型切换（flash ↔ pro） ============ */

  async function updateModelTag() {
    try {
      const cfg = await api.getConfig();
      modelTag.textContent = cfg.model || "deepseek-v4-flash";
    } catch (e) {
      modelTag.textContent = "deepseek-v4-flash";
    }
  }

  async function toggleModel() {
    if (state.busy) {
      showStatus("正在生成中，请先停止再切换模型。", "error", 2500);
      return;
    }
    try {
      const cfg = await api.getConfig();
      const next = cfg.model === "deepseek-v4-pro" ? "deepseek-v4-flash" : "deepseek-v4-pro";
      await api.saveConfig({ model: next });
      await updateModelTag();
      showStatus("已切换模型：" + next, "ok", 2200);
    } catch (error) {
      showStatus("切换失败：" + (error && error.message || error), "error", 3000);
    }
  }

  /* ============ 思考模式开关与强度（💭） ============ */

  function applyEffortUi(on, effort) {
    effortSel.hidden = !on;
    effortSel.value = effort || "high";
  }

  async function updateThinkBtn() {
    try {
      const cfg = await api.getConfig();
      const on = cfg.thinking !== false;
      thinkBtn.textContent = on ? "💭 思考开" : "💭 思考关";
      thinkBtn.classList.toggle("active", on);
      thinkBtn.title = on ? "思考模式已开启，点击关闭（直接回答）" : "思考模式已关闭，点击开启（回答前深度思考）";
      applyEffortUi(on, cfg.effort);
    } catch (e) {
      thinkBtn.textContent = "💭 思考开";
      thinkBtn.classList.add("active");
      applyEffortUi(true, "high");
    }
  }

  async function toggleThinking() {
    if (state.busy) {
      showStatus("正在生成中，请先停止再切换思考模式。", "error", 2500);
      return;
    }
    try {
      const cfg = await api.getConfig();
      const next = cfg.thinking === false;
      await api.saveConfig({ thinking: next });
      await updateThinkBtn();
      showStatus(next ? "已开启思考模式（回答前先深度思考）。" : "已关闭思考模式（直接回答）。", "ok", 2200);
    } catch (error) {
      showStatus("切换失败：" + (error && error.message || error), "error", 3000);
    }
  }

  async function onEffortChange() {
    if (state.busy) {
      showStatus("正在生成中，请先停止再调整思考强度。", "error", 2500);
      effortSel.value = (await api.getConfig().catch(() => ({}))).effort || "high";
      return;
    }
    try {
      await api.saveConfig({ effort: effortSel.value });
      showStatus("思考强度已设为：" + effortSel.options[effortSel.selectedIndex].text.slice(4), "ok", 1800);
    } catch (error) {
      showStatus("设置失败：" + (error && error.message || error), "error", 3000);
    }
  }

  /* ============ 聊天 ============ */

  function sendFromInput() {
    const text = inputEl.value.trim();
    if (!text || state.busy) return;
    inputEl.value = "";
    autoGrow();
    runChat(text);
  }

  function sendPrompt(payload) {
    // 右键/划词：prompt 已含替换后的完整文本
    const text = String(payload.prompt || payload.text || "").trim();
    if (!text) return;
    showStatus("已收到选中内容，正在发送给 DeepSeek…", "info", 2000);
    runChat(text);
  }

  async function runChat(userText) {
    if (state.busy) return;
    const session = currentSession();
    if (!session) return;
    state.busy = true;
    setBusyUi(true);

    session.messages.push({ role: "user", content: userText, ts: Date.now() });
    touchSession(session);
    scheduleSave();
    updateSessionTitle();
    appendMessage("user", userText);

    const assistantEl = buildMessageEl("assistant", "", true);
    messagesEl.appendChild(assistantEl);
    scrollToBottom();

    const controller = new AbortController();
    state.controller = controller;

    // 上下文窗口：只发最近 CTX_WINDOW 条，防止上下文无限增长
    const windowed = session.messages.slice(-CTX_WINDOW);
    const trimmed = session.messages.length > CTX_WINDOW;
    const history = windowed.map((m) => ({ role: m.role, content: m.content }));

    let acc = "";
    try {
      const reply = await api.chat(history, {
        signal: controller.signal,
        onDelta: (piece) => {
          acc += piece;
          scheduleStreamRender(assistantEl, acc);
        },
        onUsage: (usage) => handleUsage(usage)
      });
      session.messages.push({ role: "assistant", content: reply, ts: Date.now() });
      touchSession(session);
      scheduleSave();
      updateSessionTitle();
      const wrap = document.createElement("div");
      wrap.className = "markdown-body";
      wrap.innerHTML = renderMarkdown(reply);
      assistantEl.classList.remove("streaming");
      assistantEl.textContent = "";
      assistantEl.appendChild(wrap);
      maybeCollapse(assistantEl);
      scrollToBottom();
      if (trimmed) {
        showStatus(`对话较长，本次已截取最近 ${CTX_WINDOW} 条上下文。`, "info", 2500);
      }
    } catch (error) {
      if (error && error.name === "AbortError") {
        if (acc) {
          session.messages.push({ role: "assistant", content: acc, ts: Date.now() });
          touchSession(session);
          scheduleSave();
          updateSessionTitle();
          const wrap = document.createElement("div");
          wrap.className = "markdown-body";
          wrap.innerHTML = renderMarkdown(acc);
          assistantEl.classList.remove("streaming");
          assistantEl.textContent = "";
          assistantEl.appendChild(wrap);
          maybeCollapse(assistantEl);
        } else {
          assistantEl.remove();
        }
        showStatus("已停止生成。", "info", 1500);
      } else {
        assistantEl.remove();
        const errEl = document.createElement("div");
        errEl.className = "msg error";
        errEl.textContent = "发送失败：" + (error && error.message || error);
        messagesEl.appendChild(errEl);
        scrollToBottom();
      }
    } finally {
      state.busy = false;
      state.controller = null;
      setBusyUi(false);
    }
  }

  /* ============ Token 统计（本次 + 累计） ============ */

  function handleUsage(usage) {
    if (!usage) return;
    const prompt = usage.prompt_tokens || 0;
    const completion = usage.completion_tokens || 0;
    const hit = usage.prompt_cache_hit_tokens || 0;
    const miss = usage.prompt_cache_miss_tokens || 0;
    state.lastUsage = { prompt, completion, hit, miss };
    state.totalUsage.prompt += prompt;
    state.totalUsage.completion += completion;
    state.totalUsage.cacheHit += hit;
    state.totalUsage.cacheMiss += miss;
    renderTokenStat();
  }

  function renderTokenStat() {
    if (!state.lastUsage) return;
    const t = state.totalUsage;
    const fmt = (n) => n.toLocaleString("en-US");
    // 两行紧凑排版，避免在窄侧边栏里拉成超长单行
    tokenStat.innerHTML =
      `本次 ↑ ${fmt(state.lastUsage.prompt)} · ↓ ${fmt(state.lastUsage.completion)}` +
      `　累计 ↑ ${fmt(t.prompt)} · ↓ ${fmt(t.completion)}<br>` +
      `<span class="ts-cache-hit" title="缓存命中（计费更低）">缓存命中 ${fmt(state.lastUsage.hit)}</span>` +
      ` / <span class="ts-cache-miss" title="缓存未命中">未命中 ${fmt(state.lastUsage.miss)}</span>`;
    tokenStat.hidden = false;
  }

  function abortStream() {
    if (state.controller) state.controller.abort();
  }

  function setBusyUi(busy) {
    sendBtn.disabled = busy;
    sendBtn.textContent = busy ? "■" : "➤";
    sendBtn.title = busy ? "停止生成" : "发送";
    inputEl.disabled = busy;
  }

  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
  }

  /* ============ 截图 OCR（本地识别） ============ */

  function beginCapture() {
    if (state.ocrBusy) return;
    setOcrBusy(true);
    showStatus("请在当前网页拖动选择文字区域…", "info", 0);
    chrome.runtime.sendMessage({ action: "CYSIDER_OCR_BEGIN" }).catch((error) => {
      finishOcrError(error.message || "无法启动框选");
    });
  }

  async function acceptCapture(capture) {
    if (!capture || !capture.dataUrl || capture.id === state.lastCaptureId) return;
    state.lastCaptureId = capture.id;
    setOcrBusy(true);
    await chrome.storage.session.remove(["cysiderOcrCapture", "cysiderOcrError"]).catch(() => {});
    try {
      showStatus("正在裁剪截图…", "info", 0);
      const cropped = await cropImage(
        capture.dataUrl,
        capture.rect,
        capture.devicePixelRatio,
        capture.viewportWidth,
        capture.viewportHeight
      );
      const text = await recognize(cropped);
      if (text) {
        inputEl.value = text;
        autoGrow();
        inputEl.focus();
        showStatus(`OCR 完成，识别到 ${text.length} 个字符，已填入输入框。`, "ok", 3000);
      }
    } catch (error) {
      finishOcrError(error.message || String(error));
    } finally {
      setOcrBusy(false);
    }
  }

  async function recognize(imageDataUrl) {
    if (!globalThis.Tesseract) {
      throw new Error("本地 OCR 组件未加载，请重新加载扩展。");
    }
    if (!state.worker) {
      showStatus("正在加载本地中英文 OCR 模型，首次使用可能需要几秒…", "info", 0);
      state.workerLanguage = "eng+chi_sim";
      state.worker = await Tesseract.createWorker(state.workerLanguage, 1, {
        workerPath: chrome.runtime.getURL("vendor/tesseract/worker.min.js"),
        workerBlobURL: false,
        corePath: chrome.runtime.getURL("vendor/tesseract-core/"),
        langPath: chrome.runtime.getURL("vendor/lang-data/"),
        logger: (message) => {
          if (message.status === "recognizing text") {
            showStatus(`正在识别文字… ${Math.round((message.progress || 0) * 100)}%`, "info", 0);
          }
        }
      });
    }
    const result = await state.worker.recognize(imageDataUrl);
    const text = (result && result.data && result.data.text || "").trim();
    if (!text) {
      throw new Error("没有识别到清晰文字，请缩小框选范围或选择更清晰的区域。");
    }
    return text;
  }

  async function cropImage(dataUrl, rect, devicePixelRatio = 1, viewportWidth, viewportHeight) {
    const image = await loadImage(dataUrl);
    const scaleX = viewportWidth ? image.naturalWidth / viewportWidth : devicePixelRatio;
    const scaleY = viewportHeight ? image.naturalHeight / viewportHeight : devicePixelRatio;
    const sx = clamp(Math.round(rect.x * scaleX), 0, image.naturalWidth - 1);
    const sy = clamp(Math.round(rect.y * scaleY), 0, image.naturalHeight - 1);
    const sw = clamp(Math.round(rect.width * scaleX), 1, image.naturalWidth - sx);
    const sh = clamp(Math.round(rect.height * scaleY), 1, image.naturalHeight - sy);
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    canvas.getContext("2d").drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas.toDataURL("image/png");
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("无法读取截图。"));
      image.src = src;
    });
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function setOcrBusy(busy) {
    state.ocrBusy = busy;
    ocrBtn.disabled = busy;
  }

  function finishOcrError(message) {
    setOcrBusy(false);
    showStatus("截图 OCR 失败：" + message, "error", 6000);
  }

  /* ============ 笔记精炼 ============ */

  async function onNoteClick() {
    if (state.busy) return;
    const session = currentSession();
    if (!session) return;
    const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant || !lastAssistant.content || lastAssistant.content.length < 20) {
      showStatus("没有可精炼的回答，请先和 cysider 对话一轮。", "error", 3000);
      return;
    }
    setBusyUi(true);
    try {
      showStatus("正在精炼…", "info", 0);
      const note = await api.chat([
        { role: "system", content: NOTE_SYSTEM },
        { role: "user", content: lastAssistant.content }
      ]);
      const filename = await saveTextToLocal("cysider笔记-" + todayFilename(), buildNoteFile(note));
      showStatus("已保存：" + filename, "ok", 5000);
    } catch (error) {
      showStatus("笔记失败：" + (error && error.message || error), "error", 6000);
    } finally {
      setBusyUi(false);
    }
  }

  function buildNoteFile(note) {
    const now = new Date();
    return `# cysider 笔记\n\n> 生成时间：${now.toLocaleString("zh-CN")}\n\n${note}\n`;
  }

  /* ============ 导出会话（⤓ 一键保存本地） ============ */

  function buildConversationMarkdown() {
    const session = currentSession();
    const messages = session ? session.messages : [];
    if (messages.length === 0) return "";
    const now = new Date();
    const parts = [`# cysider 对话`, ``, `> 生成时间：${now.toLocaleString("zh-CN")}`, ``];
    for (const m of messages) {
      const label = m.role === "user" ? "用户" : "cysider";
      parts.push(`## ${label}`, ``, m.content.trim(), ``);
    }
    return parts.join("\n");
  }

  async function saveExport() {
    const md = buildConversationMarkdown();
    if (!md) {
      showStatus("当前会话为空，没有可导出的内容。", "error", 2500);
      return;
    }
    try {
      const filename = await saveTextToLocal("cysider对话-" + todayFilename(), md);
      showStatus("已保存：" + filename, "ok", 4000);
    } catch (error) {
      showStatus("保存失败：" + (error && error.message || error), "error", 5000);
    }
  }

  /* ============ 保存到本地目录（File System Access API） ============ */

  const IDB_NAME = "cysider-note-db";
  const IDB_STORE = "kv";
  const DIR_KEY = "cysiderDirHandle";

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function pad2(n) { return String(n).padStart(2, "0"); }
  function todayFilename() {
    const now = new Date();
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}.md`;
  }

  async function getDirHandle() {
    try {
      const saved = await idbGet(DIR_KEY);
      if (saved) {
        const perm = await saved.queryPermission({ mode: "readwrite" });
        if (perm === "granted") return saved;
        const req = await saved.requestPermission({ mode: "readwrite" });
        if (req === "granted") return saved;
      }
    } catch (e) { /* ignore */ }
    if (typeof window.showDirectoryPicker !== "function") {
      throw new Error("当前 Chrome 不支持目录选择（需 Chrome 86+），无法保存到自定义目录");
    }
    const handle = await window.showDirectoryPicker({ id: "cysider-dir", mode: "readwrite" });
    await idbSet(DIR_KEY, handle);
    return handle;
  }

  /** 保存文本到本地目录（每天一个文件，当天追加）；失败降级到下载目录。返回显示名。 */
  async function saveTextToLocal(baseName, content) {
    try {
      const dir = await getDirHandle();
      const fileHandle = await dir.getFileHandle(baseName, { create: true });
      const existing = await fileHandle.getFile();
      const writable = await fileHandle.createWritable({ keepExistingData: true });
      if (existing.size > 0) {
        await writable.write({ type: "seek", position: existing.size });
        await writable.write("\n\n---\n\n");
      }
      await writable.write(content + "\n");
      await writable.close();
      return baseName;
    } catch (err) {
      const now = new Date();
      const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
      const fallbackName = `cysider-${stamp}.md`;
      const url = URL.createObjectURL(new Blob([content], { type: "text/markdown" }));
      await chrome.downloads.download({ url, filename: fallbackName, saveAs: false });
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return fallbackName + "（已回退到下载目录）";
    }
  }

  /* ============ 清空 ============ */

  function onClear() {
    if (state.busy) {
      showStatus("正在生成中，请先停止再清空。", "error", 2500);
      return;
    }
    const session = currentSession();
    if (!session) return;
    session.messages = [];
    session.title = "新会话";
    session.updatedAt = Date.now();
    saveSessions();
    updateSessionTitle();
    renderAll();
    showStatus("当前会话已清空。", "info", 1500);
  }

  /* ============ 状态提示 ============ */

  function showStatus(text, kind = "info", timeout = 0) {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
    statusEl.hidden = false;
    if (state.statusTimer) clearTimeout(state.statusTimer);
    if (timeout) {
      state.statusTimer = setTimeout(() => { statusEl.hidden = true; }, timeout);
    }
  }

  /* ============ 本地 Markdown 渲染（安全转义，无网络） ============ */

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function inlineMarkdown(escaped) {
    let s = escaped;
    // 行内代码
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    // 链接 [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    // 粗体
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // 斜体
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    // 删除线
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return s;
  }

  function renderMarkdown(text) {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    const html = [];
    let i = 0;

    const flushBlock = (blockLines, lang) => {
      html.push("<pre><code>" + escapeHtml(blockLines.join("\n")) + "</code></pre>");
    };

    let codeBlock = null;
    let codeLang = "";
    let listStack = null; // "ul" | "ol" | null

    const closeList = () => {
      if (listStack) { html.push("</" + listStack + ">"); listStack = null; }
    };

    for (; i < lines.length; i++) {
      const line = lines[i];

      // 代码块
      const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/);
      if (fence) {
        if (codeBlock === null) {
          closeList();
          codeBlock = [];
          codeLang = fence[2] || "";
        } else {
          flushBlock(codeBlock, codeLang);
          codeBlock = null;
          codeLang = "";
        }
        continue;
      }
      if (codeBlock !== null) {
        codeBlock.push(line);
        continue;
      }

      const trimmed = line.trim();

      // 空行
      if (!trimmed) { closeList(); continue; }

      // 标题
      const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeList();
        const level = heading[1].length;
        html.push(`<h${level}>` + inlineMarkdown(escapeHtml(heading[2])) + `</h${level}>`);
        continue;
      }

      // 分隔线
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        closeList();
        html.push("<hr>");
        continue;
      }

      // 引用
      if (trimmed.startsWith(">")) {
        closeList();
        const quoteLines = [];
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
          i++;
        }
        i--;
        html.push("<blockquote>" + inlineMarkdown(escapeHtml(quoteLines.join("\n"))) + "</blockquote>");
        continue;
      }

      // 无序列表
      const ulItem = trimmed.match(/^[-*+]\s+(.*)$/);
      if (ulItem) {
        if (listStack !== "ul") { closeList(); html.push("<ul>"); listStack = "ul"; }
        html.push("<li>" + inlineMarkdown(escapeHtml(ulItem[1])) + "</li>");
        continue;
      }

      // 有序列表
      const olItem = trimmed.match(/^\d+[.、)]\s+(.*)$/);
      if (olItem) {
        if (listStack !== "ol") { closeList(); html.push("<ol>"); listStack = "ol"; }
        html.push("<li>" + inlineMarkdown(escapeHtml(olItem[1])) + "</li>");
        continue;
      }

      // 表格（简单支持：首行表头 + 分隔行 + 数据行）
      if (trimmed.includes("|") && lines[i + 1] && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
        closeList();
        const rows = [];
        while (i < lines.length && lines[i].trim().includes("|")) rows.push(lines[i].trim());
        i--;
        if (rows.length >= 2) {
          const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
          html.push("<table>");
          html.push("<thead><tr>" + cells(rows[0]).map((c) => "<th>" + inlineMarkdown(escapeHtml(c)) + "</th>").join("") + "</tr></thead>");
          html.push("<tbody>");
          for (let r = 2; r < rows.length; r++) {
            html.push("<tr>" + cells(rows[r]).map((c) => "<td>" + inlineMarkdown(escapeHtml(c)) + "</td>").join("") + "</tr>");
          }
          html.push("</tbody></table>");
        }
        continue;
      }

      // 普通段落（合并相邻行）
      closeList();
      const paraLines = [trimmed];
      while (i + 1 < lines.length && lines[i + 1].trim() && !lines[i + 1].trim().startsWith("#")
             && !lines[i + 1].trim().startsWith(">") && !/^[-*+]\s+/.test(lines[i + 1])
             && !/^\d+[.、)]\s+/.test(lines[i + 1]) && !/^\s*(```|~~~)/.test(lines[i + 1])
             && !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i + 1].trim())) {
        paraLines.push(lines[i + 1].trim());
        i++;
      }
      html.push("<p>" + inlineMarkdown(escapeHtml(paraLines.join("\n"))) + "</p>");
    }

    if (codeBlock !== null) flushBlock(codeBlock, codeLang);
    closeList();
    return html.join("\n");
  }
})();
