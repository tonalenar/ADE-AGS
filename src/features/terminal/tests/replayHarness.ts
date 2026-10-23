/**
 * Testes por replay: telas reais (gravadas ou sintetizadas a partir de telas reais) passam, pedaço
 * por pedaço e no tempo em que chegaram, pelo MESMO xterm que o app usa e pelos detectores de verdade.
 * Nada de app, PTY ou relógio real: o tempo é o `atMs` de cada pedaço. Formato e gravador em
 * `docs/ade-ags/REPLAY_TESTES.md`. O harness do Rust lê as mesmas fixtures
 * (`src-tauri/src/ipc/commands/replay_test.rs`).
 */
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";

import { asksToClose } from "@/features/missions/vigiaClosing";
import { loopStep, type LoopWatch } from "@/features/missions/vigiaLoop";
import { screenQuestion } from "@/features/missions/leadStall";
import { findStalls, isWaitingForUser, isWorking, type PendingTask } from "@/features/missions/stalled";
import { activeAgents } from "@/features/terminal/activity";
import { beforeCursor, pasteStillPending, registerTerminal, screenOf, typedTextPending } from "@/features/terminal/terminalRegistry";

export interface ReplayChunk {
  /** Milissegundos desde o começo da gravação. */
  atMs: number;
  /** Os bytes como texto (UTF-8 válido), com os escapes ANSI no lugar. */
  data?: string;
  /** Os bytes exatos em base64, quando não são UTF-8 válido sozinhos. */
  b64?: string;
  /** O fim do scrollback de antes da gravação começar (o que já estava na tela). */
  prelude?: boolean;
}

export interface ReplayCheckpoint {
  atMs: number;
  /** Começo da janela de "saída nova" (`fresh`, `enterRetry`, `arrived`). */
  since?: number;
  label?: string;
  expect: Record<string, boolean | string>;
  /** Falha conhecida: o detector daquele lado AINDA erra estas chaves. Estrito: se acertar, o teste avisa. */
  xfail?: { rust?: string[]; ts?: string[]; reason: string };
}

export interface ReplayFixture {
  format: "ade-replay";
  version: 1;
  id: string;
  agent: string;
  title: string;
  origin: {
    kind: "synthesized" | "recorded";
    basis: string;
    recordedAt: string | null;
    platform: string | null;
    tuiVersion: string | null;
  };
  terminal: { cols: number; rows: number };
  /** O texto que o ADE colou (para `typedPending`, `textShown`, `enterRetry`, `arrived`). */
  message?: string;
  /** A tarefa que o Orquestrador mandou (para `stalled`). */
  task?: { atMs: number };
  chunks: ReplayChunk[];
  checkpoints: ReplayCheckpoint[];
}

/** As chaves que o harness do Rust avalia. */
export const RUST_KEYS = ["working", "pastePending", "typedPending", "textShown", "fresh", "enterRetry", "arrived", "screenContains"] as const;
/** As chaves que este harness avalia. */
export const TS_KEYS = ["working", "pastePending", "typedPending", "waitingApproval", "screenQuestion", "asksToClose", "stalled", "loopSuspect", "screenContains"] as const;
const KNOWN = new Set<string>([...RUST_KEYS, ...TS_KEYS]);
const NEEDS_MESSAGE = new Set(["typedPending", "textShown", "enterRetry", "arrived"]);
const NEEDS_SINCE = new Set(["fresh", "enterRetry", "arrived"]);

