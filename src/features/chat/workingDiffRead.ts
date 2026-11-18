import { scmWorkingDiff } from "./ipc";

/** A leitura em voo de cada pasta: quem pede a mesma pasta enquanto ela roda recebe a mesma resposta. */
const inFlight = new Map<string, ReturnType<typeof scmWorkingDiff>>();

/**
 * O `git diff HEAD` de uma pasta, lido uma vez por vez. O Diff da conversa e o `+/−` da barra ouvem o mesmo
 * crescimento e pedem a mesma pasta: sem isto, cada crescimento fazia duas leituras do repositório.
 */
export function readWorkingDiff(cwd: string): ReturnType<typeof scmWorkingDiff> {
  const running = inFlight.get(cwd);
  if (running) return running;
  const read = scmWorkingDiff(cwd).finally(() => { inFlight.delete(cwd); });
  inFlight.set(cwd, read);
  return read;
}
