(() => {
  const existing = document.getElementById("cysider-ocr-capture-layer");
  if (existing) {
    existing.remove();
  }

  const layer = document.createElement("div");
  layer.id = "cysider-ocr-capture-layer";
  Object.assign(layer.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    cursor: "crosshair",
    background: "rgba(15, 23, 42, 0.12)",
    userSelect: "none"
  });

  const selection = document.createElement("div");
  Object.assign(selection.style, {
    position: "fixed",
    display: "none",
    border: "2px solid #1677ff",
    borderRadius: "0",
    background: "rgba(22, 119, 255, 0.08)",
    boxShadow: "0 0 0 99999px rgba(15, 23, 42, 0.28)",
    pointerEvents: "none"
  });

  const hint = document.createElement("div");
  hint.textContent = "拖动框选文字区域 · Esc 取消";
  Object.assign(hint.style, {
    position: "fixed",
    top: "18px",
    left: "50%",
    transform: "translateX(-50%)",
    padding: "8px 12px",
    color: "#fff",
    background: "rgba(15, 23, 42, 0.88)",
    borderRadius: "0",
    font: "13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif",
    pointerEvents: "none"
  });

  layer.append(selection, hint);
  document.documentElement.appendChild(layer);

  let startX = 0;
  let startY = 0;
  let dragging = false;

  layer.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    selection.style.display = "block";
    updateSelection(event.clientX, event.clientY);
    event.preventDefault();
  }, true);

  layer.addEventListener("mousemove", (event) => {
    if (!dragging) return;
    updateSelection(event.clientX, event.clientY);
    event.preventDefault();
  }, true);

  layer.addEventListener("mouseup", async (event) => {
    if (!dragging || event.button !== 0) return;
    dragging = false;
    const rect = normalizeRect(startX, startY, event.clientX, event.clientY);
    cleanup();
    if (rect.width < 8 || rect.height < 8) {
      await chrome.runtime.sendMessage({ action: "CYSIDER_OCR_CANCELLED" }).catch(() => {});
      return;
    }
    await chrome.runtime.sendMessage({
      action: "CYSIDER_OCR_REGION",
      rect,
      devicePixelRatio: window.devicePixelRatio || 1,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    }).catch((error) => {
      showPageError(`截图失败：${error.message}`);
    });
  }, true);

  document.addEventListener("keydown", onKeyDown, true);

  function updateSelection(endX, endY) {
    const rect = normalizeRect(startX, startY, endX, endY);
    selection.style.left = `${rect.x}px`;
    selection.style.top = `${rect.y}px`;
    selection.style.width = `${rect.width}px`;
    selection.style.height = `${rect.height}px`;
  }

  function normalizeRect(x1, y1, x2, y2) {
    return {
      x: Math.max(0, Math.min(x1, x2)),
      y: Math.max(0, Math.min(y1, y2)),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1)
    };
  }

  function onKeyDown(event) {
    if (event.key !== "Escape") return;
    cleanup();
    chrome.runtime.sendMessage({ action: "CYSIDER_OCR_CANCELLED" }).catch(() => {});
  }

  function cleanup() {
    document.removeEventListener("keydown", onKeyDown, true);
    layer.remove();
  }

  function showPageError(message) {
    const toast = document.createElement("div");
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed",
      top: "18px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      padding: "9px 13px",
      color: "#fff",
      background: "#c62828",
      borderRadius: "0",
      font: "13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif"
    });
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }
})();
