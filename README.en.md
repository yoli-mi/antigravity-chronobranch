<div align="center">

<h1>ChronoBranch for Antigravity</h1>

<p>
  <strong>Turn long Antigravity conversations, subagents, and parallel branches into a clean horizontal dot-and-line timeline canvas</strong>
</p>

<p>
  <a href="https://github.com/yoli-mi/antigravity-chronobranch/releases"><img src="https://img.shields.io/github/v/release/yoli-mi/antigravity-chronobranch?style=flat-square&color=18181b" alt="Release" /></a>
  <a href="https://github.com/yoli-mi/antigravity-chronobranch/actions"><img src="https://img.shields.io/github/actions/workflow/status/yoli-mi/antigravity-chronobranch/ci.yml?style=flat-square" alt="CI" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Antigravity-MCP%20App-2563eb?style=flat-square" alt="Antigravity MCP App" />
  <img src="https://img.shields.io/badge/i18n-中文%20%7C%20English-059669?style=flat-square" alt="Bilingual" />
</p>

<p>
  <a href="./README.md">简体中文</a> · English · <a href="https://github.com/yoli-mi/dsh-chronobranch">DSH Desktop Edition</a>
</p>

</div>

---

## Overview

**ChronoBranch** is a native **MCP App UI Plugin** for **Google Antigravity**. It transforms long linear AI chat logs into a **left-to-right horizontal dot-and-line timeline canvas**, giving you instant spatial clarity across multi-turn chats, spawned subagent swimlanes, and parallel branch explorations.

---

## Key Features

- **Minimalist Dot-and-Line Timeline & 3-Tier Zoom (`L1` / `L2` / `L3`)**
  - Smooth wheel zoom plus instant presets: **Overview (`L1`)**, **Dot-Line (`L2`)**, and **Expanded (`L3`)**.
  - Click any turn to expand a full resizable dialog sheet with Markdown rendering and one-click code copy.
- **Subagent Swimlanes & Execution Micro-Axis**
  - Automatically detects `invoke_subagent` conversations and renders them as live concurrent swimlanes attached to their spawning turn.
  - Unfold any turn's **Execution Micro-Axis** to inspect reasoning (`thinking`), tool calls, command outputs, file edits, interactive agent choices, and context compaction checkpoints.
- **Native Branching & Cherry-Pick Merge**
  - Fork a new parallel conversation branch from any turn and visualize branches as an orthogonal tree.
  - Synthesize verified branch findings and **Cherry-Pick Merge** them back into the parent conversation with a visual merge connector.
- **Workspace Multi-Conversation Linking**
  - Link any number of conversations in your workspace to view all of their timelines together on a single canvas.
- **Floating Magnetic Tiles & Drag-Out Desktop Sticky Cards**
  - Pin any turn as a floating tile (`Full` / `AI Only`, side-by-side snapping, instant locate).
  - **Seamless Edge Breakout**: Drag a tile past the edge of the side pane—or click the pop-out button—to detach it into a **frameless, always-on-top Windows desktop sticky card** (zero taskbar clutter, stays visible even when Antigravity is minimized).
- **Live Theme & Bilingual (`en` / `zh`) Sync**
  - Automatically follows Antigravity's light/dark theme tokens and active locale.

---

## Quick Install (Zero Build Required)

Prebuilt self-contained bundles (`dist/server.mjs` and `dist/app.html`) are committed directly in this repository—no `npm install` or compilation needed.

### Option 1: One-Line Git Clone (Recommended)

**Windows (PowerShell):**
```powershell
git clone https://github.com/yoli-mi/antigravity-chronobranch.git "$env:USERPROFILE\.gemini\config\plugins\chronobranch"
```

**macOS / Linux:**
```bash
git clone https://github.com/yoli-mi/antigravity-chronobranch.git ~/.gemini/config/plugins/chronobranch
```

Antigravity discovers `~/.gemini/config/plugins/chronobranch/` automatically:
1. Click **`+` → Timeline** in the conversation side pane, or
2. Click **ChronoBranch** in the left sidebar for a full-page canvas, or
3. Ask the agent to *"Open the ChronoBranch timeline"*.

### Option 2: Build from Source

Requires Node.js >= 20 and pnpm:

```bash
git clone https://github.com/yoli-mi/antigravity-chronobranch.git
cd antigravity-chronobranch
pnpm install
pnpm run install:antigravity
```

To uninstall:
```bash
pnpm run uninstall:antigravity
```

---

## License

Released under the [MIT License](./LICENSE). If ChronoBranch improves your workflow, consider leaving a **Star ⭐**!
