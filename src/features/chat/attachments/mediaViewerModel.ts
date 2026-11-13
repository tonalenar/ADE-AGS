export interface ConversationMedia {
  path: string;
  name: string;
  kind: "image" | "video";
  preview: string | null;
}

export interface MarkdownImageMedia extends ConversationMedia {
  /** O `src` que o Markdown renderizado entrega ao componente `<img>`. */
  source: string;
}

const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif)$/i;

/**
 * Extrai imagens locais mencionadas em Markdown de conversa, sem buscar URLs remotas.
 * Caminhos em disco ficam limitados à pasta da conversa; mensagens e saídas de ferramentas são dados não confiáveis.
 */
export function markdownImages(content: string, cwd: string | null): MarkdownImageMedia[] {
  const body = content.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "").replace(/`[^`]*`/g, "");
  const result: MarkdownImageMedia[] = [];
  const seen = new Set<string>();
  const pattern = /!\[([^\]]*)\]\((<[^>\r\n]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  for (const match of body.matchAll(pattern)) {
    const source = (match[2] ?? "").replace(/^<|>$/g, "").replace(/\\(.)/g, "$1");
    if (!source || /^https?:\/\//i.test(source)) continue;
    if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(source)) {
      if (seen.has(source)) continue;
      seen.add(source);
      const extension = source.match(/^data:image\/(png|jpeg|jpg|webp|gif)/i)?.[1]?.toLowerCase() ?? "png";
      const alt = (match[1] ?? "").trim();
      const name = alt ? (/\.[^.]+$/.test(alt) ? alt : `${alt}.${extension}`) : `imagem-${result.length + 1}.${extension}`;
      result.push({ path: source, source, name, kind: "image", preview: source });
      continue;
    }
    if (!cwd) continue;
    const path = localMarkdownImagePath(source, cwd);
    if (!path || !IMAGE_EXTENSION.test(path) || seen.has(path)) continue;
    seen.add(path);
    const alt = (match[1] ?? "").trim();
    const name = alt ? (/\.[^.]+$/.test(alt) ? alt : `${alt}.png`) : path.split("/").pop() || `imagem-${result.length + 1}.png`;
    result.push({ path, source, name, kind: "image", preview: null });
  }
  return result;
}

/** Expande chaves simples (`a-{x,y}.png` → `a-x.png`, `a-y.png`); sem chaves ou aninhadas, devolve o próprio texto. */
export function expandBraces(text: string): string[] {
  const match = text.match(/^([^{}]*)\{([^{}]+)\}([^{}]*)$/);
  if (!match) return /[{}]/.test(text) ? [] : [text];
  const options = match[2]!.split(",").map((part) => part.trim()).filter(Boolean);
  if (options.length === 0 || options.length > 12) return [];
  return options.map((option) => `${match[1]}${option}${match[3]}`);
}

/**
 * Arquivos de imagem citados no texto, em código inline (`brand/logo.png`) ou como alvo de link
 * (`[logo](brand/logo.png)`), inclusive em tabelas. Só caminhos dentro da pasta da conversa; URLs remotas e
 * blocos de código ficam de fora. As imagens já mostradas com `![...]()` não se repetem aqui.
 */
export function mentionedImages(content: string, cwd: string | null): ConversationMedia[] {
  if (!cwd) return [];
  const body = content.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");
  const embedded = new Set(markdownImages(content, cwd).map((image) => image.path));
  const candidates: string[] = [];
  for (const match of body.matchAll(/(?<!!)\[[^\]]*\]\((<[^>\r\n]+>|[^)\s]+)[^)]*\)/g)) candidates.push((match[1] ?? "").replace(/^<|>$/g, ""));
  for (const match of body.matchAll(/`([^`\r\n]+)`/g)) candidates.push(match[1] ?? "");
  const result: ConversationMedia[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const text = raw.trim();
    if (!text || /\s/.test(text) || /^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^file:\/\//i.test(text)) continue;
    for (const expanded of expandBraces(text)) {
      if (!IMAGE_EXTENSION.test(expanded)) continue;
      const path = localMarkdownImagePath(expanded, cwd);
      if (!path || seen.has(path) || embedded.has(path)) continue;
      seen.add(path);
      result.push({ path, name: path.split("/").pop() || expanded, kind: "image", preview: null });
    }
  }
  return result;
}

