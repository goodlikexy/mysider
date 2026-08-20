/**
 * cysider · content script（划词浮层菜单）
 *
 * 仅做一件本地 UI 事：选中文字后弹出小浮层，点击把选中文字 + prompt 发给
 * background（由其打开侧边栏发给 DeepSeek）。不读取、不发送任何页面数据到网络。
 */
(() => {
  "use strict";
  if (window.__cysiderContentInstalled) return;
  window.__cysiderContentInstalled = true;

  const MENUS_KEY = "cysiderMenus";
  const DEFAULT_MENUS = [
    { menuName: "AI 解释", prompt: "下面的文字是什么意思：\n{text}" },
    { menuName: "AI 翻译", prompt: "将下面的文字翻译为中文：\n{text}" },
    { menuName: "AI 搜索", prompt: '搜索一下"""\n{text}\n"""的相关资料' }
  ];

  let menuEl = null;

  document.addEventListener("mouseup", (event) => {
    if (window.self !== window.top) return; // 只处理顶层页面
    if (event.target && event.target.closest && event.target.closest("#cysider-selection-menu")) return;
    // 延迟执行，确保 selection 已更新
    setTimeout(() => {
      const text = window.getSelection ? window.getSelection().toString().trim() : "";
      if (!text) return hideMenu();
      showMenu(event.clientX, event.clientY, text);
    }, 10);
  });

  document.addEventListener("mousedown", (event) => {
    if (menuEl && event.target && !menuEl.contains(event.target)) hideMenu();
  }, true);

  document.addEventListener("scroll", () => hideMenu(), true);

  function getMenus() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(MENUS_KEY, (data) => {
          const menus = data && data[MENUS_KEY];
          resolve(Array.isArray(menus) && menus.length ? menus : DEFAULT_MENUS);
        });
      } catch (e) {
        resolve(DEFAULT_MENUS);
      }
    });
  }

  async function showMenu(x, y, text) {
    hideMenu();
    menuEl = document.createElement("div");
    menuEl.id = "cysider-selection-menu";
    menuEl.style.cssText = [
      "position:fixed", "z-index:2147483646", "left:0", "top:0",
      "transform:translate(" + x + "px," + y + "px)",
      "display:flex", "flex-direction:column", "gap:2px",
      "padding:4px", "background:#fff", "border:1px solid rgba(0,0,0,0.12)",
      "border-radius:10px", "box-shadow:0 6px 24px rgba(15,23,42,0.18)",
      "font:13px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif",
      "color:#1f2328", "user-select:none", "min-width:96px"
    ].join(";");

    const menus = await getMenus();
    menus.forEach((menu, index) => {
      const item = document.createElement("div");
      item.textContent = menu.menuName || ("菜单 " + (index + 1));
      item.style.cssText = [
        "padding:5px 10px", "border-radius:6px", "cursor:pointer",
        "white-space:nowrap", "font-size:13px"
      ].join(";");
      item.addEventListener("mouseenter", () => { item.style.background = "#f3f4f6"; });
      item.addEventListener("mouseleave", () => { item.style.background = "transparent"; });
      item.addEventListener("click", () => {
        const prompt = String(menu.prompt || "").replaceAll("{text}", text);
        hideMenu();
        chrome.runtime.sendMessage({
          action: "cysider_selection",
          text,
          prompt,
          pageUrl: window.location.href
        }).catch(() => {});
      });
      menuEl.appendChild(item);
    });

    document.documentElement.appendChild(menuEl);
    // 防止菜单超出视口
    const rect = menuEl.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    menuEl.style.transform = "translate(" + Math.min(x, Math.max(0, maxX)) + "px," + Math.min(y, Math.max(0, maxY)) + "px)";
  }

  function hideMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
  }
})();
