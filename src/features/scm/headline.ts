/** O que o cabeçalho do painel deve dizer sobre a branch atual. */

export type ScmHeadline =
  | { kind: "initial"; branch: string | null }
  | { kind: "branch"; branch: string }
  | { kind: "detached"; head: string }
  | { kind: "empty" };

/** `initial` vem do `git status` quando ainda não há commit. Nesse caso a branch
 *  existe no nome (`main`) mas não há HEAD para mostrar. */
export function scmHeadline(status: {
  branch: string | null;
  head: string | null;
  initial: boolean;
}): ScmHeadline {
  if (status.initial) return { kind: "initial", branch: status.branch };
  if (status.branch) return { kind: "branch", branch: status.branch };
  if (status.head) return { kind: "detached", head: status.head };
  return { kind: "empty" };
}
