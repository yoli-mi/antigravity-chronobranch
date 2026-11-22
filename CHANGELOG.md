# Changelog

All notable changes to **ChronoBranch for Antigravity** will be documented in this file.

## [0.1.0] - 2026-11-22

### Added
- Native **Antigravity MCP App** plugin (`plugin.json`, `mcp_config.json`, `ui://chronobranch/app.html`) supporting side pane (`aux_pane`), full-page sidebar (`global`), and inline entrypoints.
- Real-time Antigravity transcript reader (`transcript.jsonl` + selective `transcript_full.jsonl` hydration) mapping turns, `thinking` steps, tool calls, `ask_question` choice cards, compaction checkpoints, and `invoke_subagent` concurrent swimlanes onto the horizontal dot-and-line canvas.
- File-backed persistent metadata store (`${PLUGIN_DATA}/chronobranch-meta.json`) for workspace multi-conversation linking, fork relationships, merge links, pinned nodes, and collapsed track states.
- Native branching via Antigravity `sendMessage` (`target: "new"`) and Cherry-Pick conclusion merge via `sendMessage` / `updateModelContext`.
- Floating magnetic tiles with **seamless edge-drag breakout** into frameless, always-on-top Windows WPF desktop sticky cards.
- Full bilingual localization (`en` / `zh`) and live light/dark theme synchronization with Antigravity host context.
