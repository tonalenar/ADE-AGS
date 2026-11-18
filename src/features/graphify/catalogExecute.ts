import type { GraphifyChoice, GraphifyRun } from "./ipc";

/** Monta o comando no backend com a escolha atual, sem usar o preview em cache. */
export async function renderCurrentLine(
  render: (id: string, choice: GraphifyChoice) => Promise<string>,
  id: string,
  choice: GraphifyChoice,
): Promise<string> {
  return render(id, choice);
}

/**
 * Monta o comando no backend no momento do Executar.
 * O preview da fila pode ser de um `graphifyRender` anterior; não pode ser o que roda.
 */
export async function executeRenderedCommand(
  render: (id: string, choice: GraphifyChoice) => Promise<string>,
  run: (line: string) => Promise<GraphifyRun>,
  id: string,
  choice: GraphifyChoice,
): Promise<GraphifyRun> {
  const line = await renderCurrentLine(render, id, choice);
  return run(line);
}

/** Só aplica o preview se esta geração ainda for a última pedida para o id. */
export function previewIsCurrent(latestGen: number | undefined, thisGen: number): boolean {
  return latestGen === thisGen;
}
