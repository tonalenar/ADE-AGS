import type { TeamProvision } from "./ipc";

/**
 * Os integrantes "fantasma" da sidebar: um integrante novo gravado como `provisioning` ou `failed` que nunca virou
 * integrante de verdade (a conversa não abriu, o app caiu no meio, a pessoa fechou antes de ligar). O backend guarda a linha
 * (nada se apaga), então a tela decide até quando mostrar: o fracasso fica visível por um tempo, para a pessoa ler o
 * motivo, e depois some sozinho; "entrando no time…" que passou do razoável também. A pessoa pode dispensar na hora.
 */
export const FAILED_VISIBLE_MS = 10 * 60_000;
export const ENTERING_VISIBLE_MS = 15 * 60_000;

const DISMISSED_KEY = "ags.team.provisionsDismissed.v1";

export function visibleProvisions(list: readonly TeamProvision[], now: number, dismissed: ReadonlySet<string>): TeamProvision[] {
  return list.filter((p) => {
    if (p.state === "active" || dismissed.has(p.id)) return false;
    const limit = p.state === "failed" ? FAILED_VISIBLE_MS : ENTERING_VISIBLE_MS;
    return now - p.updatedAt < limit;
  });
}

export function loadDismissedProvisions(storage: Pick<Storage, "getItem"> = localStorage): Set<string> {
  try {
    const raw = JSON.parse(storage.getItem(DISMISSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Lembra a dispensa nesta máquina (só esconde; o registro do time não muda). Guarda os 200 mais recentes. */
export function dismissProvision(id: string, storage: Pick<Storage, "getItem" | "setItem"> = localStorage): Set<string> {
  const next = [...loadDismissedProvisions(storage), id].slice(-200);
  try {
    storage.setItem(DISMISSED_KEY, JSON.stringify(next));
  } catch {
    /* sem armazenamento, a dispensa vale só até recarregar */
  }
  return new Set(next);
}
