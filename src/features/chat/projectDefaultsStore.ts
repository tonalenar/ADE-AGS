import { create } from "zustand";

import type { ChatAccess } from "./chatModel";
import { normalizeProjectPath } from "./projectPath";
import {
  chatProjectDefaultsClear,
  chatProjectDefaultsList,
  chatProjectDefaultsSave,
  type ProjectChatDefaultsDto,
} from "./projectChatDefaults";

/**
 * O espelho, no front, dos padrões de conversa por projeto que o backend guarda (`project_chat_defaults.rs`).
 * Fica numa store para a página Projetos e o composer lerem o mesmo valor, de forma síncrona, e se atualizarem
 * quando ele muda. O banco é a fonte; aqui só há a cópia da sessão.
 *
 * `versions` conta, por projeto, as mudanças que vieram de fora de quem está olhando (a carga do banco e a página
 * Projetos). O composer reaplica os padrões quando a versão do projeto dele muda. As gravações do próprio composer
 * não contam: elas não devem desfazer o que a pessoa acabou de escolher na tela.
 */
export interface ProjectDefaultsState {
  readonly byKey: Readonly<Record<string, ProjectChatDefaultsDto>>;
  readonly versions: Readonly<Record<string, number>>;
  readonly hydrated: boolean;
}

export const useProjectDefaultsStore = create<ProjectDefaultsState>(() => ({ byKey: {}, versions: {}, hydrated: false }));

const sameDto = (a: ProjectChatDefaultsDto | undefined, b: ProjectChatDefaultsDto | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Os padrões do projeto, ou `null`. Síncrono (lê o espelho). */
export function getProjectDefaults(cwd: string | null): ProjectChatDefaultsDto | null {
  if (!cwd) return null;
  return useProjectDefaultsStore.getState().byKey[normalizeProjectPath(cwd)] ?? null;
}

/** A versão do projeto, para o React reagir. */
export function useProjectDefaultsVersion(cwd: string | null): number {
  return useProjectDefaultsStore((s) => (cwd ? s.versions[normalizeProjectPath(cwd)] ?? 0 : 0));
}

/** Os padrões do projeto como hook. */
export function useProjectDefaults(cwd: string | null): ProjectChatDefaultsDto | null {
  return useProjectDefaultsStore((s) => (cwd ? s.byKey[normalizeProjectPath(cwd)] ?? null : null));
}

function put(dto: ProjectChatDefaultsDto | null, key: string, opts: { notify: boolean }): void {
  useProjectDefaultsStore.setState((s) => {
    const byKey = { ...s.byKey };
    if (dto) byKey[key] = dto;
    else delete byKey[key];
    const versions = opts.notify ? { ...s.versions, [key]: (s.versions[key] ?? 0) + 1 } : s.versions;
    return { byKey, versions };
  });
}

/** Um registro sem nada fixado equivale a nenhum registro. */
export const isEmptyDefaults = (dto: ProjectChatDefaultsDto): boolean =>
  !dto.primary && !dto.fallback && !dto.workspace && !dto.access;

/** Avisa os composers abertos de que os padrões do projeto mudaram por fora deles (a página Projetos). */
export function notifyProjectDefaults(cwd: string): void {
  const key = normalizeProjectPath(cwd);
  useProjectDefaultsStore.setState((s) => ({ versions: { ...s.versions, [key]: (s.versions[key] ?? 0) + 1 } }));
}

let inflight: Promise<void> | null = null;

/**
 * Lê do banco todos os padrões gravados. Idempotente: junta pelo caminho e só avisa (versão) os projetos cujo valor
 * mudou. Falha de leitura deixa o espelho como está, e o composer segue com o que já tinha no aparelho.
 */
export function hydrateProjectDefaults(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && useProjectDefaultsStore.getState().hydrated) return Promise.resolve();
  inflight = chatProjectDefaultsList()
    .then((list) => {
      const incoming = new Map(list.map((dto) => [normalizeProjectPath(dto.cwd), dto]));
      const state = useProjectDefaultsStore.getState();
      const keys = new Set([...Object.keys(state.byKey), ...incoming.keys()]);
      const byKey: Record<string, ProjectChatDefaultsDto> = {};
      const versions = { ...state.versions };
      for (const key of keys) {
        const next = incoming.get(key);
        if (next) byKey[key] = next;
        if (!sameDto(state.byKey[key], next)) versions[key] = (versions[key] ?? 0) + 1;
      }
      useProjectDefaultsStore.setState({ byKey, versions, hydrated: true });
    })
    .catch(() => undefined)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Grava no banco e no espelho. O espelho muda primeiro (a tela responde na hora); se o banco recusar, volta ao que
 * era e o erro sobe. `notify` avisa os composers abertos (a página Projetos liga; o composer, não).
 */
export async function commitProjectDefaults(dto: ProjectChatDefaultsDto, opts: { notify: boolean }): Promise<void> {
  const key = normalizeProjectPath(dto.cwd);
  const before = useProjectDefaultsStore.getState().byKey[key] ?? null;
  const empty = isEmptyDefaults(dto);
  put(empty ? null : { ...dto, cwd: key }, key, opts);
  try {
    const saved = await chatProjectDefaultsSave({ ...dto, cwd: key });
    // O backend é quem normaliza: o que ele devolve é o que vale.
    const current = useProjectDefaultsStore.getState().byKey[key];
    if (saved && !sameDto(current, saved)) put(saved, key, { notify: false });
  } catch (error) {
    put(before, key, opts);
    throw error;
  }
}

/** Apaga todos os padrões do projeto (banco e espelho). */
export async function clearProjectDefaultsFor(cwd: string, opts: { notify: boolean }): Promise<void> {
  const key = normalizeProjectPath(cwd);
  const before = useProjectDefaultsStore.getState().byKey[key] ?? null;
  put(null, key, opts);
  try {
    await chatProjectDefaultsClear(key);
  } catch (error) {
    put(before, key, opts);
    throw error;
  }
}

/** Monta o registro a partir dos campos soltos. Útil para quem só muda uma parte. */
export function withDefaults(
  cwd: string,
  patch: Partial<Pick<ProjectChatDefaultsDto, "primary" | "fallback" | "workspace" | "access">>,
): ProjectChatDefaultsDto {
  const base = getProjectDefaults(cwd) ?? { cwd: normalizeProjectPath(cwd), primary: null, fallback: null, workspace: null, access: null as ChatAccess | null };
  return { ...base, ...patch, cwd: normalizeProjectPath(cwd) };
}
