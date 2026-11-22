/**
 * Antigravity Transcript Adapter -> Unified Chrono-Graph Schema (UCGS).
 *
 * Reads Antigravity conversation transcripts from:
 *   `<brainDir>/<conversationId>/.system_generated/logs/transcript.jsonl`
 *   (+ selective hydration from `transcript_full.jsonl` whenever `truncated_fields` is present)
 *
 * Maps directly onto the exact same `ChronoGraph` & `WorkspaceSessionOption[]`
 * consumed by `src/core/ChronoCanvas.tsx` with zero changes to core UI components.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ChronoMetaSnapshot } from '../client/meta-store';
import { getChronoMessages, type ChronoLocale } from '../core/i18n';
import {
  RESTRAINED_BRANCH_PALETTE,
  type AgentChoiceOption,
  type AgentChoicePrompt,
  type AssistantSegment,
  type ChronoGraph,
  type ChronoNode,
  type ChronoTrack,
  type MicroStep,
  type MicroStepKind,
  type PlatformCapabilities,
  type WorkspaceSessionOption,
} from '../core/types';

interface RawToolCall {
  readonly name?: string;
  readonly args?: Record<string, unknown>;
}

interface RawTranscriptStep {
  readonly step_index?: number;
  readonly source?: string;
  readonly type?: string;
  readonly status?: string;
  readonly created_at?: string;
  readonly content?: string;
  readonly thinking?: string;
  readonly error?: string;
  readonly model?: string;
  readonly tool_calls?: readonly RawToolCall[];
  readonly truncated_fields?: readonly string[];
}

export interface ParsedSubagentRef {
  readonly childId: string;
  readonly role: string;
  readonly typeName: string;
  readonly parentTurnNodeId: string;
  readonly parentStepIndex: number;
}

export interface ParsedConversation {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly running: boolean;
  readonly workspacePath?: string;
  readonly workspaceName?: string;
  readonly turns: readonly TurnDraft[];
  readonly subagents: readonly ParsedSubagentRef[];
}

interface TurnDraft {
  readonly seq: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly userText: string;
  readonly aiTexts: string[];
  readonly aiSegments: AssistantSegment[];
  readonly choices: AgentChoicePrompt[];
  readonly microSteps: MicroStep[];
  readonly filesChanged: Set<string>;
  readonly toolCount: number;
  readonly hasError: boolean;
  readonly running: boolean;
}

export interface ConversationSummaryItem {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly running: boolean;
  readonly workspaceName?: string;
  readonly turnCount: number;
  readonly isSubagent: boolean;
}

interface CacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly locale: ChronoLocale;
  readonly parsed: ParsedConversation;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unquoteArg(val: unknown): string {
  if (typeof val !== 'string') return val === undefined || val === null ? '' : JSON.stringify(val);
  const trimmed = val.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Keep original
    }
  }
  return trimmed;
}

function parseJsonArg<T = unknown>(val: unknown): T | undefined {
  if (typeof val !== 'string') return val as T | undefined;
  const trimmed = val.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return undefined;
  }
}

function cleanUserContent(raw: string): { text: string; isSystemOnly: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { text: '', isSystemOnly: true };

  // Prefer explicit <USER_REQUEST>...</USER_REQUEST> block
  const reqMatch = trimmed.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (reqMatch && reqMatch[1].trim()) {
    return { text: reqMatch[1].trim(), isSystemOnly: false };
  }

  // Detect pure system wakeup notifications delivered on a user turn slot
  if (
    trimmed.startsWith('The following is a <SYSTEM_MESSAGE>') ||
    (trimmed.includes('<SYSTEM_MESSAGE>') && !trimmed.includes('<USER_REQUEST>'))
  ) {
    return { text: '', isSystemOnly: true };
  }

  // Strip known Antigravity wrapper tags
  const cleaned = trimmed
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/g, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, '')
    .replace(/<\/?USER_REQUEST>/g, '')
    .trim();

  if (!cleaned) return { text: '', isSystemOnly: true };
  return { text: cleaned, isSystemOnly: false };
}

function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--:--';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function classifyToolKind(name: string): MicroStepKind {
  const lower = name.toLowerCase();
  if (lower.includes('subagent') || lower.includes('swarm')) return 'subagent-spawn';
  if (lower.includes('command') || lower.includes('terminal') || lower.includes('bash') || lower.includes('shell')) {
    return 'terminal';
  }
  if (lower.includes('edit') || lower.includes('write') || lower.includes('patch') || lower.includes('replace')) {
    return 'file-diff';
  }
  return 'tool-call';
}

function extractFirstCodeBlock(text: string): { lang?: string; snippet?: string } {
  const m = text.match(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/);
  if (!m) return {};
  return {
    lang: m[1] || 'text',
    snippet: m[2].trim().slice(0, 420),
  };
}

function summarizeText(text: string, locale: ChronoLocale, maxLen = 115): string {
  const msg = getChronoMessages(locale);
  const clean = text
    .replace(/```[\s\S]*?```/g, msg.codeSnippetTag)
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return msg.noTextOutput;
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean;
}

function firstLineTitle(text: string, fallback: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
      .find((l) => l.length > 0) ?? '';
  if (!line) return fallback;
  return line.length > 30 ? `${line.slice(0, 30)}…` : line;
}

function extractWorkspaceFromUri(uri: string): { path: string; name: string } | undefined {
  if (!uri) return undefined;
  let cleaned = uri.trim();
  if (cleaned.startsWith('file:///')) {
    cleaned = decodeURIComponent(cleaned.slice('file:///'.length));
  } else if (cleaned.startsWith('file://')) {
    cleaned = decodeURIComponent(cleaned.slice('file://'.length));
  }
  cleaned = cleaned.replace(/[\\/]+$/, '');
  if (!cleaned) return undefined;
  const parts = cleaned.split(/[\\/]/);
  const name = parts[parts.length - 1] || cleaned;
  return { path: cleaned, name };
}

function parseWorkspaceHintFromStep(step: RawTranscriptStep): { path: string; name: string } | undefined {
  // 1. Check workspaceUris inside invoke_subagent result
  if (typeof step.content === 'string' && step.content.includes('workspaceUris')) {
    const m = step.content.match(/"workspaceUris"\s*:\s*\[\s*"([^"]+)"/);
    if (m?.[1]) return extractWorkspaceFromUri(m[1]);
  }
  // 2. Check read_file / write_file / edit_file paths (skip .gemini/antigravity internal paths)
  if (Array.isArray(step.tool_calls)) {
    for (const tc of step.tool_calls) {
      const rawPath = unquoteArg(tc.args?.Path ?? tc.args?.Cwd ?? '');
      if (!rawPath || rawPath.includes('.gemini') || rawPath.includes('AppData')) continue;
      const normalized = rawPath.replace(/\\/g, '/');
      const segs = normalized.split('/').filter(Boolean);
      if (segs.length >= 3) {
        // Take first 3 segments on Windows e.g. d:/Documents/Antigravity/project or parent dir
        const dirPath = segs.slice(0, Math.min(4, segs.length - 1)).join('/');
        const name = segs[Math.min(3, segs.length - 2)] || segs[segs.length - 2];
        if (name) return { path: dirPath.toLowerCase(), name };
      }
    }
  }
  return undefined;
}

function parseAskQuestionCall(
  tc: RawToolCall,
  resultContent: string | undefined,
  stepIdx: number,
  locale: ChronoLocale,
): AgentChoicePrompt[] {
  const rawQuestions = parseJsonArg<Array<Record<string, unknown>>>(tc.args?.questions);
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return [];

  const answered = Boolean(resultContent && resultContent.trim().length > 0);
  const status: AgentChoicePrompt['status'] = answered ? 'answered' : 'waiting';

  return rawQuestions.map((q, idx) => {
    const question = String(
      q.question ?? (locale === 'en' ? `Question ${idx + 1}` : `问题 ${idx + 1}`),
    ).trim();
    const rawOpts = Array.isArray(q.options) ? q.options : [];
    const options: AgentChoiceOption[] = rawOpts.map((o) => {
      const label = typeof o === 'string' ? o : String((o as { label?: string })?.label ?? o);
      const selected = Boolean(answered && resultContent && resultContent.includes(label));
      return { label, selected };
    });
    const selectedAnswers = options.filter((o) => o.selected).map((o) => o.label);
    return {
      id: `ag-q-${stepIdx}-${idx}`,
      question,
      multiSelect: Boolean(q.is_multi_select),
      options,
      selectedAnswers,
      customAnswer: answered && selectedAnswers.length === 0 && resultContent ? resultContent.slice(0, 280) : undefined,
      status,
    };
  });
}

function loadFullContentMap(fullPath: string, neededStepIndices: Set<number>): Map<number, string> {
  const result = new Map<number, string>();
  if (neededStepIndices.size === 0 || !fs.existsSync(fullPath)) return result;
  try {
    const raw = fs.readFileSync(fullPath, 'utf8');
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      // Fast regex pre-check before JSON.parse so huge full transcripts stay instant
      const m = line.match(/"step_index"\s*:\s*(\d+)/);
      if (!m) continue;
      const idx = Number(m[1]);
      if (!neededStepIndices.has(idx)) continue;
      try {
        const obj = JSON.parse(line) as RawTranscriptStep;
        if (typeof obj.content === 'string') {
          result.set(idx, obj.content);
        }
      } catch {
        // Ignore malformed line
      }
      if (result.size >= neededStepIndices.size) break;
    }
  } catch {
    // Ignore read errors
  }
  return result;
}

export class AntigravityTranscriptReader {
  private readonly brainDir: string;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(brainDir: string) {
    this.brainDir = brainDir;
  }

  private transcriptPaths(convId: string): { compact: string; full: string } {
    const logsDir = path.join(this.brainDir, convId, '.system_generated', 'logs');
    return {
      compact: path.join(logsDir, 'transcript.jsonl'),
      full: path.join(logsDir, 'transcript_full.jsonl'),
    };
  }

  /** List all valid conversation IDs under `~/.gemini/antigravity/brain`, newest first. */
  listConversationIds(limit = 60): { id: string; mtimeMs: number; size: number }[] {
    if (!fs.existsSync(this.brainDir)) return [];
    const found: { id: string; mtimeMs: number; size: number }[] = [];
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.brainDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || !UUID_RE.test(ent.name)) continue;
      const { compact } = this.transcriptPaths(ent.name);
      try {
        const st = fs.statSync(compact);
        if (st.isFile() && st.size > 0) {
          found.push({ id: ent.name, mtimeMs: st.mtimeMs, size: st.size });
        }
      } catch {
        // No transcript.jsonl yet
      }
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return found.slice(0, limit);
  }

  parseConversation(convId: string, locale: ChronoLocale): ParsedConversation | null {
    const { compact, full } = this.transcriptPaths(convId);
    let st: fs.Stats;
    try {
      st = fs.statSync(compact);
    } catch {
      return null;
    }

    const cached = this.cache.get(convId);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.locale === locale) {
      return cached.parsed;
    }

    let rawText: string;
    try {
      rawText = fs.readFileSync(compact, 'utf8');
    } catch {
      return null;
    }

    const steps: RawTranscriptStep[] = [];
    const truncatedContentSteps = new Set<number>();
    for (const line of rawText.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as RawTranscriptStep;
        steps.push(obj);
        if (
          typeof obj.step_index === 'number' &&
          Array.isArray(obj.truncated_fields) &&
          obj.truncated_fields.includes('content') &&
          (obj.type === 'PLANNER_RESPONSE' || obj.type === 'USER_INPUT')
        ) {
          truncatedContentSteps.add(obj.step_index);
        }
      } catch {
        // Skip partial trailing line while streaming
      }
    }

    const fullContentMap = loadFullContentMap(full, truncatedContentSteps);
    const msg = getChronoMessages(locale);

    const turns: TurnDraft[] = [];
    const subagents: ParsedSubagentRef[] = [];
    let workspaceHint: { path: string; name: string } | undefined;

    let currentTurn: TurnDraft | null = null;
    let pendingTools: { step: MicroStep; name: string; tc: RawToolCall; stepIdx: number }[] = [];

    const ensureTurn = (seq: number, ms: number, userText: string): TurnDraft => {
      if (!currentTurn) {
        currentTurn = {
          seq,
          startMs: ms,
          endMs: ms,
          userText,
          aiTexts: [],
          aiSegments: [],
          choices: [],
          microSteps: [],
          filesChanged: new Set<string>(),
          toolCount: 0,
          hasError: false,
          running: false,
        };
        turns.push(currentTurn);
      }
      return currentTurn;
    };

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepIdx = typeof step.step_index === 'number' ? step.step_index : i;
      const stepMs = step.created_at ? Date.parse(step.created_at) : st.mtimeMs;
      const content = fullContentMap.get(stepIdx) ?? step.content ?? '';

      if (!workspaceHint) {
        workspaceHint = parseWorkspaceHintFromStep(step);
      }

      if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT') {
        const cleaned = cleanUserContent(content);
        if (!cleaned.isSystemOnly && cleaned.text) {
          pendingTools = [];
          currentTurn = {
            seq: stepIdx,
            startMs: stepMs,
            endMs: stepMs,
            userText: cleaned.text,
            aiTexts: [],
            aiSegments: [],
            choices: [],
            microSteps: [],
            filesChanged: new Set<string>(),
            toolCount: 0,
            hasError: false,
            running: false,
          };
          turns.push(currentTurn);
        }
        continue;
      }

      if (step.type === 'PLANNER_RESPONSE') {
        const turn = ensureTurn(stepIdx, stepMs, locale === 'en' ? '(Continued)' : '（会话延续）');
        (turn as { endMs: number }).endMs = Math.max(turn.endMs, stepMs);
        if (step.status && step.status !== 'DONE' && step.status !== 'ERROR') {
          (turn as { running: boolean }).running = true;
        }

        // Thinking micro-step
        if (typeof step.thinking === 'string' && step.thinking.trim()) {
          turn.microSteps.push({
            id: `think-${convId}-${stepIdx}`,
            kind: 'thinking',
            title: msg.reasoningStepTitle,
            status: step.status === 'DONE' ? 'success' : 'running',
            detail: step.thinking.trim().slice(0, 1200),
          });
        }

        // Tool calls
        if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
          pendingTools = [];
          step.tool_calls.forEach((tc, tcIdx) => {
            const toolName = tc.name || 'tool';
            const kind = classifyToolKind(toolName);
            const argsPreview = tc.args
              ? Object.entries(tc.args)
                  .map(([k, v]) => `${k}: ${unquoteArg(v).slice(0, 220)}`)
                  .join('\n')
              : '';

            if (kind === 'file-diff') {
              const targetPath = unquoteArg(tc.args?.Path);
              if (targetPath) turn.filesChanged.add(targetPath);
            }

            const titleSuffix =
              toolName === 'run_command'
                ? unquoteArg(tc.args?.toolSummary || tc.args?.CommandLine).slice(0, 36)
                : toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file'
                  ? path.basename(unquoteArg(tc.args?.Path))
                  : toolName === 'invoke_subagent'
                    ? unquoteArg(tc.args?.Role || tc.args?.TypeName)
                    : '';

            const microStep: MicroStep = {
              id: `tc-${convId}-${stepIdx}-${tcIdx}`,
              kind,
              title: titleSuffix ? `${toolName} · ${titleSuffix}` : toolName,
              status: step.status === 'ERROR' ? 'error' : 'success',
              detail: argsPreview || undefined,
            };
            turn.microSteps.push(microStep);
            (turn as { toolCount: number }).toolCount += 1;
            pendingTools.push({ step: microStep, name: toolName, tc, stepIdx });
          });
        }

        // Assistant markdown content
        if (content.trim()) {
          turn.aiTexts.push(content.trim());
          turn.aiSegments.push({
            kind: 'markdown',
            id: `md-${convId}-${stepIdx}`,
            text: content.trim(),
          });
        }
        continue;
      }

      if (step.type === 'GENERIC' && currentTurn) {
        (currentTurn as { endMs: number }).endMs = Math.max(currentTurn.endMs, stepMs);
        const matched = pendingTools.shift();
        if (matched) {
          const outPreview = content.trim().slice(0, 1400);
          if (outPreview) {
            const existingDetail = matched.step.detail ? `${matched.step.detail}\n\n--- Output ---\n` : '';
            (matched.step as { detail?: string }).detail = `${existingDetail}${outPreview}`;
          }
          if (step.status === 'ERROR' || /Command exited with code [1-9]/i.test(outPreview)) {
            (matched.step as { status: 'running' | 'success' | 'error' }).status = 'error';
          }

          // Detect subagent spawn -> capture child conversationId
          if (matched.name === 'invoke_subagent') {
            const idMatch = content.match(/"conversationId"\s*:\s*"([0-9a-f-]{36})"/i);
            if (idMatch?.[1] && idMatch[1] !== convId) {
              const role = unquoteArg(matched.tc.args?.Role || matched.tc.args?.TypeName || 'Subagent');
              const typeName = unquoteArg(matched.tc.args?.TypeName || 'subagent');
              subagents.push({
                childId: idMatch[1],
                role,
                typeName,
                parentTurnNodeId: `${convId}:turn:${currentTurn.seq}`,
                parentStepIndex: currentTurn.seq,
              });
            }
          }

          // Detect ask_question -> push structured AgentChoicePrompt
          if (matched.name === 'ask_question') {
            const qs = parseAskQuestionCall(matched.tc, content, matched.stepIdx, locale);
            for (const q of qs) {
              currentTurn.choices.push(q);
              currentTurn.aiSegments.push({ kind: 'choice', id: q.id, choice: q });
            }
          }
        }
        continue;
      }

      if (step.type === 'CHECKPOINT' && currentTurn) {
        currentTurn.microSteps.push({
          id: `cp-${convId}-${stepIdx}`,
          kind: 'thinking',
          title: locale === 'en' ? '/compact Context' : '/compact 压缩上下文',
          status: 'success',
          detail: content.trim().slice(0, 800),
        });
        continue;
      }

      if (step.type === 'ERROR_MESSAGE' && currentTurn) {
        (currentTurn as { hasError: boolean }).hasError = true;
        currentTurn.microSteps.push({
          id: `err-${convId}-${stepIdx}`,
          kind: 'tool-call',
          title: 'Error',
          status: 'error',
          detail: (step.error || content).slice(0, 600),
        });
      }
    }

    // Check if the latest step is still running (recently modified < 4s & last step not DONE)
    const lastStep = steps[steps.length - 1];
    const isRunning = Boolean(
      lastStep && lastStep.status && lastStep.status !== 'DONE' && lastStep.status !== 'ERROR',
    );
    if (isRunning && turns.length > 0) {
      (turns[turns.length - 1] as { running: boolean }).running = true;
    }

    const firstUserText = turns[0]?.userText ?? '';
    const title = firstLineTitle(firstUserText, msg.defaultUntitled);

    const parsed: ParsedConversation = {
      id: convId,
      title,
      updatedAt: st.mtimeMs,
      running: isRunning,
      workspacePath: workspaceHint?.path,
      workspaceName: workspaceHint?.name,
      turns,
      subagents,
    };

    this.cache.set(convId, { mtimeMs: st.mtimeMs, size: st.size, locale, parsed });
    return parsed;
  }

  /**
   * Compute full ChronoGraph + WorkspaceSessionOption[] + recent conversation list
   * for Antigravity, using the exact same union-find linking & fork-family graph semantics as DSH.
   */
  buildGraphResponse(params: {
    requestedConversationId?: string;
    meta: ChronoMetaSnapshot;
    locale: ChronoLocale;
    capabilities: PlatformCapabilities;
  }): {
    graph: ChronoGraph;
    activeConversationId: string;
    workspaceName?: string;
    workspaceSessions: WorkspaceSessionOption[];
    conversations: ConversationSummaryItem[];
  } {
    const { meta, locale, capabilities } = params;
    const msg = getChronoMessages(locale);

    const allFiles = this.listConversationIds(50);
    const parsedMap = new Map<string, ParsedConversation>();
    const subagentChildToParent = new Map<string, { parentId: string; ref: ParsedSubagentRef }>();

    for (const f of allFiles) {
      const p = this.parseConversation(f.id, locale);
      if (p) {
        parsedMap.set(f.id, p);
        for (const sub of p.subagents) {
          subagentChildToParent.set(sub.childId, { parentId: f.id, ref: sub });
        }
      }
    }

    // Resolve active conversation: explicit request > most recent non-subagent conversation > most recent any
    let activeId = params.requestedConversationId?.trim() || '';
    if (!activeId || !parsedMap.has(activeId)) {
      const firstPrimary = allFiles.find((f) => !subagentChildToParent.has(f.id) && parsedMap.has(f.id));
      activeId = firstPrimary?.id ?? allFiles[0]?.id ?? 'empty';
    }

    const conversations: ConversationSummaryItem[] = [];
    for (const f of allFiles) {
      const p = parsedMap.get(f.id);
      if (!p) continue;
      conversations.push({
        id: p.id,
        title: p.title,
        updatedAt: p.updatedAt,
        running: p.running,
        workspaceName: p.workspaceName,
        turnCount: p.turns.length,
        isSubagent: subagentChildToParent.has(p.id),
      });
    }

    // Build fork parent/child adjacency + manual linkGroups component (same logic as dsh-adapter.ts)
    const forkAdj = new Map<string, Set<string>>();
    const addEdge = (map: Map<string, Set<string>>, a: string, b: string) => {
      if (!a || !b || a === b) return;
      if (!map.has(a)) map.set(a, new Set());
      if (!map.has(b)) map.set(b, new Set());
      map.get(a)!.add(b);
      map.get(b)!.add(a);
    };

    for (const [cid, tm] of Object.entries(meta.trackMeta)) {
      if (tm.forkParentId) addEdge(forkAdj, cid, tm.forkParentId);
    }

    const fullAdj = new Map<string, Set<string>>();
    for (const [k, set] of forkAdj.entries()) {
      set.forEach((v) => addEdge(fullAdj, k, v));
    }
    for (const grp of meta.linkGroups) {
      for (let i = 1; i < grp.length; i++) {
        addEdge(fullAdj, grp[0], grp[i]);
      }
    }

    const bfs = (adj: Map<string, Set<string>>, start: string): Set<string> => {
      const visited = new Set<string>([start]);
      const queue = [start];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        const neighbors = adj.get(cur);
        if (!neighbors) continue;
        for (const n of neighbors) {
          if (!visited.has(n)) {
            visited.add(n);
            queue.push(n);
          }
        }
      }
      return visited;
    };

    const forkFamilySet = bfs(forkAdj, activeId);
    const componentSet = bfs(fullAdj, activeId);

    // Find canonical root track (oldest ancestor without forkParentId inside forkFamilySet, or activeId)
    let rootTrackId = activeId;
    const activeForkRootCandidates = Array.from(forkFamilySet).filter((id) => !meta.trackMeta[id]?.forkParentId);
    if (activeForkRootCandidates.length > 0) {
      activeForkRootCandidates.sort(
        (a, b) => (parsedMap.get(a)?.turns[0]?.startMs ?? 0) - (parsedMap.get(b)?.turns[0]?.startMs ?? 0),
      );
      rootTrackId = activeForkRootCandidates[0];
    }

    const componentIds = Array.from(componentSet).filter((id) => id === activeId || parsedMap.has(id));
    componentIds.sort((a, b) => {
      if (a === rootTrackId) return -1;
      if (b === rootTrackId) return 1;
      return (parsedMap.get(a)?.updatedAt ?? 0) - (parsedMap.get(b)?.updatedAt ?? 0);
    });

    const tracks: Record<string, ChronoTrack> = {};
    const nodes: Record<string, ChronoNode> = {};
    const pinnedSet = new Set(meta.pinnedNodeIds);
    const mergeByTargetNode = new Map<string, { trackTitle: string; summary: string }>();

    for (const ml of meta.mergeLinks) {
      const srcTitle = parsedMap.get(ml.sourceTrackId)?.title ?? msg.defaultBranchTitle;
      mergeByTargetNode.set(ml.targetNodeId, { trackTitle: srcTitle, summary: ml.summary });
    }

    let colorIdx = 0;

    const addTrackAndTurns = (
      convId: string,
      opts: {
        kind: ChronoTrack['kind'];
        prefix: string;
        color: string;
        parentTrackId?: string;
        forkFromNodeId?: string;
        titleOverride?: string;
        linkedPeer?: boolean;
      },
    ) => {
      const parsed = parsedMap.get(convId);
      const tMeta = meta.trackMeta[convId];

      tracks[convId] = {
        id: convId,
        kind: opts.kind,
        title: opts.titleOverride || parsed?.title || msg.defaultUntitled,
        status: tMeta?.status ?? 'active',
        parentTrackId: opts.parentTrackId,
        forkFromNodeId: opts.forkFromNodeId,
        color: opts.color,
        collapsed: Boolean(tMeta?.collapsed),
        running: Boolean(parsed?.running),
        hydrated: Boolean(parsed),
        linkedPeer: opts.linkedPeer,
      };

      if (!parsed || parsed.turns.length === 0) {
        const placeholderId = `${convId}:empty`;
        nodes[placeholderId] = {
          id: placeholderId,
          trackId: convId,
          order: 0,
          turnLabel: `${opts.prefix}1`,
          title: parsed?.title || msg.blankSessionUser,
          timestamp: formatClock(parsed?.updatedAt ?? Date.now()),
          status: 'idle',
          userText: msg.blankSessionUser,
          aiSummary: msg.blankSessionSummary,
          aiFullText: msg.blankSessionFull,
          microSteps: [],
          stats: { toolCount: 0, filesChanged: 0 },
          placeholder: true,
        };
        return;
      }

      parsed.turns.forEach((turn, idx) => {
        const nodeId = `${convId}:turn:${turn.seq}`;
        const fullAi = turn.aiTexts.join('\n\n').trim();
        const codeBlock = extractFirstCodeBlock(fullAi);
        const firstChoiceSummary =
          turn.choices.length > 0
            ? `${locale === 'en' ? '[Choice] ' : '【提问选择】'}${turn.choices[0].question}`
            : '';
        const durationMs = turn.endMs > turn.startMs ? turn.endMs - turn.startMs : undefined;

        nodes[nodeId] = {
          id: nodeId,
          trackId: convId,
          order: idx,
          turnLabel: `${opts.prefix}${idx + 1}`,
          title: firstLineTitle(
            turn.userText,
            locale === 'en' ? `Turn ${idx + 1}` : `第 ${idx + 1} 轮对话`,
          ),
          timestamp: formatClock(turn.startMs),
          status: turn.hasError ? 'error' : turn.running ? 'streaming' : 'completed',
          atSeq: turn.seq,
          pinned: pinnedSet.has(nodeId),
          userText: turn.userText,
          aiSummary: summarizeText(
            fullAi ||
              firstChoiceSummary ||
              (turn.running
                ? locale === 'en'
                  ? 'Streaming…'
                  : '正在生成中…'
                : locale === 'en'
                  ? '(Tool calls or system events only)'
                  : '（本轮仅包含工具调用或系统事件）'),
            locale,
            115,
          ),
          aiFullText: fullAi || firstChoiceSummary || msg.noTextOutput,
          aiSegments: turn.aiSegments.length > 0 ? turn.aiSegments : undefined,
          codeLang: codeBlock.lang,
          codeSnippet: codeBlock.snippet,
          microSteps: turn.microSteps,
          choices: turn.choices.length > 0 ? turn.choices : undefined,
          stats: {
            durationMs,
            toolCount: turn.toolCount,
            filesChanged: turn.filesChanged.size,
          },
          mergedFrom: mergeByTargetNode.get(nodeId),
        };
      });
    };

    // 1. Add primary, forked, and manually linked tracks
    let branchSeq = 0;
    let peerSeq = 0;
    for (const cid of componentIds) {
      const tMeta = meta.trackMeta[cid];
      const isRoot = cid === rootTrackId;
      const isFork = !isRoot && Boolean(tMeta?.forkParentId && componentSet.has(tMeta.forkParentId));
      const isPeer = !isRoot && !isFork;

      const color = isRoot
        ? '#27272a'
        : RESTRAINED_BRANCH_PALETTE[colorIdx++ % RESTRAINED_BRANCH_PALETTE.length];

      let prefix = 'M';
      if (isFork) {
        branchSeq += 1;
        prefix = `B${branchSeq}-`;
      } else if (isPeer) {
        peerSeq += 1;
        prefix = `L${peerSeq}-`;
      }

      addTrackAndTurns(cid, {
        kind: isRoot ? 'main' : isFork ? 'human-branch' : 'linked-peer',
        prefix,
        color,
        parentTrackId: isFork ? tMeta?.forkParentId : undefined,
        forkFromNodeId: isFork ? tMeta?.forkFromNodeId : undefined,
        linkedPeer: isPeer,
      });
    }

    // 2. Add real Antigravity subagent swimlanes spawned by any track in this component
    let subSeq = 0;
    for (const cid of componentIds) {
      const parsed = parsedMap.get(cid);
      if (!parsed) continue;
      for (const sub of parsed.subagents) {
        if (tracks[sub.childId]) continue;
        subSeq += 1;
        addTrackAndTurns(sub.childId, {
          kind: 'agent-subagent',
          prefix: `A${subSeq}-`,
          color: '#4f46e5',
          parentTrackId: cid,
          forkFromNodeId: sub.parentTurnNodeId,
          titleOverride: `${sub.role} (${sub.typeName})`,
        });
      }
    }

    // 3. Build workspace session options for the "Link Chats" modal
    const activeParsed = parsedMap.get(activeId);
    const activeWsPath = activeParsed?.workspacePath;
    const workspaceSessions: WorkspaceSessionOption[] = [];
    for (const c of conversations) {
      if (c.isSubagent) continue;
      const p = parsedMap.get(c.id);
      // Include same-workspace conversations, already-linked conversations, or all recent when workspace is unknown
      const sameWorkspace = !activeWsPath || !p?.workspacePath || p.workspacePath === activeWsPath;
      if (!sameWorkspace && !componentSet.has(c.id)) continue;

      const linkKind: WorkspaceSessionOption['linkKind'] =
        c.id === activeId
          ? 'self'
          : forkFamilySet.has(c.id)
            ? 'fork'
            : componentSet.has(c.id)
              ? 'manual'
              : 'none';

      workspaceSessions.push({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        running: c.running,
        linkKind,
      });
    }

    const rank = (k: WorkspaceSessionOption['linkKind']): number =>
      k === 'self' ? 0 : k === 'fork' ? 1 : k === 'manual' ? 2 : 3;
    workspaceSessions.sort((a, b) => {
      const ra = rank(a.linkKind);
      const rb = rank(b.linkKind);
      if (ra !== rb) return ra - rb;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });

    const graph: ChronoGraph = {
      rootTrackId,
      activeTrackId: activeId,
      tracks,
      nodes,
      mergeLinks: meta.mergeLinks.filter((ml) => Boolean(tracks[ml.sourceTrackId] && tracks[ml.targetTrackId])),
      capabilities,
    };

    return {
      graph,
      activeConversationId: activeId,
      workspaceName: activeParsed?.workspaceName,
      workspaceSessions,
      conversations: conversations.filter((c) => !c.isSubagent),
    };
  }
}
