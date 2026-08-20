/**
 * cysider · background service worker
 *
 * 职责：
 *  1. 右键菜单（解释/翻译/搜索/总结/自定义）→ 打开侧边栏并发给 DeepSeek
 *  2. 划词浮层菜单消息 → 同上
 *  3. 网页框选截图 + OCR 的消息路由（截图在后台完成，识别在侧边栏本地完成）
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

const OCR_CAPTURE_KEY = "cysiderOcrCapture";
const OCR_ERROR_KEY = "cysiderOcrError";

let sidePanelReady = false;
let pendingPrompt = null;

/* ============ 侧边栏消息投递 ============ */

async function openSidePanel() {
  try {
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

/* ============ 截图/OCR 路由（仅本机，不发网络） ============ */

async function beginRegionSelection() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.id || !isSelectablePage(tab.url)) {
      throw new Error("当前页面不支持框选，请在普通 http/https 网页中使用。");
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["capture-overlay.js"]
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

async function captureSelectedRegion(message, sender) {
  try {
    const tab = sender.tab;
    if (!tab || !tab.windowId) throw new Error("无法确定截图所在窗口。");
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const capture = {
      id: crypto.randomUUID(),
      dataUrl,
      rect: message.rect,
      devicePixelRatio: message.devicePixelRatio || 1,
      viewportWidth: message.viewportWidth,
      viewportHeight: message.viewportHeight
    };
    await chrome.storage.session.set({ [OCR_CAPTURE_KEY]: capture });
    await chrome.storage.session.remove(OCR_ERROR_KEY);
    await broadcast({ action: "CYSIDER_OCR_CAPTURE_READY", capture });
    return { ok: true, id: capture.id };
  } catch (error) {
    const failure = { id: crypto.randomUUID(), message: error.message || String(error) };
    await chrome.storage.session.set({ [OCR_ERROR_KEY]: failure });
    await broadcast({ action: "CYSIDER_OCR_CAPTURE_ERROR", error: failure });
    return { ok: false, error: failure.message };
  }
}

function isSelectablePage(url = "") {
  return /^https?:\/\//i.test(url);
}

async function broadcast(message) {
  await chrome.runtime.sendMessage(message).catch(() => {});
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
    case "CYSIDER_OCR_BEGIN":
      beginRegionSelection().then((response) => {
        if (!response.ok) {
          broadcast({ action: "CYSIDER_OCR_BEGIN_ERROR", error: response.error });
        }
        sendResponse(response);
      });
      return true;
    case "CYSIDER_OCR_REGION":
      captureSelectedRegion(message, sender).then(sendResponse);
      return true;
    case "CYSIDER_OCR_CANCELLED":
      broadcast({ action: "CYSIDER_OCR_CANCELLED" });
      sendResponse({ ok: true });
      break;
    default:
      break;
  }
  return false;
});
