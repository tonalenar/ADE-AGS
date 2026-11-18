/** Identifica a chamada assíncrona vigente: só a última aplica o resultado. */
export function createGeneration() {
  let current = 0;
  return {
    next(): number {
      current += 1;
      return current;
    },
    isCurrent(id: number): boolean {
      return id === current;
    },
  };
}
