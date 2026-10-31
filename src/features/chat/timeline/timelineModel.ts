import type { PlanStep, TimelineItem } from "./types";
import { displayUserText } from "./userMessage";

/**
 * Os itens da timeline agrupados em turnos, como o T3 Code (e a prancheta 2) desenham: a mensagem
 * da pessoa, logo abaixo o fold "Trabalhou por …" com o trabalho do turno (ferramentas em blocos e
 * falas intermediárias), e fora do fold a resposta final e os arquivos alterados. Puro.
 */

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

export type BodyRow =
  | { type: "assistant"; key: string; item: TimelineItem }
  /** Ferramentas em sequência (sem fala no meio). */
  | { type: "work"; key: string; tools: TimelineItem[] }
  /** Comandos `ags …` do time (peer, team, roles…): bastidor, uma linha só dentro do fold. */
  | { type: "infra"; key: string; tools: TimelineItem[] }
  /** Uma pergunta do agente ainda sem resposta. */
  | { type: "question"; key: string; item: TimelineItem };

/** Como o turno acabou. `error` é o texto do `turnEnd`: o motivo de um turno que falhou ou que o processo derrubou. */
export interface TurnEnd {
  durationMs: number | null;
  interrupted: boolean;
  error: string | null;
  files: ChangedFile[];
  /** O turno não acabou: chegou outra mensagem da pessoa no meio dele (steer, fila) e o trabalho segue no turno dela. */
  superseded?: boolean;
}

/**
 * O desfecho para a tela. Erro vence "interrompido": se o processo caiu, a pessoa não parou nada; só é
 * "interrompido" o que ela mesma interrompeu.
 */
export function endOutcome(end: Pick<TurnEnd, "interrupted" | "error">): "error" | "interrupted" | "done" {
  if (end.error) return "error";
  return end.interrupted ? "interrupted" : "done";
}

export interface Turn {
  key: string;
  /** A mensagem da pessoa (ausente quando o arquivo começa no meio de um turno). */
  user: TimelineItem | null;
  /** Quando o turno começou, mesmo que a mensagem que o abriu não apareça (injeção do ADE). */
  startedAt?: number;
  /** O trabalho do turno, na ordem. */
  body: BodyRow[];
  /** A última fala de um turno encerrado: fica fora do fold. */
  final: TimelineItem | null;
  /** `null` = turno em aberto. */
  end: TurnEnd | null;
  /** O último plano que o agente publicou no turno (TodoWrite, `update_plan`). */
  plan: PlanStep[] | null;
  /** Um aviso do app no fio (não é um turno de verdade: sem mensagem, trabalho nem fim). */
  notice?: TimelineItem;
}

/** Soma as edições por arquivo, na ordem em que apareceram. */
export function changedFiles(tools: TimelineItem[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const tool of tools) {
    if ((tool.tool !== "edit" && tool.tool !== "write") || !tool.path || tool.status === "denied" || tool.status === "error") continue;
    const entry = byPath.get(tool.path) ?? { path: tool.path, added: 0, removed: 0 };
    entry.added += tool.added ?? 0;
    entry.removed += tool.removed ?? 0;
    byPath.set(tool.path, entry);
  }
  return [...byPath.values()];
}

const INFRA_VERBS = "peers?|team|roles?|tabs?|notify|portal|chat|inbox|events|watch|handoff|memory|msg|note|notes|mission|fleet|squad";
const INFRA_COMMAND = new RegExp(`(?:^|[\\s;&|(\`])ags(?:\\.exe)?\\s+(?:${INFRA_VERBS})\\b`);

/** É um comando `ags …` de infraestrutura do time (bastidor)? Olha o comando inteiro, não só o começo. Pura. */
export function isInfraCommand(tool: TimelineItem): boolean {
  return tool.tool === "command" && INFRA_COMMAND.test(tool.label ?? "");
}

