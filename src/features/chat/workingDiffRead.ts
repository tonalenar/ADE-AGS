import { scmWorkingDiff, scmWorkingDiffStat } from "./ipc";

/** A leitura em voo de cada pasta: quem pede a mesma pasta enquanto ela roda recebe a mesma resposta. */
const inFlight = new Map<string, ReturnType<typeof scmWorkingDiff>>();
const statInFlight = new Map<string, ReturnType<typeof scmWorkingDiffStat>>();

/**
 * O `git diff HEAD` de uma pasta, lido uma vez por vez. O Diff da conversa e o Resumo ouvem o mesmo
 * crescimento e pedem a mesma pasta: sem isto, cada crescimento fazia leituras duplicadas do repositório.
 */
export function readWorkingDiff(cwd: string): ReturnType<typeof scmWorkingDiff> {
  const running = inFlight.get(cwd);
  if (running) return running;
  const read = scmWorkingDiff(cwd).finally(() => { inFlight.delete(cwd); });
  inFlight.set(cwd, read);
  return read;
}

/**
 * Totais `+`/`−` da pasta via `git diff HEAD --numstat`, lido uma vez por vez (single-flight).
 * A barra lateral só precisa dos totais no tooltip, sem transferir nem parsear o patch completo.
 */
export function readWorkingDiffStat(cwd: string): ReturnType<typeof scmWorkingDiffStat> {
  const running = statInFlight.get(cwd);
  if (running) return running;
  const read = scmWorkingDiffStat(cwd).finally(() => { statInFlight.delete(cwd); });
  statInFlight.set(cwd, read);
  return read;
}
