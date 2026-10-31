/**
 * O caminho da tela cheia de um design (`/design/:id?artboard=&page=&seq=`). `seq` muda a cada pedido
 * para que abrir de novo o mesmo design volte a enquadrar a prancheta pedida. Puro.
 */
export function designRoute(req: { designId: string; artboardId?: string | null; pageId?: string | null; seq?: number }): string {
  const q = new URLSearchParams();
  if (req.artboardId) q.set("artboard", req.artboardId);
  if (req.pageId) q.set("page", req.pageId);
  if (req.seq) q.set("seq", String(req.seq));
  const qs = q.toString();
  return `/design/${encodeURIComponent(req.designId)}${qs ? `?${qs}` : ""}`;
}

/** Os argumentos da op `design.open` da ponte, validados (o que vem do CLI não é confiável). */
export function parseDesignOpen(args: Record<string, unknown>): { designId: string; artboardId: string | null; pageId: string | null } {
  const s = (k: string) => (typeof args[k] === "string" && (args[k] as string).length > 0 && (args[k] as string).length <= 200 ? (args[k] as string) : null);
  const designId = s("designId");
  if (!designId) throw new Error("Falta o design (designId)");
  return { designId, artboardId: s("artboardId"), pageId: s("pageId") };
}
