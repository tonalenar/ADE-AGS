/**
 * Quem fala na conversa e quando a linha do remetente (logo pequeno + nome) aparece acima do texto, já
 * que as falas não ficam mais em balões. Na conversa de um agente só nunca aparece; num time, aparece
 * quando fala OUTRO agente (o `ags peer` chega como mensagem com envelope) e quando o agente da conversa
 * volta a falar depois de outro. A mensagem da pessoa zera a sequência. Pura.
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
    const other = speaker !== SELF && speaker !== PERSON;
    const backFromOther = speaker === SELF && previous !== null && previous !== SELF && previous !== PERSON;
    if (speaker !== previous && (other || backFromOther)) shown.add(item.id);
    previous = speaker;
  }
  return shown;
}
