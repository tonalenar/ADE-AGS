import type { TimelineItem } from "./types";

function normalized(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}

/** Pesquisa falas visíveis e planos publicados na timeline já carregada, sem ler saídas de ferramentas. */
export function searchTimelineItems(items: TimelineItem[], query: string, limit = 20): TimelineItem[] {
  if (limit <= 0) return [];
  const terms = normalized(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return items.filter((item) => {
    const searchableText = item.kind === "user" || item.kind === "assistant"
      ? item.text ?? ""
      // Planos `todo` são conteúdo deliberadamente publicado no fio; comandos e demais dados
      // de ferramenta continuam fora do índice local.
      : item.kind === "tool" && item.tool === "todo"
        ? item.plan?.map((step) => step.text).join("\n") ?? ""
        : "";
    if (!searchableText) return false;
    const text = normalized(searchableText);
    return terms.every((term) => text.includes(term));
  }).slice(-Math.max(0, limit)).reverse();
}
