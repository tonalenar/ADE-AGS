import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Markdown, type CodeBlockRenderer, type MarkdownTone } from "@/shared/ui/Markdown";
import { htmlImagesToMarkdown } from "@/shared/ui/htmlImages";
import { AttachCwdContext, AttachmentStrip, type ShownAttachment } from "./AttachmentStrip";
import { useMediaViewer } from "./MediaViewerContext";
import { markdownImages, mentionedMedia, sameMarkdownImages, type MarkdownImageMedia } from "./mediaViewerModel";
import { mediaOfItems } from "../timeline/mediaCache";
import type { TimelineItem } from "../timeline/types";
import { loadImage } from "./useImagePreview";

/** Markdown de conversa com imagens locais da pasta do projeto no visualizador compartilhado. */
export function ChatMessageMarkdown({ content, tone = "chat", renderCodeBlock, streaming = false }: { content: string; tone?: MarkdownTone; renderCodeBlock?: CodeBlockRenderer; streaming?: boolean }) {
  const { load, open } = useConversationMarkdownImages(content);
  return (
    <>
      <Markdown content={content} tone={tone} renderCodeBlock={renderCodeBlock} loadImage={load} onImageClick={open} streaming={streaming} />
      <MentionedImageStrip content={content} />
    </>
  );
}

/** As imagens citadas por caminho na resposta viram miniaturas abaixo dela; clicar abre o visualizador da ADE. */
function MentionedImageStrip({ content }: { content: string }) {
  const cwd = useContext(AttachCwdContext);
  const items: ShownAttachment[] = useMemo(() => mentionedMedia(content, cwd).slice(0, 24)
    .map((media) => ({ path: media.path, name: media.name, kind: media.kind === "video" ? "file" : "image", size: null })), [content, cwd]);
  return items.length > 0 ? <AttachmentStrip items={items} className="mt-3" /> : null;
}

/** Miniaturas de imagens citadas por Markdown em saídas de ferramentas. */
export function ChatMarkdownImageStrip({ content, className = "" }: { content: string; className?: string }) {
  const { gallery } = useConversationMarkdownImages(content);
  const items: ShownAttachment[] = gallery.map((image) => ({ path: image.path, name: image.name, kind: "image", size: null, preview: image.preview }));
  return items.length > 0 ? <AttachmentStrip items={items} className={className} /> : null;
}

/** Indexa respostas e saídas de ferramentas mesmo quando uma linha antiga está recolhida. Conta por item, sem reler os outros (A107). */
export function ChatMarkdownMediaIndex({ items }: { items: readonly TimelineItem[] }) {
  const cwd = useContext(AttachCwdContext);
  const found = useMemo(() => mediaOfItems(items, cwd), [items, cwd]);
  const { gallery } = useGalleryOf(found);
  return <span className="hidden" aria-hidden="true" data-chat-markdown-media-count={gallery.length} />;
}

function useConversationMarkdownImages(content: string | string[]) {
  const cwd = useContext(AttachCwdContext);
  const found = useMemo(() => {
    const entries = Array.isArray(content) ? content : [content];
    return entries.flatMap((entry) => markdownImages(htmlImagesToMarkdown(entry), cwd)).filter((image, index, all) => all.findIndex((candidate) => candidate.path === image.path) === index);
  }, [content, cwd]);
  return useGalleryOf(found);
}

/** A galeria das imagens achadas: carrega as miniaturas e registra no visualizador compartilhado. */
function useGalleryOf(found: MarkdownImageMedia[]) {
  const viewer = useMediaViewer();
  const owner = useId();
  // A lista só muda de identidade quando as imagens mudam. Num streaming o texto cresce a cada pedaço e
  // `found` é um array novo (quase sempre vazio) toda vez; sem isto, `load`/`open` mudam a cada pedaço, o
  // `Markdown` recria os componentes e o React remonta todos os blocos, que refazem o fade de entrada (piscar).
  const stable = useRef(found);
  if (stable.current !== found && !sameMarkdownImages(stable.current, found)) stable.current = found;
  const images = stable.current;
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
  // `load` e `open` têm identidade fixa. O `Markdown` os usa nas dependências do mapa de componentes: se mudassem
  // quando chega uma imagem nova na resposta, o texto inteiro seria remontado (a lacuna do lote 1c). Eles leem a
  // lista e o visualizador da última renderização, pelo ref.
  const latest = useRef({ bySource, viewer });
  useLayoutEffect(() => { latest.current = { bySource, viewer }; }, [bySource, viewer]);
  const load = useCallback(async (source: string) => {
    const image = latest.current.bySource.get(source);
    if (!image) throw new Error("Imagem remota ou fora da pasta da conversa não carregada");
    if (image.preview) return image.preview;
    const preview = await loadImage(image.path);
    if (!preview) throw new Error("Imagem indisponível");
    return preview;
  }, []);
  const open = useCallback((source: string) => {
    const { bySource: current, viewer: api } = latest.current;
    const image = current.get(source);
    if (image) api?.open(image.path);
  }, []);
  return { gallery, load, open };
}
