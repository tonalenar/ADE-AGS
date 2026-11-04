/** Consulta sob demanda; ignora respostas de aparelhos anteriores e remove o ouvinte ao sair. */
export function observeForegroundApp(
  target: EventTarget,
  load: () => Promise<string | null>,
  update: (bundle: string | null) => void,
): () => void {
  let alive = true;
  let revision = 0;
  const refresh = () => {
    const request = ++revision;
    void load().then((bundle) => {
      if (alive && request === revision) update(bundle);
    }).catch(() => undefined);
  };
  target.addEventListener("focus", refresh);
  refresh();
  return () => { alive = false; target.removeEventListener("focus", refresh); };
}
