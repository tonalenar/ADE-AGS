import { useCallback, useContext, useEffect, useId, useMemo, useState } from "react";

import { Markdown, type CodeBlockRenderer, type MarkdownTone } from "@/shared/ui/Markdown";
import { htmlImagesToMarkdown } from "@/shared/ui/htmlImages";
import { AttachCwdContext, AttachmentStrip, type ShownAttachment } from "./AttachmentStrip";
import { useMediaViewer } from "./MediaViewerContext";
import { markdownImages } from "./mediaViewerModel";
import { loadImage } from "./useImagePreview";

/** Markdown de conversa com imagens locais da pasta do projeto no visualizador compartilhado. */
export function ChatMessageMarkdown({ content, tone = "chat", renderCodeBlock }: { content: string; tone?: MarkdownTone; renderCodeBlock?: CodeBlockRenderer }) {
  const { load, open } = useConversationMarkdownImages(content);
  return <Markdown content={content} tone={tone} renderCodeBlock={renderCodeBlock} loadImage={load} onImageClick={open} />;
}

/** Miniaturas de imagens citadas por Markdown em saídas de ferramentas. */
export function ChatMarkdownImageStrip({ content, className = "" }: { content: string; className?: string }) {
  const { gallery } = useConversationMarkdownImages(content);
  const items: ShownAttachment[] = gallery.map((image) => ({ path: image.path, name: image.name, kind: "image", size: null, preview: image.preview }));
  return items.length > 0 ? <AttachmentStrip items={items} className={className} /> : null;
}

/** Indexa respostas e saídas de ferramentas mesmo quando uma linha antiga está recolhida. */
export function ChatMarkdownMediaIndex({ contents }: { contents: string[] }) {
  const { gallery } = useConversationMarkdownImages(contents);
  return <span className="hidden" aria-hidden="true" data-chat-markdown-media-count={gallery.length} />;
}

function useConversationMarkdownImages(content: string | string[]) {
  const cwd = useContext(AttachCwdContext);
  const viewer = useMediaViewer();
  const owner = useId();
  const images = useMemo(() => {
    const entries = Array.isArray(content) ? content : [content];
    return entries.flatMap((entry) => markdownImages(htmlImagesToMarkdown(entry), cwd)).filter((image, index, all) => all.findIndex((candidate) => candidate.path === image.path) === index);
  }, [content, cwd]);
  const [loadedPreviews, setLoadedPreviews] = useState<Record<string, string>>({});
  const gallery = useMemo(() => images.map((image) => ({ ...image, preview: image.preview ?? loadedPreviews[image.path] ?? null })), [images, loadedPreviews]);

  useEffect(() => {
    let active = true;
    void Promise.all(images.map(async (image) => {
      if (image.preview) return [image.path, image.preview] as const;
      const preview = await loadImage(image.path);
      return preview ? [image.path, preview] as const : null;
    })).then((loaded) => {
      if (!active) return;
      setLoadedPreviews(Object.fromEntries(loaded.filter((item): item is readonly [string, string] => item !== null)));
    });
    return () => { active = false; };
  }, [images]);

  useEffect(() => {
    if (!viewer) return;
    viewer.register(owner, gallery);
    return () => viewer.unregister(owner);
  }, [gallery, owner, viewer]);

  const bySource = useMemo(() => new Map(images.map((image) => [image.source, image])), [images]);
  const load = useCallback(async (source: string) => {
    const image = bySource.get(source);
    if (!image) throw new Error("Imagem remota ou fora da pasta da conversa não carregada");
    if (image.preview) return image.preview;
    const preview = await loadImage(image.path);
    if (!preview) throw new Error("Imagem indisponível");
    return preview;
  }, [bySource]);
  const open = useCallback((source: string) => {
    const image = bySource.get(source);
    if (image) viewer?.open(image.path);
  }, [bySource, viewer]);
  return { gallery, load, open };
}
