/**
 * O envelope de uma mensagem entre agentes, como o backend a escreve no terminal do destino
 * (`ipc/commands/peers.rs::framed` + `util/untrusted.rs`). O MODELO recebe tudo (cabeçalho, aviso de
 * segurança, tag `untrusted_data` e a dica de resposta); a TELA mostra só o corpo, do agente certo.
 *
 * Forma conhecida (pode vir precedida de `[reenvio; …]`, ter o número da mensagem no marcador — o do
 * `ags peer receipt` — e vir seguida do aviso de fila velha):
 *
 *   [Mensagem #68 de Codex · Revisor via ADE AGS] <aviso>
 *   <untrusted_data source="peer:Codex · Revisor">
 *   corpo
 *   </untrusted_data>
 *   (Para responder, use: ags peer tell "…" "<mensagem>")
 *
 * Sem o bloco (mensagem antiga), o corpo é o texto depois do cabeçalho, sem a dica final. O pedido tipado
 * (`ags peer tell/ask --task`: "X pediu sua ajuda nisto. Tarefa: … Contexto: …") vira só o conteúdo: a tarefa
 * e, em negrito, os campos que a pessoa que pediu preencheu. O texto cru continua guardado; só a tela o limpa. Puro.
 */
export interface PeerMessage {
  /** O nome como o remetente aparece ("Codex · Revisor"). */
  sender: string;
  /** O conteúdo, em markdown, sem o envelope técnico. */
  body: string;
  /** O número da mensagem (`#68`), para o `ags peer receipt`; `null` nas antigas. */
  id: number | null;
}

const HEAD = /^\s*(?:\[reenvio[^\]]*\]\s*)?\[Mensagem(?: #(\d+))? de (.+?) via ADE AGS\]\s*/;
const OPEN = /<untrusted_data(?:\s[^>]*)?>\n?/i;
const CLOSE = "</untrusted_data>";
const HINT = /\n\((?:Para responder|Responda normalmente)[\s\S]*\)\s*$/;

export function parsePeerEnvelope(text: string): PeerMessage | null {
  const head = HEAD.exec(text);
  if (!head) return null;
  const sender = head[2]!.trim();
  const id = head[1] ? Number(head[1]) : null;
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
  body = typedRequestBody(body.trim());
  return sender && body ? { sender, body, id } : null;
}

const TYPED_OPEN = /^[^\n]+ pediu sua ajuda nisto\.\n/;
const TYPED_CLOSE = /\n?Responda como você mesmo\.\s*$/;
const FIELD = /^(Tarefa|Contexto|Restrições|Como é uma boa resposta): ?(.*)$/;
/** Os valores-padrão que o envelope escreve quando o campo não veio: não dizem nada à pessoa. */
const DEFAULTS = new Set(["nenhuma além das suas instruções", "não especificado", "nenhuma"]);
const LABEL: Record<string, string> = { Contexto: "Contexto", Restrições: "Restrições", "Como é uma boa resposta": "Esperado" };

/**
 * O pedido tipado (começa por "X pediu sua ajuda nisto.") sem a moldura: a tarefa como texto e os outros
 * campos em negrito, sem os valores-padrão. Qualquer outro corpo passa intacto (uma mensagem comum que só
 * cita "Tarefa:" não é reescrita). Pura.
 */
export function typedRequestBody(body: string): string {
  if (!TYPED_OPEN.test(body)) return body;
  const fields: { name: string; lines: string[] }[] = [];
  for (const line of body.replace(TYPED_OPEN, "").replace(TYPED_CLOSE, "").split("\n")) {
    const m = FIELD.exec(line);
    if (m) fields.push({ name: m[1]!, lines: [m[2]!] });
    else if (fields.length > 0) fields[fields.length - 1]!.lines.push(line);
  }
  if (!fields.some((f) => f.name === "Tarefa")) return body;
  const value = (f: { lines: string[] }) => f.lines.join("\n").trim();
  const task = fields.find((f) => f.name === "Tarefa")!;
  const rest = fields.filter((f) => f.name !== "Tarefa").map((f) => ({ label: LABEL[f.name]!, text: value(f) })).filter((f) => f.text && !DEFAULTS.has(f.text.toLowerCase()));
  return [value(task), rest.length > 0 ? rest.map((f) => `**${f.label}:** ${f.text}`).join("\n") : ""].filter(Boolean).join("\n\n");
}

/** O agente de um remetente "Codex · Revisor": a parte antes do " · " (o resto é o papel). */
export function senderAgent(sender: string): string {
  return sender.split(" · ")[0]!.trim();
}
