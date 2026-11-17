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
 * Guarda única de escrita em terminal (PR08). Todo Enter que sai do app para um agente sem a pessoa digitar passa
 * aqui: o aviso de parado, o Vigia, os avisos do canvas, os briefings e as respostas tardias.
 *
 * A regra: o agente que está numa pergunta de aprovação ("Do you want to proceed? ❯ 1. Yes") não recebe texto
 * nem Enter de quem não é a pessoa, porque um Enter ali escolhe a opção e aprova sem ela. Trabalhando (spinner,
 * "esc to interrupt", turno aberto no transcript) também não recebe nada. A conferência roda antes de colar e de
 * novo logo antes de cada Enter, porque a TUI pode mudar entre um e outro.
 *
 * Os detectores são os que já existem: `isWaitingForUser` e o "trabalhando" do Vigia (tela + transcript).
 */

/** Quem escreve sem a pessoa digitar agora. Vai ao aviso e ao log. */
export type WriteSource = "vigia" | "stalled" | "peer";

/** O que aconteceu com a escrita. `blocked-*` = o agente não recebeu nada (ou o Enter não saiu). */
export type WriteResult = "sent" | SubmitBlock;

/** Pura: o bloqueio dado o texto da tela e se o destino está trabalhando. Pergunta de aprovação vence o trabalho. */
export function blockFromScreen(lines: readonly string[], working: boolean): SubmitBlock | null {
  if (isWaitingForUser(lines)) return "blocked-waiting-user";
  if (working) return "blocked-busy";
  return null;
}

/**
 * O que impede escrever agora na aba. Sem terminal viva não há para onde escrever: conta como ocupado, e quem
 * chama tenta de novo no próximo ciclo (a assinatura tem só os três resultados).
 */
function blockNow(tabId: string): SubmitBlock | null {
  const screen = screenOf(tabId, null, 200);
  if (!screen) return "blocked-busy";
  return blockFromScreen(screen.lines, workingWith(tabId, isWorking(screen.lines)));
}

/** O último bloqueio avisado por aba: o mesmo bloqueio seguido não vira aviso de novo. */
const avisados = new Map<string, SubmitBlock>();

/** Mostra o aviso de que a mensagem não foi enviada, uma vez por bloqueio. */
export function avisarBloqueio(tabId: string, source: WriteSource, block: SubmitBlock): void {
  if (avisados.get(tabId) === block) return;
  avisados.set(tabId, block);
  const name = useTabsStore.getState().tabs.find((tab) => tab.id === tabId)?.title || tabId;
  const text = block === "blocked-waiting-user"
    ? i18n.t("terminal.write.blockedWaiting", { name })
    : i18n.t("terminal.write.blockedBusy", { name });
  showBotToast({ title: i18n.t("terminal.write.blockedTitle"), text, tone: "warning", ms: 10_000 });
  console.warn(`[escrita:${source}] não enviado para ${name}: ${block}`);
}

/** Limpa o aviso da aba: a próxima mensagem bloqueada voltará a avisar. */
function limparAviso(tabId: string): void {
  avisados.delete(tabId);
}

/** Quem chama mostra o resultado: um aviso se o agente não recebeu, e nada se saiu. */
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
    gate: () => blockNow(tabId),
    onBlocked: (block) => avisarBloqueio(tabId, source, block),
    onSubmitted: () => {
      limparAviso(tabId);
      onSubmitted?.();
    },
  };
}

/**
 * Escreve no agente da aba sem a pessoa digitar. Com `submit`, manda o Enter. Confere antes de colar e de novo
 * logo antes do Enter; com pergunta de aprovação ou trabalho, não envia e devolve o bloqueio. Quem chama mostra o aviso
 * (`mostraResultado`). Resolve no primeiro Enter (os reenvios de um colado grande continuam em segundo plano, sob a
 * mesma conferência).
 */
export async function writeToAgent(tabId: string, text: string, opts: { submit: boolean; source: WriteSource }): Promise<WriteResult> {
  const before = blockNow(tabId);
  if (before) return before;
  return new Promise<WriteResult>((resolve) => {
    if (!opts.submit) {
      resolve(pasteIntoTab(tabId, text, false) ? "sent" : "blocked-busy");
      return;
    }
    const policy: SubmitPolicy = {
      gate: () => blockNow(tabId),
      onBlocked: (block) => resolve(block),
      onSubmitted: () => resolve("sent"),
    };
    if (!pasteIntoTab(tabId, text, true, undefined, policy)) resolve("blocked-busy");
  });
}

/**
 * Manda pela fila de espera da TUI (`sendWhenReady`: espera a TUI ficar quieta e cola) com a conferência de quem manda
 * sem digitar. `source` diz quem é, para o aviso. Quando há bloqueio, a mensagem não sai e o aviso aparece.
 */
export function sendAutonomous(tabId: string, text: string, source: WriteSource, timings?: SendTimings): void {
  sendWhenReady(tabId, text, { ...timings, policy: submitPolicy(tabId, source) });
}
