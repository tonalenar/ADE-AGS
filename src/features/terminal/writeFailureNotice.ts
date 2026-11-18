/**
 * Um aviso por rajada de entradas recusadas pelo terminal (fila cheia ou terminal encerrado). A primeira recusa
 * avisa; as seguintes não avisam de novo enquanto nenhuma escrita for aceita. Assim uma fila cheia que recusa
 * várias teclas seguidas não empilha avisos.
 */
export function createWriteFailureNotice(avisar: () => void) {
  let avisado = false;
  return {
    /** Uma escrita foi aceita: a próxima recusa é uma rajada nova. */
    aceita(): void {
      avisado = false;
    },
    recusa(): void {
      if (avisado) return;
      avisado = true;
      avisar();
    },
  };
}
