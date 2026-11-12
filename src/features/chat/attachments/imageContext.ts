import { commentsForMessage, type ImageComment } from "./mediaViewerModel";

const contexts = new Map<string, string>();

/** Mantém as coordenadas da marcação até a próxima mensagem do composer. */
export function setImageContext(path: string, comments: ImageComment[]): void {
  const text = commentsForMessage(comments);
  if (text) contexts.set(path, text);
  else contexts.delete(path);
}

export function takeImageContext(paths: string[]): string {
  const entries = paths.flatMap((path) => {
    const text = contexts.get(path);
    if (!text) return [];
    contexts.delete(path);
    return [`Imagem ${path}:\n${text}`];
  });
  return entries.length ? `\n\n[Comentários sobre a imagem]\n${entries.join("\n")}` : "";
}
