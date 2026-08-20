# mysider

个人 DeepSeek 侧边栏插件 · Chrome Manifest V3 扩展

> 纯本地、可审计：唯一网络请求发往你自己配置的 DeepSeek API，不含任何第三方跟踪。

## ✨ 功能

- **DeepSeek 流式聊天**：deepseek-v4-flash / deepseek-v4-pro 一键切换
- **思考模式**：💭 开关 + 思考强度调节（低 / 高 / 最高）
- **右键菜单 / 划词浮层**：选中网页文字直接发送给 DeepSeek
- **截图 OCR**：网页框选截图 + 本地 Tesseract 识别，结果自动填入输入框
- **笔记精炼**：把最后一条回答精炼成 Markdown 笔记，保存到本地目录
- **一键导出**：会话一键保存为 .md 到本地目录
- **霞鹜文楷**：界面字体本地打包（LXGW WenKai）

## 🚀 安装

1. 打开 `chrome://extensions`，开启右上角"开发者模式"
2. 点击"加载已解压的扩展程序"，选择本目录
3. 点击扩展图标打开侧边栏 → 点 ⚙ 打开设置 → 填入 DeepSeek API Key → 点"测试连接"验证

## 📖 使用

- 侧边栏直接输入消息与 DeepSeek 对话（Enter 发送，Shift+Enter 换行，发送中可点 ■ 停止）
- 右下角模型标签**点击切换** deepseek-v4-flash ↔ deepseek-v4-pro；💭 切换思考模式，旁边下拉调强度
- 网页选中文字 → 右键菜单或划词浮层 → 发送到 DeepSeek
- ✂ 截图 OCR：在网页拖动框选 → 本地识别 → 文字自动填入输入框；📝 笔记精炼保存本地；⤓ 一键导出 .md

## 🔒 隐私与安全

- 唯一出站请求：你配置的 DeepSeek API（默认 `https://api.deepseek.com/chat/completions`）
- API Key 只保存在本机 `chrome.storage.local`
- OCR、字体、Markdown 渲染全部本地完成，无 CDN、无遥测、无第三方统计
- 已彻底移除原版插件中的阿里/千问组件与推广外链

## 🗂 项目结构

```
mysider/
├── manifest.json        # 扩展清单（MV3）
├── background.js        # 右键菜单 + 截图/OCR 路由
├── content.js           # 划词浮层菜单
├── deepseek-api.js      # DeepSeek API 封装（流式 / 思考模式）
├── sidepanel.*          # 侧边栏聊天 UI（聊天 / OCR / 笔记 / 导出）
├── options.*            # 设置页（Key / 模型 / 思考 / 右键菜单）
├── capture-overlay.js   # 网页框选截图
├── vendor/              # 本地资源（Tesseract OCR、霞鹜文楷字体）
└── tests/               # 契约与安全回归测试
```

## 🛠 开发

```bash
npm run check   # 语法检查
npm test        # 回归测试（9 项）
```

## ⚖️ 许可

- 代码：MIT License
- 霞鹜文楷（LXGW WenKai）：© 落霞孤鹜，[SIL Open Font License 1.1](https://github.com/lxgw/LxgwWenKai)
