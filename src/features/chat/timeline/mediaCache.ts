import { htmlImagesToMarkdown } from "@/shared/ui/htmlImages";
import { markdownImages, type MarkdownImageMedia } from "../attachments/mediaViewerModel";
import type { TimelineItem } from "./types";

/**
 * As imagens que cada item cita (no texto e na saída), guardadas por item e por pasta. Um item que não mudou é lido uma
 * vez só: quando chega um pedaço no fim da conversa, os outros não passam de novo pela regex. Pura sobre o item.
 */
const cache = new WeakMap<TimelineItem, Map<string | null, MarkdownImageMedia[]>>();

function imagesOfItem(item: TimelineItem, cwd: string | null): MarkdownImageMedia[] {
  let byCwd = cache.get(item);
  if (!byCwd) {
    byCwd = new Map();
    cache.set(item, byCwd);
  }
  const known = byCwd.get(cwd);
  if (known) return known;
  const found = [item.text ?? "", item.output ?? ""]
    .filter(Boolean)
    .flatMap((entry) => markdownImages(htmlImagesToMarkdown(entry), cwd));
  byCwd.set(cwd, found);
  return found;
}

/** As imagens citadas pela conversa, sem repetir o mesmo caminho, na ordem em que aparecem. */
export function mediaOfItems(items: readonly TimelineItem[], cwd: string | null): MarkdownImageMedia[] {
  const seen = new Set<string>();
  const out: MarkdownImageMedia[] = [];
  for (const item of items) {
    for (const image of imagesOfItem(item, cwd)) {
      if (seen.has(image.path)) continue;
      seen.add(image.path);
      out.push(image);
    }
  }
  return out;
}
