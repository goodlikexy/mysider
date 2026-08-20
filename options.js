/**
 * cysider · 设置页逻辑
 */
(() => {
  "use strict";

  const MENUS_KEY = "cysiderMenus";
  const DEFAULT_MENUS = [
    { menuName: "AI 解释", prompt: "下面的文字是什么意思：\n{text}" },
    { menuName: "AI 翻译", prompt: "将下面的文字翻译为中文：\n{text}" },
    { menuName: "AI 搜索", prompt: '搜索一下"""\n{text}\n"""的相关资料' },
    { menuName: "总结页面", prompt: "帮我总结下这个页面的内容：\n{pageUrl}" }
  ];

  const $ = (id) => document.getElementById(id);
  const api = globalThis.CysiderDeepSeek;

  let menusCache = [];

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    const cfg = await api.getConfig();
    $("apiKey").value = cfg.apiKey || "";
    $("apiUrl").value = cfg.apiUrl || api.DEFAULT_URL;
    $("model").value = cfg.model;
    $("temperature").value = cfg.temperature;
    $("thinking").checked = cfg.thinking !== false;
    $("effort").value = cfg.effort || "high";
    updateThinkingUi();

    $("toggleKey").addEventListener("click", () => {
      const input = $("apiKey");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      $("toggleKey").textContent = show ? "隐藏" : "显示";
    });

    $("thinking").addEventListener("change", updateThinkingUi);
    $("saveBtn").addEventListener("click", onSave);
    $("testBtn").addEventListener("click", onTest);
    $("addMenuBtn").addEventListener("click", () => {
      menusCache.push({ menuName: "新菜单", prompt: "请解释：\n{text}" });
      renderMenus();
    });
    $("resetMenusBtn").addEventListener("click", () => {
      menusCache = DEFAULT_MENUS.map((m) => ({ ...m }));
      renderMenus();
    });

    await loadMenus();
    renderMenus();
  }

  function updateThinkingUi() {
    const on = $("thinking").checked;
    $("thinkingLabel").textContent = on ? "开启（回答前先深度思考）" : "关闭（直接回答，更快）";
    $("effortRow").style.display = on ? "" : "none";
  }

  async function loadMenus() {
    try {
      const data = await chrome.storage.local.get(MENUS_KEY);
      menusCache = Array.isArray(data[MENUS_KEY]) && data[MENUS_KEY].length
        ? data[MENUS_KEY]
        : DEFAULT_MENUS.map((m) => ({ ...m }));
    } catch (e) {
      menusCache = DEFAULT_MENUS.map((m) => ({ ...m }));
    }
  }

  function renderMenus() {
    const list = $("menuList");
    list.textContent = "";
    menusCache.forEach((menu, index) => {
      const item = document.createElement("div");
      item.className = "menu-item";

      const head = document.createElement("div");
      head.className = "menu-head";
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "name-input";
      nameInput.value = menu.menuName || "";
      nameInput.placeholder = "菜单名称";
      nameInput.addEventListener("input", () => { menusCache[index].menuName = nameInput.value; });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "remove";
      removeBtn.textContent = "删除";
      removeBtn.addEventListener("click", () => {
        menusCache.splice(index, 1);
        renderMenus();
      });

      head.append(nameInput, removeBtn);

      const promptArea = document.createElement("textarea");
      promptArea.value = menu.prompt || "";
      promptArea.placeholder = "提示词模板，{text}=选中文字，{pageUrl}=页面地址";
      promptArea.addEventListener("input", () => { menusCache[index].prompt = promptArea.value; });

      item.append(head, promptArea);
      list.appendChild(item);
    });
  }

  function setStatus(text, kind) {
    const el = $("statusMsg");
    el.textContent = text;
    el.dataset.kind = kind || "";
    el.hidden = false;
  }

  async function onSave() {
    const btn = $("saveBtn");
    btn.disabled = true;
    try {
      const cfg = await api.saveConfig({
        apiKey: $("apiKey").value.trim(),
        apiUrl: $("apiUrl").value.trim(),
        model: $("model").value,
        temperature: Number($("temperature").value),
        thinking: $("thinking").checked,
        effort: $("effort").value
      });
      await chrome.storage.local.set({ [MENUS_KEY]: menusCache });
      setStatus("已保存 · 模型 " + cfg.model + " · 思考模式" + (cfg.thinking ? "开" : "关"), "ok");
    } catch (e) {
      setStatus("保存失败：" + (e && e.message || e), "err");
    } finally {
      btn.disabled = false;
    }
  }

  async function onTest() {
    const btn = $("testBtn");
    btn.disabled = true;
    setStatus("正在测试连接…");
    try {
      // 先用当前表单值保存，再测试
      await api.saveConfig({
        apiKey: $("apiKey").value.trim(),
        apiUrl: $("apiUrl").value.trim(),
        model: $("model").value,
        temperature: Number($("temperature").value),
        thinking: $("thinking").checked,
        effort: $("effort").value
      });
      const reply = await api.testConnection();
      setStatus("连接成功 ✓ " + (reply ? reply.slice(0, 40) : ""), "ok");
    } catch (e) {
      setStatus("连接失败：" + (e && e.message || e), "err");
    } finally {
      btn.disabled = false;
    }
  }
})();
