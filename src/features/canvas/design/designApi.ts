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
  /** O backend diz se há aba do dono para receber as mensagens, e por que não (sem dono / aba fechada). */
  ownerAvailable?: boolean;
  ownerWarning?: null | "missing" | "closed";
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
  /** Raio dos cantos da moldura (px de mundo); o backend novo manda, o antigo não (0). */
  radius?: number;
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
  /** Quando foi criado (ms). Sem o campo no backend antigo, vale a ordem da lista. */
  createdAt: number;
  /** A âncora: seletor do elemento na prancheta (≤1024). `null` = ponto na prancheta inteira. */
  anchor?: string | null;
  /** O ponto (0–1) relativo ao elemento ancorado ou à prancheta. */
  pointX?: number | null;
  pointY?: number | null;
  /** O comentário que este responde (fio). */
  parentId?: string | null;
}
/** Uma nota (sticky) solta no canvas de uma página. */
export interface DesignNote { id: string; pageId: string; x: number; y: number; w: number; h: number; text: string; color: string | null; createdAt?: number | null }
/** Um desenho no canvas (F4; a tela só lê por enquanto). */
export interface DesignShape { id: string; pageId: string; kind: string; x: number; y: number; w: number; h: number; data: unknown; createdAt?: number | null }
export interface DesignDetail {
  design: Design;
  pages: DesignPage[];
  artboards: Artboard[];
  comments: DesignComment[];
  versions: Record<string, ArtboardVersion[]>;
  notes: DesignNote[];
  shapes: DesignShape[];
}

// Formato cru do backend: Design com páginas, pranchetas, versões e comentários aninhados.
type RawArtboard = Artboard & { versions?: ArtboardVersion[]; comments?: Omit<DesignComment, "createdAt">[] };
type RawPage = DesignPage & { artboards?: RawArtboard[]; notes?: DesignNote[]; shapes?: DesignShape[] };
export type RawDesign = Design & { pages?: RawPage[] };

/** Achata o Design aninhado do backend no que a tela usa. */
export function normalizeDesign(raw: RawDesign): DesignDetail {
  const { pages: rawPages = [], ...design } = raw;
  const pages: DesignPage[] = [];
  const artboards: Artboard[] = [];
  const comments: DesignComment[] = [];
  const versions: Record<string, ArtboardVersion[]> = {};
  const notes: DesignNote[] = [];
  const shapes: DesignShape[] = [];
  for (const { artboards: boards = [], notes: ns = [], shapes: ss = [], ...page } of [...rawPages].sort((a, b) => a.order - b.order)) {
    pages.push(page);
    for (const n of ns) notes.push({ ...n, pageId: n.pageId ?? page.id });
    for (const sh of ss) shapes.push({ ...sh, pageId: sh.pageId ?? page.id });
    for (const { versions: vs = [], comments: cs = [], ...board } of boards) {
      artboards.push(board);
      versions[board.id] = vs;
      // Sem `createdAt` (backend antigo), a posição na lista é a ordem de criação.
      for (const c of cs) {
        const raw = c as Omit<DesignComment, "createdAt"> & { createdAt?: number };
        comments.push({ ...raw, createdAt: typeof raw.createdAt === "number" ? raw.createdAt : comments.length });
      }
    }
  }
  return { design, pages, artboards, comments, versions, notes, shapes };
}

// Todos os comandos recebem um único objeto `args`.
const call = <T>(cmd: string, args: Record<string, unknown> = {}) => invoke<T>(cmd, { args });