/** Erros de formato de uma fixture (vazio = válida). Pura. */
export function fixtureErrors(f: ReplayFixture): string[] {
  const errors: string[] = [];
  if (f.format !== "ade-replay" || f.version !== 1) errors.push("format/version devem ser \"ade-replay\"/1");
  if (!f.id || !f.agent || !f.title) errors.push("id, agent e title são obrigatórios");
  if (f.origin?.kind !== "synthesized" && f.origin?.kind !== "recorded") errors.push("origin.kind deve ser synthesized ou recorded");
  if (!f.origin?.basis?.trim()) errors.push("origin.basis: de onde veio a tela");
  if (f.origin?.kind === "recorded" && !f.origin.recordedAt) errors.push("gravada sem origin.recordedAt");
  if (!(f.terminal?.cols > 0 && f.terminal?.rows > 0)) errors.push("terminal.cols/rows");
  let last = -1;
  f.chunks.forEach((c, i) => {
    if ((c.data === undefined) === (c.b64 === undefined)) errors.push(`chunk ${i}: exatamente um de data/b64`);
    if (!(c.atMs >= last)) errors.push(`chunk ${i}: atMs fora de ordem`);
    last = c.atMs;
  });
  last = -1;
  f.checkpoints.forEach((cp, i) => {
    const where = `checkpoint ${i} (${cp.label ?? cp.atMs})`;
    if (!(cp.atMs >= last)) errors.push(`${where}: atMs fora de ordem`);
    last = cp.atMs;
    const keys = Object.keys(cp.expect ?? {});
    if (keys.length === 0) errors.push(`${where}: expect vazio`);
    for (const key of keys) {
      if (!KNOWN.has(key)) errors.push(`${where}: chave desconhecida "${key}"`);
      if (NEEDS_MESSAGE.has(key) && f.message === undefined) errors.push(`${where}: "${key}" precisa de message`);
      if (NEEDS_SINCE.has(key) && !(cp.since !== undefined && cp.since < cp.atMs)) errors.push(`${where}: "${key}" precisa de since < atMs`);
      if (key === "stalled" && !f.task) errors.push(`${where}: "stalled" precisa de task`);
    }
    for (const key of [...(cp.xfail?.rust ?? []), ...(cp.xfail?.ts ?? [])]) {
      if (!keys.includes(key)) errors.push(`${where}: xfail de "${key}", que não está no expect`);
    }
    if (cp.xfail && !cp.xfail.reason?.trim()) errors.push(`${where}: xfail sem reason`);
  });
  return errors;
}

function bytesOf(chunk: ReplayChunk): string | Uint8Array {
  if (chunk.data !== undefined) return chunk.data;
  return Uint8Array.from(atob(chunk.b64 ?? ""), (ch) => ch.charCodeAt(0));
}

/** Um instante qualquer fixo: o relógio falso começa aqui (nunca 0, que os detectores tratam como "nunca"). */
export const REPLAY_EPOCH = Date.UTC(2026, 9, 1, 12, 0, 0);

/** O que os detectores do front dizem da tela no instante atual do replay. */
export type TsVerdict = Record<(typeof TS_KEYS)[number], boolean | string>;

/** A tela de uma fixture num xterm de verdade (o mesmo do app, com Unicode 11), avançada por um relógio falso. */
export class ScreenReplay {
  readonly tabId: string;
  private readonly term: Terminal;
  private readonly unregister: () => void;
  private next = 0;
  private lastOutputAt: number | undefined;
  private loop: LoopWatch | undefined;

  constructor(private readonly fixture: ReplayFixture) {
    this.tabId = `replay:${fixture.id}`;
    this.term = new Terminal({ cols: fixture.terminal.cols, rows: fixture.terminal.rows, scrollback: 5000, allowProposedApi: true });
    try {
      this.term.loadAddon(new Unicode11Addon());
      this.term.unicode.activeVersion = "11";
    } catch {
      // Sem o addon as larguras são as do Unicode 6: pior, não fatal (igual ao app).
    }
    this.unregister = registerTerminal(this.tabId, this.term);
  }

  /** Escreve os pedaços até `atMs` (inclusive), um tique do vigia de laço por pedaço. */
  async advanceTo(atMs: number): Promise<void> {
    const chunks = this.fixture.chunks;
    while (this.next < chunks.length && chunks[this.next].atMs <= atMs) {
      const chunk = chunks[this.next++];
      await new Promise<void>((done) => this.term.write(bytesOf(chunk), done));
      this.lastOutputAt = REPLAY_EPOCH + chunk.atMs;
      this.tickLoop(chunk.atMs);
    }
  }

