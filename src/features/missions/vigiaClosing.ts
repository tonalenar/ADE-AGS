import { isWorking } from "./stalled";

/**
 * Fechamento antecipado: o Orquestrador encerrou o turno pedindo autorização para commit, push, PR ou
 * "posso concluir?" enquanto um integrante ainda trabalha (ou ainda deve o relatório de uma tarefa). É o caso
 * clássico de supervisão: o Vigia lembra o Orquestrador de esperar a entrega antes de fechar.
 * Tudo aqui é puro; o relógio, as telas e o envio ficam em `vigia.ts`.
 */

/** Quantas linhas do fim da tela do Orquestrador contam como "o que ele acabou de dizer". */
const TAIL = 22;

/** Frases em que o agente pede ao usuário o OK para fechar o trabalho (pt/en). */
const ASKS_TO_CLOSE = new RegExp([
  "posso\\s+(fazer|dar|seguir|prosseguir|abrir|publicar|enviar|subir|mergear|concluir|finalizar)",
  "\\bpode\\s+(fazer|seguir|prosseguir|abrir|publicar|enviar|subir|concluir|finalizar)\\b.*\\?",
  "\\bquer que eu\\s+(fa[çc]a|abra|publique|envie|suba|conclua|finalize|d[êe])",
  "\\bdevo\\s+(fazer|abrir|publicar|enviar|subir|concluir|finalizar)",
  "(aguardo|preciso d[ea]|espero)\\s+(a\\s+|sua\\s+|seu\\s+)?(autoriza|aprova|ok\\b|confirma)",
  "pedido de autoriza",
  "o que precisa da sua autoriza",
  "\\b(shall|should|can|may)\\s+I\\s+(commit|push|open|merge|publish|go ahead|proceed)",
  "\\bwant me to\\s+(commit|push|open|merge|publish)",
].join("|"), "i");

/** O Orquestrador acabou de pedir o OK para fechar? Só vale com o turno encerrado (não escrevendo). Pura. */
export function asksToClose(leadLines: readonly string[] | null | undefined): boolean {
  const lines = (leadLines ?? []).slice(-TAIL);
  if (lines.length === 0 || isWorking(lines)) return false;
  // Ignora a caixa de entrada (sugestão em cinza) e as dicas de rodapé do TUI.
  const text = lines.filter((l) => !/^\s*[❯›>]\s/.test(l) && !/shift\+tab|auto mode|esc to/i.test(l)).join("\n");
  return ASKS_TO_CLOSE.test(text);
}

export interface ClosingMember {
  name: string;
  /** A tela dele mostra que está trabalhando agora. */
  working: boolean;
  /** Recebeu uma tarefa e ainda não mandou o relatório final. */
  owesReport: boolean;
}

export interface ClosingFinding {
  /** Os integrantes que ainda não entregaram. */
  names: string[];
  /** O que vai ao chat. */
  stuck: string;
  /** O lembrete que vai ao Orquestrador. */
  nudge: string;
}

/**
 * Há fechamento antecipado? Sim quando o Orquestrador pede o OK para fechar e algum integrante ainda trabalha ou
 * deve o relatório. `null` se não pediu ou se todos entregaram. Pura.
 */
export function prematureClosing(input: { leadLines: readonly string[] | null | undefined; members: readonly ClosingMember[] }): ClosingFinding | null {
  if (!asksToClose(input.leadLines)) return null;
  const busy = input.members.filter((m) => m.working || m.owesReport);
  if (busy.length === 0) return null;
  const names = busy.map((m) => m.name);
  const list = names.join(", ");
  const verb = busy.some((m) => m.working) ? "ainda trabalha" : "ainda não entregou o relatório";
  return {
    names,
    stuck: `o Orquestrador pediu autorização para fechar, mas ${list} ${busy.length > 1 ? "ainda não entregaram" : verb}.`,
    nudge: `Você pediu autorização para fechar (commit, push ou PR), mas ${list} ${busy.length > 1 ? "ainda não entregaram" : verb}. `
      + "Não conclua nem peça o OK ao usuário ainda: espere o relatório final de cada um (`ags peer ask \"<nome>\" \"status\"` ou `ags peer check \"<nome>\"`), "
      + "incorpore o resultado e só então apresente o resumo final. Se você já considerou isso, ignore este aviso.",
  };
}
