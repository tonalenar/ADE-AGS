/**
 * Um ciclo sem sobreposição: o próximo passo só é agendado `ms` DEPOIS que o anterior terminou
 * (inclusive a parte assíncrona, se o passo devolve uma promessa). Com `setInterval`, um passo lento
 * (uma consulta ao modelo, um IPC preso) corria junto com o seguinte.
 *
 * Um erro do passo (síncrono ou rejeição) vai para `onError` e o ciclo segue: um tick com defeito não
 * mata o vigia. Devolve a função que para o ciclo (o passo em andamento termina, mas nada mais é
 * agendado).
 */
export function repeatAfterEach(step: () => unknown, ms: number, onError?: (error: unknown) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (!stopped) timer = setTimeout(() => void run(), ms);
  };
  const run = async () => {
    try {
      await step();
    } catch (error) {
      try {
        onError?.(error);
      } catch {
        /* o relato do erro não derruba o ciclo */
      }
    } finally {
      schedule();
    }
  };
  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