export const designApi = {
  list: async (workspace?: string): Promise<Design[]> =>
    (await call<RawDesign[]>("design_list", { workspace: workspace ?? null })).map((d) => normalizeDesign(d).design),
  get: async (designId: string) => normalizeDesign(await call<RawDesign>("design_get", { designId })),
  /** Mexer só em x/y/width/height/radius não cria versão nova do HTML (contrato). */
  updateArtboard: (artboardId: string, patch: { html?: string; title?: string; x?: number; y?: number; width?: number; height?: number; radius?: number; expectedVersion?: number }) =>
    call<RawDesign>("design_artboard_update", { artboardId, ...patch }),
  addArtboard: (a: { pageId: string; title: string; html: string; width?: number; height?: number; x?: number; y?: number }) =>
    call<RawDesign & { artboardId?: string }>("design_artboard_add", a),
  /** Cópia do HTML numa prancheta nova (título "… cópia"), em (x, y) se vier. */
  duplicateArtboard: (artboardId: string, at?: { x: number; y: number }) => call<RawDesign & { artboardId?: string }>("design_artboard_duplicate", { artboardId, ...at }),
  deleteArtboard: (artboardId: string) => call<RawDesign>("design_artboard_delete", { artboardId }),
  addPage: (designId: string, name: string, order?: number) => call<RawDesign & { pageId?: string }>("design_page_add", { designId, name, order }),
  renamePage: (pageId: string, name: string) => call<RawDesign>("design_page_rename", { pageId, name }),
  /** O backend não apaga a última página. */
  deletePage: (pageId: string) => call<RawDesign>("design_page_delete", { pageId }),
  reorderPages: (designId: string, pageIds: string[]) => call<RawDesign>("design_page_reorder", { designId, pageIds }),
  addNote: (n: { pageId: string; x: number; y: number; w?: number; h?: number; text?: string; color?: string | null }) => call<RawDesign & { noteId?: string }>("design_note_add", n),
  updateNote: (noteId: string, patch: Partial<Pick<DesignNote, "x" | "y" | "w" | "h" | "text" | "color">>) => call<RawDesign>("design_note_update", { noteId, ...patch }),
  deleteNote: (noteId: string) => call<RawDesign>("design_note_delete", { noteId }),
  addShape: (sh: { pageId: string; kind: string; x: number; y: number; w: number; h: number; data: unknown }) =>
    call<RawDesign & { shapeId?: string }>("design_shape_add", sh),
  updateShape: (shapeId: string, patch: Partial<{ kind: string; x: number; y: number; w: number; h: number; data: unknown }>) =>
    call<RawDesign>("design_shape_update", { shapeId, ...patch }),
  deleteShape: (shapeId: string) => call<RawDesign>("design_shape_delete", { shapeId }),
  /** Um comentário ancorado (F2): seletor + ponto relativo, ou só o ponto na prancheta; `parentId` = resposta. */
  addAnchoredComment: (c: { artboardId: string; text: string; selector?: string | null; anchor?: string | null; pointX?: number | null; pointY?: number | null; parentId?: string | null }) =>
    call<RawDesign & { commentAdded?: boolean }>("design_comment_add", { ...c, author: "user" }),
  /** Publica o que a pessoa vê (memória do backend; o agente lê com `ags design view`). */
  setView: (designId: string, state: unknown) => call<unknown>("design_view_set", { designId, state }),
  /** Volta ao conteúdo de uma versão anterior (gera uma versão nova, em rascunho). */
  revert: (artboardId: string, version: number, expectedVersion?: number) =>
    call<RawDesign>("design_artboard_revert", { artboardId, version, expectedVersion }),
  /** Arquiva o design: sai do canvas, mas pode ser recuperado. */
  archive: (designId: string) => call<unknown>("design_archive", { designId }),
  /** Exclui o design inteiro (páginas, pranchetas, versões e comentários). */
  remove: (designId: string) => call<unknown>("design_delete", { designId }),
  approve: (artboardId: string) => call<RawDesign>("design_artboard_approve", { artboardId }),
  reject: (artboardId: string) => call<RawDesign>("design_artboard_reject", { artboardId }),
  approveAll: (designId: string) => call<RawDesign>("design_approve_all", { designId }),
  /** `commentAdded: false` = o comentário já existia aberto (repetido): não reenvie ao dono. */
  addComment: (artboardId: string, text: string, selector: string | null) =>
    call<RawDesign & { commentAdded?: boolean }>("design_comment_add", { artboardId, text, selector, author: "user" }),
  resolveComment: (commentId: string, resolved: boolean) => call<RawDesign>("design_comment_resolve", { commentId, resolved }),
  /**
   * Entrega um texto ao agente dono do design pelo mesmo caminho do chat do canvas (a
   * mensagem entra no terminal dele, como um `ags peer tell`).
   */
  tellOwner: (ownerTabId: string, text: string) => invoke<unknown>("chat_send", { tabId: ownerTabId, thread: "blue", text }),
};

/** Chama `fn` quando o agente (ou o CLI) muda algo. Devolve o cancelamento. */
export function onDesignChanged(fn: (payload: { designId?: string | null } | null) => void): () => void {
  const off = listen<{ designId?: string | null } | null>("design-changed", (e) => fn(e.payload ?? null));
  return () => {
    off.then((u) => u());
  };
}
