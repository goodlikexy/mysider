/**
 * cysider · background service worker
 *
 * 职责：
 *  1. 右键菜单（解释/翻译/搜索/总结/自定义）→ 打开侧边栏并发给 DeepSeek
 *  2. 划词浮层菜单消息 → 同上
 * 不发起任何除 DeepSeek 之外的网络请求。
 */
importScripts("deepseek-api.js");

const MENUS_KEY = "cysiderMenus";

const DEFAULT_MENUS = [
  { menuName: "AI 解释", prompt: "下面的文字是什么意思：\n{text}" },
  { menuName: "AI 翻译", prompt: "将下面的文字翻译为中文：\n{text}" },
  { menuName: "AI 搜索", prompt: '搜索一下"""\n{text}\n"""的相关资料' },
  { menuName: "总结页面", prompt: "帮我总结下这个页面的内容：\n{pageUrl}" }
];

let sidePanelReady = false;
let pendingPrompt = null;

/* ============ 侧边栏消息投递 ============ */

// 兜底：Chrome 114/115 不支持 manifest 里 side_panel.openPanelOnActionClick（116+ 才支持），
// 必须编程式调用 setPanelBehavior 才能在点击工具栏图标时打开侧边栏。
// 116+ 上该调用与 manifest 声明一致，冗余执行无害。
if (globalThis.chrome && chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === "function") {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

async function openSidePanel() {
  try {
    if (!chrome.sidePanel || typeof chrome.sidePanel.open !== "function") {
      throw new Error("当前 Chrome 版本过低（侧边栏编程打开需 Chrome 116+），请点击浏览器工具栏的 cysider 图标打开侧边栏。");
    }
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && tab.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return true;
    }
  } catch (e) {
    console.error("[cysider] open sidePanel failed:", e);
  }
  return false;
}

function deliverPrompt(payload) {
  pendingPrompt = payload;
  openSidePanel().then(() => {
    if (sidePanelReady) {
      flushPendingPrompt();
    } else {
      // 侧边栏可能尚未加载完成，稍后再试一次
      setTimeout(flushPendingPrompt, 2500);
    }
  });
}

function flushPendingPrompt() {
  if (!pendingPrompt) return;
  const payload = pendingPrompt;
  pendingPrompt = null;
  chrome.runtime.sendMessage({ action: "cysider_prompt", ...payload }).catch(() => {});
}

/* ============ 右键菜单 ============ */

async function getMenus() {
  try {
    const data = await chrome.storage.local.get(MENUS_KEY);
    if (Array.isArray(data[MENUS_KEY]) && data[MENUS_KEY].length) return data[MENUS_KEY];
  } catch (e) { /* ignore */ }
  return DEFAULT_MENUS;
}

async function rebuildMenus() {
  await chrome.contextMenus.removeAll();
  const menus = await getMenus();
  menus.forEach((menu, index) => {
    const hasText = String(menu.prompt || "").includes("{text}");
    chrome.contextMenus.create({
      id: `cysider_menu_${index}`,
      title: menu.menuName || `菜单 ${index + 1}`,
      contexts: hasText ? ["selection"] : ["page"]
    });
  });
}

async function handleMenuClick(menuItemId, info) {
  const menus = await getMenus();
  const index = String(menuItemId).split("_").pop();
  const menu = menus[Number(index)];
  if (!menu) return;
  const prompt = String(menu.prompt || "")
    .replaceAll("{text}", info.selectionText || "")
    .replaceAll("{pageUrl}", info.pageUrl || "");
  deliverPrompt({ text: info.selectionText || "", prompt, pageUrl: info.pageUrl || "" });
}

/* ============ 消息监听 ============ */

chrome.runtime.onInstalled.addListener(() => {
  rebuildMenus().catch((e) => console.error("[cysider] rebuild menus failed:", e));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[MENUS_KEY]) {
    rebuildMenus().catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener((info) => {
  handleMenuClick(info.menuItemId, info).catch((e) => console.error("[cysider] menu click failed:", e));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message && message.action) {
    case "cysider_ready":
      sidePanelReady = true;
      flushPendingPrompt();
      sendResponse({ ok: true });
      break;
    case "cysider_selection":
      // 来自 content.js 划词浮层：text + prompt
      deliverPrompt({ text: message.text || "", prompt: message.prompt || "", pageUrl: message.pageUrl || "" });
      sendResponse({ ok: true });
      break;
    default:
      break;
  }
  return false;
});
