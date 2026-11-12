export interface ConversationMedia {
  path: string;
  name: string;
  kind: "image" | "video";
  preview: string | null;
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

export function commentsForMessage(comments: ImageComment[]): string {
  if (comments.length === 0) return "";
  return comments.map((comment, index) => `${index + 1}. ${comment.text} (${Math.round(comment.x * 100)}%, ${Math.round(comment.y * 100)}%)`).join("\n");
}
