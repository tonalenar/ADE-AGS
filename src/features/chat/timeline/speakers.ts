/**
 * Quem fala na conversa e quando a linha do remetente (logo pequeno + nome) aparece acima do texto: só
 * a pessoa fala em balão, as falas dos agentes ficam soltas e são identificadas por esta linha. Aparece
 * na primeira fala de um agente depois da pessoa e sempre que a voz muda (o agente da conversa, outro
 * agente pelo `ags peer`, de volta ao da conversa). Falas seguidas da mesma voz (com ferramentas no meio)
 * não repetem a linha. A mensagem da pessoa zera a sequência e nunca leva cabeçalho. Pura.
 */
import { parsePeerEnvelope } from "./peerEnvelope";
import type { TimelineItem } from "./types";

const SELF = "self";
const PERSON = "person";

/** Os ids das falas que levam o cabeçalho com o nome de quem fala. */
export function speakerHeaders(items: TimelineItem[]): Set<string> {
  const shown = new Set<string>();
  let previous: string | null = null;
  for (const item of items) {
    let speaker: string | null = null;
    if (item.kind === "assistant") speaker = SELF;
    else if (item.kind === "user") {
      const peer = parsePeerEnvelope(item.text ?? "");
      speaker = peer ? `peer:${peer.sender}` : PERSON;
    }
    if (speaker === null) continue;
    if (speaker !== PERSON && speaker !== previous) shown.add(item.id);
    previous = speaker;
  }
  return shown;
}
