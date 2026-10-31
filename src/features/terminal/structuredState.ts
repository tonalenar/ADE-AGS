import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Canal estruturado: o estado de cada aba de Claude Code e Codex lido pelo backend do transcript
 * que a própria TUI escreve (ver `src-tauri/src/canal` e `docs/ade-ags/CANAL_ESTRUTURADO.md`).
 *
 * Onde existe, vale mais que a tela; onde não existe (outro agente, sessão sem arquivo, estado
 * velho), quem decide é a tela, exatamente como antes. O modo vem do backend em cada estado:
 * - `off`: nada decide por ele;
 * - `veto` (padrão): só no sentido seguro — turno aberto no transcript conta como trabalhando
 *   mesmo com a tela quieta (menos cutucadas e menos "parado" falso), nunca o contrário;
 * - `full`: o transcript manda nos dois sentidos (turno encerrado vence um spinner velho).
 */

export type StructuredMode = "off" | "veto" | "full";
export type StructuredPhase = "working" | "idle" | "unknown";

export interface StructuredSnapshot {
  tabId: string;
  agentId: string;
  mode: StructuredMode;
  /** A fase que vale (o backend já aplicou o prazo de estado velho). */
  phase: StructuredPhase;
  stale: boolean;
  tools: { id: string; name: string; summary: string; sinceMs: number }[];
  question: { id: string; text: string; options: string[]; sinceMs: number } | null;
  endsWithQuestion: boolean;
  /** Quando o turno atual começou e quando o último acabou (ms; o `TabState` do canal). */
  turnStartedAt?: number | null;
  turnEndedAt?: number | null;
}

/** O evento do backend: um estado novo, ou a aba que deixou de ter canal. */
type StateEvent = StructuredSnapshot | { tabId: string; removed: true };

const states = new Map<string, StructuredSnapshot>();
let started = false;

/** Aplica um evento ao mapa. Pura no mapa recebido (exportada para os testes). */
export function applyStateEvent(map: Map<string, StructuredSnapshot>, event: StateEvent): void {
  if ("removed" in event) map.delete(event.tabId);
  else map.set(event.tabId, event);
}

/** Começa a ouvir o backend (uma vez por janela). Sem Tauri (testes), não faz nada. */
export function startStructuredState(): void {
  if (started) return;
  started = true;
  try {
    invoke<StructuredSnapshot[]>("structured_state_all")
      .then((all) => all.forEach((s) => { if (!states.has(s.tabId)) states.set(s.tabId, s); }))
      .catch(() => undefined);
    listen<StateEvent>("cc-structured-state", (e) => applyStateEvent(states, e.payload)).catch(() => undefined);
  } catch {
    // fora do app (testes): sem canal, decide a tela
  }
}

export function structuredOf(tabId: string): StructuredSnapshot | undefined {
  return states.get(tabId);
}

/**
 * Pura: o veredito do transcript sobre "trabalhando". `null` = não sabe (sem canal, modo off,
 * fase desconhecida ou estado velho), e aí vale a tela.
 */
export function structuredVerdict(snapshot: StructuredSnapshot | undefined): boolean | null {
  if (!snapshot || snapshot.mode === "off" || snapshot.stale || snapshot.phase === "unknown") return null;
  return snapshot.phase === "working";
}

/**
 * Pura: junta a tela com o transcript. Em `veto`, o transcript só soma ("trabalhando" se
 * qualquer um dos dois diz); em `full`, ele vence quando sabe. Sem veredito, só a tela.
 */
export function combineWorking(screen: boolean, verdict: boolean | null, mode: StructuredMode | undefined): boolean {
  if (verdict === null || mode === undefined || mode === "off") return screen;
  if (mode === "full") return verdict;
  return screen || verdict;
}

/** "Trabalhando" para esta aba: a tela (`screenWorking`) combinada com o transcript, se houver. */
export function workingWith(tabId: string, screenWorking: boolean): boolean {
  const snapshot = states.get(tabId);
  return combineWorking(screenWorking, structuredVerdict(snapshot), snapshot?.mode);
}

/** Só para os testes: zera o mapa e põe estes estados. */
export function setStructuredForTests(list: StructuredSnapshot[]): void {
  states.clear();
  list.forEach((s) => states.set(s.tabId, s));
}