export function timelineTurns(items: TimelineItem[]): Turn[] {
  const turns: Turn[] = [];
  let turn: Turn | null = null;
  let tools: TimelineItem[] = [];
  const open = (user: TimelineItem | null, key: string): Turn => {
    tools = [];
    const fresh: Turn = { key, user, body: [], final: null, end: null, plan: null };
    turns.push(fresh);
    return fresh;
  };
  /** Fecha o turno com o fim dado: a última fala, se o turno terminou nela, sai do fold. */
  const close = (current: Turn, end: TurnEnd) => {
    current.end = end;
    const last = current.body[current.body.length - 1];
    if (last?.type === "assistant") {
      current.body.pop();
      current.final = last.item;
    }
  };
  for (const item of items) {
    // Raciocínio e tokens alimentam a linha viva, não o fio da conversa.
    if (item.kind === "reasoning" || item.kind === "usage") continue;
    if (item.kind === "notice") {
      // Uma linha própria no fio; não mexe no turno em andamento.
      turns.push({ key: item.id, user: null, body: [], final: null, end: null, plan: null, notice: item });
      continue;
    }
    if (item.kind === "user") {
      // Injeção do ADE e prefixos técnicos ficam fora da tela; o turno existe, sem a bolha.
      const shown = displayUserText(item.text ?? "");
      // Uma injeção no meio de um turno é parte dele: não abre outro.
      if (shown === null && turn !== null) continue;
      // Outra mensagem da pessoa com o turno aberto (steer do Codex/Claude, fila): o anterior não fica
      // «em aberto» para sempre. Fecha ao ser superado, e o fim de verdade vai para o turno que tem a resposta.
      if (turn !== null) close(turn, { durationMs: null, interrupted: false, error: null, files: changedFiles(tools), superseded: true });
      turn = open(shown === null ? null : { ...item, text: shown }, item.id);
      if (shown === null && item.at !== undefined) turn.startedAt = item.at;
      continue;
    }
    const current: Turn = turn ?? open(null, `start-${item.id}`);
    turn = current;
    if (item.kind === "assistant") {
      current.body.push({ type: "assistant", key: item.id, item });
    } else if (item.kind === "tool") {
      tools.push(item);
      if (item.tool === "todo" && item.plan && item.plan.length > 0) current.plan = item.plan;
      if (item.tool === "question") {
        if (item.status === "running") current.body.push({ type: "question", key: item.id, item });
        continue;
      }
      const type = isInfraCommand(item) ? "infra" : "work";
      const last = current.body[current.body.length - 1];
      if (last?.type === type) last.tools.push(item);
      else current.body.push({ type, key: item.id, tools: [item] });
    } else if (item.kind === "turnEnd") {
      // Sem a duração no arquivo, a conta é do prompt até o fim.
      const start = current.user?.at ?? current.startedAt;
      const durationMs = item.durationMs ?? (start !== undefined && item.at !== undefined ? item.at - start : null);
      close(current, { durationMs, interrupted: !!item.interrupted, error: item.text?.trim() || null, files: changedFiles(tools) });
      turn = null;
      tools = [];
    }
  }
  return turns;
}

/**
 * O complemento de um aviso do app, abaixo da frase fixa (que a tela traduz pelo código): o motivo da sessão que
 * não pôde ser retomada, a mensagem que não foi enviada, a opção que o agente ignorou. `null` = nada a mais. Puro.
 */
export function noticeDetail(item: TimelineItem): string | null {
  const text = item.text?.trim() ?? "";
  if (item.label === "resumeLost") {
    const at = text.indexOf("Motivo: ");
    return at >= 0 ? text.slice(at + "Motivo: ".length).trim() || null : null;
  }
  return text || null;
}

/** Quando começou o turno em aberto (a última mensagem da pessoa sem fim de turno depois). */
export function openTurnStart(items: TimelineItem[]): number | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "turnEnd") return null;
    if (item.kind === "user") return item.at ?? null;
  }
  return null;
}

/** `2m 14s`, `45s`, `1h 3m`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** O nome do arquivo de um caminho, para a linha (o caminho inteiro vai no title). */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
