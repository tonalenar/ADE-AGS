/**
 * Uma confirmação da PRÓPRIA app, no lugar do diálogo nativo do sistema (`ask` do plugin de diálogo), que
 * abre uma janela do Windows fora do tema, sem espaço para explicar nada.
 *
 * `appConfirm(...)` devolve uma promessa: `true` = confirmou, `false` = escolheu ficar ou fechou. Quem a
 * mostra é o `AppConfirmHost`, montado uma vez no shell. Pedidos simultâneos entram em fila.
 */
import { create } from "zustand";

export interface ConfirmRequest {
  title: string;
  /** A frase principal. */
  lead: string;
  /** Uma lista curta que a frase introduz (os agentes que estão trabalhando, por exemplo). */
  items?: string[];
  /** O que acontece ao continuar: texto menor, abaixo. */
  note?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** `warning` (padrão) pinta o diálogo de atenção; `danger` também o botão de confirmar. */
  tone?: "warning" | "danger";
}

interface Pending extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

interface ConfirmState {
  queue: Pending[];
}

export const useConfirmStore = create<ConfirmState>(() => ({ queue: [] }));

export function appConfirm(request: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmStore.setState((s) => ({ queue: [...s.queue, { ...request, resolve }] }));
  });
}

/** Responde ao pedido da frente da fila e passa ao próximo. */
export function answerConfirm(ok: boolean): void {
  const [head, ...rest] = useConfirmStore.getState().queue;
  if (!head) return;
  useConfirmStore.setState({ queue: rest });
  head.resolve(ok);
}
