/**
 * Capturas pendentes do composer: SnapShots e gravações de tela já anexados ao rascunho e ainda não enviados.
 *
 * O composer desmonta ao trocar de conversa e o rascunho some ao recarregar a janela. Para a captura não se perder
 * em silêncio, o caminho do arquivo fica guardado por alvo (a mesma ref de `composerTarget`). O registro acompanha
 * o rascunho: sai quando a captura é enviada, removida ou guardada num stash. Este módulo nunca apaga o arquivo.
 *
 * Só caminhos e ids de alvo entram no armazenamento local; nenhum conteúdo de tela.
 */

export type PendingCaptureKind = "snapshot" | "recording";

export interface PendingCapture {
  path: string;
  target: string;
  kind: PendingCaptureKind;
  savedAt: number;
}

/** Chave do armazenamento local desta máquina: preferência do próprio viewer, sem segredo. */
export const PENDING_CAPTURES_KEY = "cc-pending-captures";
/** Teto do registro: passado dele, a captura mais antiga sai da lista e a ADE avisa. */
export const MAX_PENDING_CAPTURES = 50;

const KINDS: readonly string[] = ["snapshot", "recording"];

/** Lê só entradas bem formadas. Qualquer outra coisa vira nada, sem exceção. Pura. */
export function parsePendingCaptures(raw: unknown): PendingCapture[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): PendingCapture[] => {
    if (!item || typeof item !== "object") return [];
    const { path, target, kind, savedAt } = item as Record<string, unknown>;
    if (typeof path !== "string" || path.length === 0) return [];
    if (typeof target !== "string" || target.length === 0) return [];
    if (typeof kind !== "string" || !KINDS.includes(kind)) return [];
    if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return [];
    return [{ path, target, kind: kind as PendingCaptureKind, savedAt }];
  });
}

/**
 * Cópia da página. Quando o armazenamento nega acesso ou falha numa gravação, esta cópia passa a ser a fonte
 * até a página ser recarregada: a captura continua valendo na sessão, mesmo sem persistir.
 */
let memory: PendingCapture[] | null = null;
let useMemory = false;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function load(): PendingCapture[] {
  if (useMemory) return memory ?? [];
  const store = storage();
  if (!store) {
    useMemory = true;
    return memory ?? [];
  }
  let raw: string | null;
  try {
    raw = store.getItem(PENDING_CAPTURES_KEY);
  } catch {
    useMemory = true;
    return memory ?? [];
  }
  // JSON estragado vira lista vazia; a próxima gravação substitui o conteúdo.
  try {
    return parsePendingCaptures(JSON.parse(raw ?? "null"));
  } catch {
    return [];
  }
}

function save(list: PendingCapture[]): void {
  memory = list;
  if (useMemory) return;
  const store = storage();
  if (!store) {
    useMemory = true;
    return;
  }
  try {
    store.setItem(PENDING_CAPTURES_KEY, JSON.stringify(list));
  } catch {
    useMemory = true;
  }
}

/** Caminhos pendentes deste alvo, na ordem em que foram feitos. Sem alvo, não há o que devolver. */
export function pendingCapturePaths(target: string | null | undefined): string[] {
  if (!target) return [];
  return load().filter((item) => item.target === target).map((item) => item.path);
}

/**
 * Guarda uma captura antes de ela entrar no rascunho. Sem alvo não guarda: a captura segue só para quem a pegar.
 * `dropped` traz a captura mais antiga quando o teto é atingido, para o aviso dizer o que saiu da lista.
 */
export function rememberPendingCapture(
  input: { path: string; target: string | null | undefined; kind: PendingCaptureKind },
  now: number = Date.now(),
): { dropped: PendingCapture | null } {
  if (!input.target) return { dropped: null };
  const list = load();
  if (list.some((item) => item.target === input.target && item.path === input.path)) return { dropped: null };
  const next = [...list, { path: input.path, target: input.target, kind: input.kind, savedAt: now }];
  const overflow = next.length - MAX_PENDING_CAPTURES;
  save(overflow > 0 ? next.slice(overflow) : next);
  return { dropped: overflow > 0 ? next[0] : null };
}

/**
 * Tira do registro só os caminhos pedidos deste alvo. O arquivo continua no disco.
 * Chamada também quando o composer já foi desmontado (envio que cria a conversa): por isso não depende do efeito.
 */
export function forgetPendingCaptures(target: string | null | undefined, paths: readonly string[]): void {
  if (!target || paths.length === 0) return;
  const gone = new Set(paths);
  const list = load();
  const next = list.filter((item) => !(item.target === target && gone.has(item.path)));
  if (next.length !== list.length) save(next);
}

/** Caminhos que estavam no rascunho antes e já não estão. Pura. */
export function removedCapturePaths(previous: readonly string[], current: readonly string[]): string[] {
  const now = new Set(current);
  return previous.filter((path) => !now.has(path));
}

/** Na volta ao rascunho, separa o que ainda existe do que falhou na inspeção. Pura. */
export function splitRestorableCaptures(
  inspected: readonly { path: string; error: string | null }[],
): { usable: string[]; missing: string[] } {
  const usable: string[] = [];
  const missing: string[] = [];
  for (const item of inspected) (item.error ? missing : usable).push(item.path);
  return { usable, missing };
}