  private tickLoop(atMs: number): void {
    this.loop = loopStep(this.loop, screenOf(this.tabId)?.lines ?? null, REPLAY_EPOCH + atMs).next;
  }

  /** Avalia os detectores no instante `atMs` (depois de `advanceTo`). */
  verdict(atMs: number): TsVerdict {
    this.tickLoop(atMs);
    const now = REPLAY_EPOCH + atMs;
    const lines = screenOf(this.tabId)?.lines ?? [];
    const message = this.fixture.message ?? "";
    const task = this.fixture.task;
    let stalled = false;
    if (task) {
      const pending = new Map<string, PendingTask>([[this.tabId, { tabId: this.tabId, fromTabId: "lead", at: REPLAY_EPOCH + task.atMs, alerted: false }]]);
      const outputs = new Map(this.lastOutputAt === undefined ? [] : [[this.tabId, this.lastOutputAt]]);
      stalled = findStalls(pending, {
        now,
        isActive: (id) => activeAgents(outputs, now).includes(id),
        lastOutputAt: () => this.lastOutputAt,
        lastInputAt: () => undefined,
        screen: (id) => screenOf(id)?.lines ?? null,
      }).length > 0;
    }
    return {
      working: isWorking(lines),
      pastePending: pasteStillPending(screenOf(this.tabId, null, 12)?.lines ?? []),
      typedPending: typedTextPending(beforeCursor(this.term), message),
      waitingApproval: isWaitingForUser(lines),
      screenQuestion: screenQuestion(lines) !== null,
      asksToClose: asksToClose(lines),
      stalled,
      loopSuspect: this.loop?.reportedAt !== undefined,
      screenContains: lines.join("\n"),
    };
  }

  dispose(): void {
    this.unregister();
    this.term.dispose();
  }
}

/** Uma divergência entre a fixture e os detectores. */
export interface Mismatch {
  atMs: number;
  label: string;
  key: string;
  expected: boolean | string;
  actual: boolean | string;
  xfail: boolean;
}

/** Roda a fixture inteira e devolve as divergências (vazio = passou). */
export async function replayTs(fixture: ReplayFixture): Promise<Mismatch[]> {
  const replay = new ScreenReplay(fixture);
  const out: Mismatch[] = [];
  try {
    for (const cp of fixture.checkpoints) {
      await replay.advanceTo(cp.atMs);
      const verdict = replay.verdict(cp.atMs);
      for (const [key, expected] of Object.entries(cp.expect)) {
        if (!(TS_KEYS as readonly string[]).includes(key)) continue;
        const actual = verdict[key as keyof TsVerdict];
        const ok = key === "screenContains" ? String(actual).includes(String(expected)) : actual === expected;
        const xfail = cp.xfail?.ts?.includes(key) ?? false;
        // xfail é estrito: o detector ainda erra; se passou a acertar, é para tirar a marca.
        if (ok === xfail) out.push({ atMs: cp.atMs, label: cp.label ?? "", key, expected, actual: key === "screenContains" ? "(tela abaixo)" : actual, xfail });
      }
    }
  } finally {
    replay.dispose();
  }
  return out;
}

/** O que os detectores diziam depois de cada pedaço: ajuda a escrever os checkpoints de uma gravação nova. */
export async function timeline(fixture: ReplayFixture): Promise<string> {
  const replay = new ScreenReplay(fixture);
  const rows: string[] = [];
  try {
    for (const chunk of fixture.chunks) {
      await replay.advanceTo(chunk.atMs);
      const { screenContains: _screen, ...flags } = replay.verdict(chunk.atMs);
      const on = Object.entries(flags).filter(([, v]) => v === true).map(([k]) => k);
      rows.push(`${String(chunk.atMs).padStart(8)} ms  ${on.join(" ") || "-"}`);
    }
  } finally {
    replay.dispose();
  }
  return rows.join("\n");
}
