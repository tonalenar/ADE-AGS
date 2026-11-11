/**
 * Menções `$nome` que a pessoa escreve no texto, convertidas no envio para o agente que precisa. O Claude
 * expande uma skill só quando `/nome` abre a mensagem (como o T3, em `ClaudeSkillDispatch`): a última menção
 * conhecida vai para o início e o resto do texto vira o argumento dela; as anteriores viram `/nome` no lugar.
 * Os outros agentes recebem o texto como está (o Codex aceita `$nome` no próprio texto). Pura.
 */
import { agentNameKey } from "./agentSlashModel";

/** `$nome` que começa o texto ou vem depois de espaço, e termina em espaço ou no fim do texto. */
const SKILL_MENTION = /(^|\s)\$([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g;

/** Junta o texto antes e depois da menção tirada do meio, sem deixar espaço sobrando e sem desfazer quebra de linha. */
function joinAroundMention(head: string, tail: string): string {
  const left = head.replace(/[ \t]+$/, "");
  const right = tail.replace(/^[ \t]+/, "");
  if (!left || !right) return `${left}${right}`;
  return /\n$/.test(left) || /^\n/.test(right) ? `${left}${right}` : `${left} ${right}`;
}

export function dispatchSkillMentions(agentId: string, text: string, skillNames: ReadonlyArray<string>): string {
  if (agentId !== "claude-code") return text;
  const known = new Map<string, string>();
  for (const name of skillNames) known.set(agentNameKey(name), name.trim());
  const mentions = [...text.matchAll(SKILL_MENTION)].filter((match) => known.has(agentNameKey(match[2] ?? "")));
  const last = mentions[mentions.length - 1];
  if (!last) return text;

  const canonical = (match: RegExpMatchArray) => known.get(agentNameKey(match[2] ?? "")) ?? match[2] ?? "";
  // Texto antes da última menção, com as anteriores já trocadas por `/nome`.
  let head = "";
  let cursor = 0;
  for (const match of mentions) {
    if (match === last) break;
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    head += `${text.slice(cursor, start)}/${canonical(match)}`;
    cursor = (match.index ?? 0) + match[0].length;
  }
  const lastStart = (last.index ?? 0) + (last[1]?.length ?? 0);
  const lastEnd = (last.index ?? 0) + last[0].length;
  head += text.slice(cursor, lastStart);

  const body = joinAroundMention(head, text.slice(lastEnd));
  const command = `/${canonical(last)}`;
  return body ? `${command} ${body}` : command;
}
