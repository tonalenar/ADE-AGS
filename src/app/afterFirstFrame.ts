import { invoke } from "@tauri-apps/api/core";

/**
 * Depois que o navegador pintou um quadro. Dois `requestAnimationFrame`: o
 * primeiro só agenda o seguinte, e esse já corre com o quadro na tela.
 */
export function afterFirstFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/** Avisa o backend que a janela principal já pintou, para ele abrir as outras. */
export function restoreDeferredWindowsAfterFirstFrame(): void {
  afterFirstFrame()
    .then(() => invoke("restore_deferred_windows"))
    .catch((error) => console.error(error));
}
