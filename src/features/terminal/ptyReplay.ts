/**
 * Junta o scrollback de um PTY recém-criado com a saída ao vivo, sem perder nem repetir nada.
 *
 * O processo começa a escrever assim que nasce, mas o frontend só conhece o id do PTY depois de
 * `pty_create` e só ouve o evento depois de `listen`. Tudo o que saía nesse intervalo (o prompt
 * do shell, o banner de um agente) se perdia e o terminal abria em branco. Agora: escuta-se
 * primeiro, enfileirando; pede-se o snapshot (que traz o `total` de bytes do fluxo); escreve-se o
 * snapshot e depois só o que passou do `total` — cada evento carrega `end`, a posição do fluxo
 * onde ele termina, e o que termina até o `total` já veio no snapshot.
 */
export interface PtyChunk { data: string; end?: number }

export function createPtyReplay(write: (data: string) => void) {
  let total: number | null = null;
  const queue: PtyChunk[] = [];

  const deliver = (chunk: PtyChunk) => {
    // Sem `end` (um aviso do app, não saída do processo) escreve sempre.
    if (total === null || chunk.end === undefined || chunk.end > total) write(chunk.data);
  };

  return {
    /** Um evento ao vivo: espera o snapshot, ou passa direto se ele já chegou. */
    push(chunk: PtyChunk) {
      if (total === null) queue.push(chunk);
      else deliver(chunk);
    },
    /** O snapshot chegou: escreve-o e solta o que esperava na fila (menos o que ele já cobria). */
    ready(snapshot: { data: string; total: number }) {
      if (snapshot.data) write(snapshot.data);
      total = snapshot.total;
      for (const chunk of queue.splice(0)) deliver(chunk);
    },
    /** Sem snapshot (o processo já terminou): só a fila, tudo o que chegou ao vivo. */
    abort() {
      total = -1;
      for (const chunk of queue.splice(0)) deliver(chunk);
    },
  };
}
