import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const SWEPT = "cc-runs-swept";

/**
 * A varredura de tarefas órfãs corre depois que a janela aparece. A frota não
 * lista nada até ela terminar: senão uma tarefa morta com o processo anterior
 * apareceria como `running`.
 */
export function whenSweepDone(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      unlisten?.();
      resolve();
    };
    listen(SWEPT, () => finish())
      .then((off) => {
        unlisten = off;
        if (settled) {
          off();
          return;
        }
        invoke<boolean>("runs_sweep_done")
          .then((done) => {
            if (done) finish();
          })
          .catch(() => finish());
      })
      .catch(() => finish());
  });
}
