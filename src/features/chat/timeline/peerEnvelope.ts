/**
 * O envelope de uma mensagem entre agentes, como o backend a escreve no terminal do destino
 * (`ipc/commands/peers.rs::framed` + `util/untrusted.rs`). O MODELO recebe tudo (cabeçalho, aviso de
 * segurança, tag `untrusted_data` e a dica de resposta); a TELA mostra só o corpo, do agente certo.
 *
 * Forma conhecida (pode vir precedida de `[reenvio; …]` e seguida do aviso de fila velha):
 *
 *   [Mensagem de Codex · Revisor via ADE AGS] <aviso>
 *   <untrusted_data source="peer:Codex · Revisor">
 *   corpo
 *   </untrusted_data>
 *   (Para responder, use: ags peer tell "…" "<mensagem>")
 *
 * Sem o bloco (mensagem antiga), o corpo é o texto depois do cabeçalho, sem a dica final. Puro.
 */
export interface PeerMessage {
  /** O nome como o remetente aparece ("Codex · Revisor"). */
  sender: string;
  body: string;
}

const HEAD = /^\s*(?:\[reenvio[^\]]*\]\s*)?\[Mensagem de (.+?) via ADE AGS\]\s*/;
const OPEN = /<untrusted_data(?:\s[^>]*)?>\n?/i;
const CLOSE = "</untrusted_data>";
const HINT = /\n\((?:Para responder|Responda normalmente)[\s\S]*\)\s*$/;

export function parsePeerEnvelope(text: string): PeerMessage | null {
  const head = HEAD.exec(text);
  if (!head) return null;
  const sender = head[1]!.trim();
  const rest = text.slice(head[0].length);
  const open = OPEN.exec(rest);
  let body: string;
  if (open) {
    const from = open.index + open[0].length;
    const end = rest.toLowerCase().lastIndexOf(CLOSE);
    body = end >= from ? rest.slice(from, end) : rest.slice(from);
  } else {
    body = rest.replace(HINT, "");
  }
  body = body.trim();
  return sender && body ? { sender, body } : null;
}

/** O agente de um remetente "Codex · Revisor": a parte antes do " · " (o resto é o papel). */
export function senderAgent(sender: string): string {
  return sender.split(" · ")[0]!.trim();
}
