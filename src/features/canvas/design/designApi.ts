import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// A única camada que fala com o backend de Design (comandos design_*). Se um nome ou campo
// mudar, é só aqui.

export type ArtboardStatus = "draft" | "approved" | "rejected";
export type DesignStatus = ArtboardStatus;

export interface Design {
  id: string;
  workspace: string;
  missionId: string | null;
  /** Aba do agente dono: quem recebe os comentários. */
  ownerTabId: string | null;
  title: string;
  status: DesignStatus;
}
export interface DesignPage { id: string; designId: string; name: string; order: number }
export interface Artboard {
  id: string;
  pageId: string;
  title: string;
  html: string;
  width: number;
  height: number;
  x: number;
  y: number;
  version: number;
  status: ArtboardStatus;
}
/** Um retrato da prancheta numa versão anterior (o backend guarda o snapshot inteiro). */
export interface ArtboardVersion { version: number; html: string; title: string }
export interface DesignComment {
  id: string;
  artboardId: string;
  author: "user" | "agent";
  text: string;
  selector: string | null;
  resolved: boolean;
  /** Ordem de criação (o backend não manda data: a lista já vem em ordem). */
  createdAt: number;
}
export interface DesignDetail {
  design: Design;
  pages: DesignPage[];
  artboards: Artboard[];
  comments: DesignComment[];
  versions: Record<string, ArtboardVersion[]>;
}

// Formato cru do backend: Design com páginas, pranchetas, versões e comentários aninhados.
type RawArtboard = Artboard & { versions?: ArtboardVersion[]; comments?: Omit<DesignComment, "createdAt">[] };
type RawPage = DesignPage & { artboards?: RawArtboard[] };
export type RawDesign = Design & { pages?: RawPage[] };

/** Achata o Design aninhado do backend no que a tela usa. */
export function normalizeDesign(raw: RawDesign): DesignDetail {
  const { pages: rawPages = [], ...design } = raw;
  const pages: DesignPage[] = [];
  const artboards: Artboard[] = [];
  const comments: DesignComment[] = [];
  const versions: Record<string, ArtboardVersion[]> = {};
  for (const { artboards: boards = [], ...page } of [...rawPages].sort((a, b) => a.order - b.order)) {
    pages.push(page);
    for (const { versions: vs = [], comments: cs = [], ...board } of boards) {
      artboards.push(board);
      versions[board.id] = vs;
      for (const c of cs) comments.push({ ...c, createdAt: comments.length });
    }
  }
  return { design, pages, artboards, comments, versions };
}

// Todos os comandos recebem um único objeto `args`.
const call = <T>(cmd: string, args: Record<string, unknown> = {}) => invoke<T>(cmd, { args });

export const designApi = {
  list: async (workspace?: string): Promise<Design[]> =>
    (await call<RawDesign[]>("design_list", { workspace: workspace ?? null })).map((d) => normalizeDesign(d).design),
  get: async (designId: string) => normalizeDesign(await call<RawDesign>("design_get", { designId })),
  updateArtboard: (artboardId: string, patch: { html?: string; title?: string; x?: number; y?: number; expectedVersion?: number }) =>
    call<RawDesign>("design_artboard_update", { artboardId, ...patch }),
  /** Volta ao conteúdo de uma versão anterior (gera uma versão nova, em rascunho). */
  revert: (artboardId: string, version: number) => call<RawDesign>("design_artboard_revert", { artboardId, version }),
  approve: (artboardId: string) => call<RawDesign>("design_artboard_approve", { artboardId }),
  reject: (artboardId: string) => call<RawDesign>("design_artboard_reject", { artboardId }),
  approveAll: (designId: string) => call<RawDesign>("design_approve_all", { designId }),
  addComment: (artboardId: string, text: string, selector: string | null) =>
    call<RawDesign>("design_comment_add", { artboardId, text, selector, author: "user" }),
  resolveComment: (commentId: string, resolved: boolean) => call<RawDesign>("design_comment_resolve", { commentId, resolved }),
  /**
   * Entrega um texto ao agente dono do design pelo mesmo caminho do chat do canvas (a
   * mensagem entra no terminal dele, como um `ags peer tell`).
   */
  tellOwner: (ownerTabId: string, text: string) => invoke<unknown>("chat_send", { tabId: ownerTabId, thread: "blue", text }),
};

/** Chama `fn` quando o agente (ou o CLI) muda algo. Devolve o cancelamento. */
export function onDesignChanged(fn: () => void): () => void {
  const off = listen("design-changed", fn);
  return () => {
    off.then((u) => u());
  };
}