function localMarkdownImagePath(source: string, cwd: string): string | null {
  let candidate = source;
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
      if (/^\/[a-z]:\//i.test(candidate)) candidate = candidate.slice(1);
    } catch { return null; }
  } else {
    try { candidate = decodeURIComponent(candidate); } catch { /* Caminho sem escapes percentuais. */ }
  }
  candidate = candidate.replace(/\\/g, "/");
  const base = normalizeFsPath(cwd.replace(/\\/g, "/"));
  const absolute = /^[A-Za-z]:\//.test(candidate) || candidate.startsWith("/")
    ? normalizeFsPath(candidate)
    : normalizeFsPath(`${base}/${candidate}`);
  const comparableBase = base.toLowerCase();
  const comparablePath = absolute.toLowerCase();
  return comparablePath.startsWith(`${comparableBase.replace(/\/$/, "")}/`) ? absolute : null;
}

function normalizeFsPath(path: string): string {
  const drive = path.match(/^([A-Za-z]:)\//)?.[1] ?? "";
  const unc = !drive && path.startsWith("//");
  const rooted = path.startsWith("/") || !!drive;
  const rest = drive ? path.slice(drive.length + 1) : path.slice(unc ? 2 : 0).replace(/^\/+/, "");
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (parts.length) parts.pop(); }
    else parts.push(part);
  }
  return `${drive ? `${drive}/` : unc ? "//" : rooted ? "/" : ""}${parts.join("/")}`.replace(/\/$/, "") || "/";
}

export type MediaFilter = "image" | "video" | "all";

export function filterMedia(items: ConversationMedia[], filter: MediaFilter): ConversationMedia[] {
  return filter === "all" ? items : items.filter((item) => item.kind === filter);
}

export function nextMediaIndex(index: number, step: -1 | 1, count: number): number {
  return count <= 0 ? 0 : Math.max(0, Math.min(count - 1, index + step));
}

export function resizeDimensions(width: number, height: number, requested: { width?: number; height?: number }): { width: number; height: number } {
  const scale = requested.width !== undefined ? requested.width / width : (requested.height ?? height) / height;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function captureVideoFrame(video: ConversationMedia, preview: string): ConversationMedia {
  return { ...video, kind: "image", name: video.name.replace(/\.[^.]+$/, ".png"), preview };
}

export interface MarkPoint { x: number; y: number }
export type MarkStroke = MarkPoint[];

export function undoStroke(strokes: MarkStroke[]): { strokes: MarkStroke[]; undone: MarkStroke | null } {
  if (strokes.length === 0) return { strokes, undone: null };
  return { strokes: strokes.slice(0, -1), undone: strokes[strokes.length - 1] ?? null };
}

export interface ImageComment { x: number; y: number; text: string }

export interface ImageRegion { x: number; y: number; width: number; height: number }

export interface ImageCommentWithRegion extends ImageComment { region?: ImageRegion }

/** Um arrasto marca uma região; um clique curto preserva apenas o ponto indicado. */
export function commentFromSelection(start: MarkPoint, end: MarkPoint, text: string): ImageCommentWithRegion {
  const x = Math.min(start.x, end.x); const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x); const height = Math.abs(end.y - start.y);
  if (width < 0.01 && height < 0.01) return { x: start.x, y: start.y, text };
  return { x: x + width / 2, y: y + height / 2, text, region: { x, y, width, height } };
}

export function commentsForMessage(comments: ImageCommentWithRegion[]): string {
  if (comments.length === 0) return "";
  return comments.map((comment, index) => {
    const point = `(${Math.round(comment.x * 100)}%, ${Math.round(comment.y * 100)}%)`;
    const region = comment.region
      ? `; região ${Math.round(comment.region.x * 100)}%, ${Math.round(comment.region.y * 100)}%–${Math.round((comment.region.x + comment.region.width) * 100)}%, ${Math.round((comment.region.y + comment.region.height) * 100)}%`
      : "";
    return `${index + 1}. ${comment.text} ${point}${region}`;
  }).join("\n");
}
