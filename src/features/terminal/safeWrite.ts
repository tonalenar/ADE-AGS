import i18n from "i18next";

import { isWaitingForUser, isWorking } from "@/features/missions/stalled";
import { useTabsStore } from "@/features/tabs/store";
import { showBotToast } from "@/shared/brand/botToastStore";

import { workingWith } from "./structuredState";
import {
  pasteIntoTab,
  screenOf,
  sendWhenReady,
  type SendTimings,
  type SubmitBlock,
  type SubmitPolicy,
} from "./terminalRegistry";

/**
 * Guarda única de escrita em terminal (PR08). Todo Enter que o app manda a um agente sem a pessoa digitar passa
 * aqui: o aviso de parado, o Vigia, os avisos do canvas, os briefings e as respostas tardias.
 *
 * A regra: o agente que está numa pergunta de aprovação ("Do you want to proceed? ❯ 1. Yes") não recebe texto
 * nem Enter de quem não é a pessoa, porque um Enter ali escolhe a opção e aprova sem ela. Trabalhando (spinner,
 * "esc to interrupt", turno aberto no transcript) também não recebe nada. A conferência roda antes de colar e de
 * novo antes de cada Enter, porque a TUI pode mudar entre um e outro.
 *
 * Os detectores são os que já existem: `isWaitingForUser` e o "trabalhando" do Vigia (tela + transcript).
 *
 * Resultados (`WriteResult`):
 * - `sent`: o Enter saiu e a caixa foi conferida, sem o texto (confirmado).
 * - `blocked-waiting-user` / `blocked-busy`: barrado antes de colar. Nada entrou; quem chama pode tentar depois.
 * - `unconfirmed`: o texto entrou na caixa e o envio não foi confirmado (Enter barrado depois de colar, ou os reenvios
 *   acabaram). Não se cola de novo: duplicaria o texto. Quem chama avisa e não repete.
 * - `no-terminal`: não há terminal viva para a aba.
 */

/** Quem escreve sem a pessoa digitar agora. Vai ao aviso e ao log. */
export type WriteSource = "vigia" | "stalled" | "peer";

/** O que aconteceu com a escrita. */
export type WriteResult = "sent" | "unconfirmed" | SubmitBlock | "no-terminal";

/** Pura: o bloqueio dado o texto da tela e se o destino está trabalhando. Pergunta de aprovação vence o trabalho. */
export function blockFromScreen(lines: readonly string[], working: boolean): SubmitBlock | null {
  if (isWaitingForUser(lines)) return "blocked-waiting-user";
  if (working) return "blocked-busy";
  return null;
}

/** A conferência no momento do Enter: sem terminal (sumiu no meio) não há como enviar, conta como ocupado. */
function gateNow(tabId: string): SubmitBlock | null {
  const screen = screenOf(tabId, null, 200);
  if (!screen) return "blocked-busy";
  return blockFromScreen(screen.lines, workingWith(tabId, isWorking(screen.lines)));
}

/** A conferência antes de colar: sem terminal viva, é `no-terminal`; senão, o bloqueio da tela, se houver. */
function preWriteNow(tabId: string): WriteResult | null {
  if (!screenOf(tabId, null, 1)) return "no-terminal";
  return gateNow(tabId);
}

/** O último aviso mostrado por aba: o mesmo resultado seguido não vira aviso de novo. */
const avisados = new Map<string, Exclude<WriteResult, "sent">>();

/**
 * Mostra o aviso de que a mensagem não foi enviada, uma vez por resultado. O texto diz se o app tenta de novo sozinho
 * (vigia e aviso de parado reagendam) ou se a pessoa precisa reenviar.
 */
export function avisarBloqueio(tabId: string, source: WriteSource, result: Exclude<WriteResult, "sent">): void {
  if (avisados.get(tabId) === result) return;
  avisados.set(tabId, result);
  const name = useTabsStore.getState().tabs.find((tab) => tab.id === tabId)?.title || tabId;
  const base = result === "blocked-waiting-user" ? "terminal.write.blockedWaiting"
    : result === "blocked-busy" ? "terminal.write.blockedBusy"
    : result === "no-terminal" ? "terminal.write.noTerminal"
    : "terminal.write.unconfirmed";
  // O app só reagenda sozinho o que não entrou na caixa (vigia e aviso de parado). Texto na caixa ou sem terminal, não.
  const auto = (source === "vigia" || source === "stalled") && (result === "blocked-waiting-user" || result === "blocked-busy");
  const hint = result === "no-terminal" ? ""
    : i18n.t(auto ? "terminal.write.retryAuto" : "terminal.write.retryManual");
  const text = `${i18n.t(base, { name })} ${hint}`.trim();
  showBotToast({ title: i18n.t("terminal.write.blockedTitle"), text, tone: "warning", ms: 10_000 });
  console.warn(`[escrita:${source}] não confirmado para ${name}: ${result}`);
}

/** Limpa o aviso da aba: a próxima falha volta a avisar. */
function limparAviso(tabId: string): void {
  avisados.delete(tabId);
}

/** Quem chama mostra o resultado: nada se saiu confirmado; um aviso no resto. */
export function mostraResultado(tabId: string, source: WriteSource, result: WriteResult): void {
  if (result === "sent") limparAviso(tabId);
  else avisarBloqueio(tabId, source, result);
}

/**
 * A política de quem manda Enter sem digitar: a mesma conferência em cada ponto do registro. Avisa sozinha, porque
 * na fila de espera (`sendWhenReady`) não há retorno para quem chama.
 */
function submitPolicy(tabId: string, source: WriteSource, onSubmitted?: () => void): SubmitPolicy {
  return {
    gate: () => gateNow(tabId),
    onBlocked: (block, pasted) => avisarBloqueio(tabId, source, pasted ? "unconfirmed" : block),
    onSubmitted: () => onSubmitted?.(),
    onConfirmed: () => limparAviso(tabId),
    onUnconfirmed: () => avisarBloqueio(tabId, source, "unconfirmed"),
  };
}

/**
 * Escreve no agente da aba sem a pessoa digitar. Com `submit`, manda o Enter e espera a confirmação: resolve `sent`
 * só quando a caixa já não segura o texto. Quem chama mostra o resultado (`mostraResultado`).
 */
export async function writeToAgent(tabId: string, text: string, opts: { submit: boolean; source: WriteSource }): Promise<WriteResult> {
  const before = preWriteNow(tabId);
  if (before) return before;
  return new Promise<WriteResult>((resolve) => {
    if (!opts.submit) {
      resolve(pasteIntoTab(tabId, text, false) ? "sent" : "no-terminal");
      return;
    }
    const policy: SubmitPolicy = {
      gate: () => gateNow(tabId),
      // Antes de colar, nada entrou e o chamador pode tentar depois. Depois de colar, o texto está na caixa.
      onBlocked: (block, pasted) => resolve(pasted ? "unconfirmed" : block),
      onConfirmed: () => resolve("sent"),
      onUnconfirmed: () => resolve("unconfirmed"),
    };
    if (!pasteIntoTab(tabId, text, true, undefined, policy)) resolve("no-terminal");
  });
}

/**
 * Manda pela fila de espera da TUI (`sendWhenReady`: espera a TUI ficar quieta e cola) com a conferência de quem manda
 * sem digitar. `source` diz quem é, para o aviso. Quando há bloqueio, a mensagem não sai e o aviso aparece.
 */
export function sendAutonomous(tabId: string, text: string, source: WriteSource, timings?: SendTimings): void {
  sendWhenReady(tabId, text, { ...timings, policy: submitPolicy(tabId, source) });
}
