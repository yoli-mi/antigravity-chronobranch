<div align="center">

<h1>ChronoBranch for Antigravity</h1>

<p>
  <strong>将 Antigravity 长对话与多分支探索，变成一条清晰直观的横向点线时间线画布</strong>
</p>

<p>
  <a href="https://github.com/yoli-mi/antigravity-chronobranch/releases"><img src="https://img.shields.io/github/v/release/yoli-mi/antigravity-chronobranch?style=flat-square&color=18181b" alt="Release" /></a>
  <a href="https://github.com/yoli-mi/antigravity-chronobranch/actions"><img src="https://img.shields.io/github/actions/workflow/status/yoli-mi/antigravity-chronobranch/ci.yml?style=flat-square" alt="CI" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Antigravity-MCP%20App-2563eb?style=flat-square" alt="Antigravity MCP App" />
  <img src="https://img.shields.io/badge/i18n-中文%20%7C%20English-059669?style=flat-square" alt="Bilingual" />
</p>

<p>
  简体中文 · <a href="./README.en.md">English</a> · <a href="https://github.com/yoli-mi/dsh-chronobranch">DSH 桌面端版本</a>
</p>

</div>

---

## 这是什么？

**ChronoBranch** 是一款面向 **Google Antigravity** 的原生 **MCP App UI 插件**。它将传统纵向无限滚动的 AI 对话记录，重组为**按时间从左向右延展的极简点线时间线画布**，让你一眼看清长对话脉络、Agent 子代理并发泳道与多分支探索结构。

---

## 核心功能

- **极简点线时间线 & 三档缩放（L1 / L2 / L3）**
  - 支持滚轮无级缩放与三档快捷切换：**鸟瞰（L1）**、**点线（L2）**、**展开（L3）**。
  - 点击任意节点原地展开完整对话卡片，支持完整 Markdown 渲染、代码块一键复制与四周自由拖拽缩放尺寸。
- **Agent 子代理泳道 & 执行微观小轴**
  - 自动解析 `invoke_subagent` 派生的子代理会话，绘制为独立并发泳道。
  - 每个轮次内置**微观执行小轴**，按序记录思考推理（`thinking`）、工具调用、命令输出、文件 Diff、Agent 提问选择卡片与上下文压缩检查点，点击任意小点即可在侧边抽屉查看完整详情。
- **原生分支对话 & Cherry-Pick 结论回流**
  - 从任意历史节点一键发起并行分支探索，在画布上以正交树状分支呈现。
  - 支持将支线验证过的结论提炼并 **Cherry-Pick 回流** 到父线上下文，并在画布上绘制虚线回流连线。
- **工作区多对话时间线关联**
  - 自由勾选同一工作区下的任意对话进行关联，打开其中任一对话的时间线即可同屏纵览全部关联泳道与节点。
- **悬浮磁贴 & 跨界拖出桌面独立置顶**
  - 将任意关键轮次固定为悬浮磁贴，支持切换「完整 / 仅 AI」、多张磁贴磁吸并排与一键定位跳回原节点。
  - **跨界拖出自动脱离**：将磁贴拖出侧边栏/对话面板边界，或点击弹出按钮，自动切换为 **Windows 原生无边框置顶桌面卡片**（不占任务栏，最小化主窗口仍保留，方便边看论文/代码边对照）。
- **原生深浅色主题 & 中英双语同步**
  - 自动跟随 Antigravity 的浅色 / 深色主题与界面语言（中文 / 标准英文）。

---

## 安装方式（无需构建，开箱即用）

本仓库已包含预构建的自包含单文件产物（`dist/server.mjs` 与 `dist/app.html`），无需安装依赖或编译。

### 方式一：一行命令克隆安装（推荐）

**Windows (PowerShell)：**
```powershell
git clone https://github.com/yoli-mi/antigravity-chronobranch.git "$env:USERPROFILE\.gemini\config\plugins\chronobranch"
```

**macOS / Linux：**
```bash
git clone https://github.com/yoli-mi/antigravity-chronobranch.git ~/.gemini/config/plugins/chronobranch
```

Antigravity 会自动发现 `~/.gemini/config/plugins/chronobranch/` 下的插件（无需手动编辑配置文件）：
1. 在任意对话右上侧辅助栏点击 **`+` → Timeline**（侧边视图），或
2. 在左侧导航栏点击 **ChronoBranch**（全屏画布视图），或
3. 直接对 Agent 说「打开 ChronoBranch 时间线」。

### 方式二：源码构建安装

需要 Node.js >= 20 与 pnpm：

```bash
git clone https://github.com/yoli-mi/antigravity-chronobranch.git
cd antigravity-chronobranch
pnpm install
pnpm run install:antigravity
```

卸载：
```bash
pnpm run uninstall:antigravity
```

---

## 项目结构

```text
antigravity-chronobranch/
├── plugin.json                 # Antigravity 插件清单
├── mcp_config.json             # MCP App 服务配置（使用 ${PLUGIN_ROOT} / ${PLUGIN_DATA}）
├── assets/logo.svg             # 插件图标
├── dist/
│   ├── server.mjs              # 预构建自包含 Node.js MCP 服务端
│   └── app.html                # 预构建单文件严格 CSP 兼容 UI 应用
├── src/
│   ├── antigravity/
│   │   ├── server.ts           # MCP App 服务端与工具定义
│   │   ├── transcript-adapter.ts # Antigravity transcript.jsonl 解析与 UCGS 图谱构建
│   │   ├── meta-store-file.ts  # 持久化元数据仓库（${PLUGIN_DATA}）
│   │   └── app.tsx             # @modelcontextprotocol/ext-apps 前端入口
│   ├── core/                   # 跨平台统一时间线画布、布局、样式、双语词典与 Markdown 渲染
│   ├── client/                 # 悬浮磁贴状态与交互覆盖层（支持跨界拖出）
│   └── host/wpf-tile-script.ts # Windows 原生无边框桌面置顶磁贴宿主
└── scripts/                    # 打包与安装脚本
```

---

## 开源协议

基于 [MIT License](./LICENSE) 开源。如果这个项目帮到了你，欢迎点个 **Star ⭐** 支持一下！
