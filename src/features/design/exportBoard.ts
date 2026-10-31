import { save } from "@tauri-apps/plugin-dialog";

import { writeFile } from "@/features/editor/ipc";
import { buildSrcdoc } from "@/features/canvas/design/srcdoc";

import { exportDocument, exportFileName } from "./htmlEdit";

/**
 * Exportar uma prancheta. HTML: o diálogo de salvar do sistema e o mesmo comando de escrita do editor
 * (`explorer_write_file`). PDF: imprimir; o diálogo de impressão do sistema salva como PDF.
 *
 * PNG fica de fora: desenhar o HTML num canvas por SVG `foreignObject` deixa o canvas "tainted" no
 * WebKit (o `toDataURL` falha), e o comando de escrita só grava texto.
 */
export async function exportHtml(board: { title: string; html: string }, title: string): Promise<string | null> {
  const path = await save({ title, defaultPath: exportFileName(board.title, "html"), filters: [{ name: "HTML", extensions: ["html"] }] });
  if (!path) return null;
  const out = await writeFile(path, exportDocument(board.html, board.title), null);
  if (out.kind === "conflict") throw new Error("conflict");
  return path;
}

/**
 * O sandbox da impressão: SEM `allow-scripts` (o HTML do agente não roda) e com `allow-same-origin`
 * só para o app poder chamar `print()` nesse documento estático; `allow-modals` libera o diálogo.
 * Nunca junto com `allow-scripts`.
 */
export const PRINT_SANDBOX = "allow-modals allow-same-origin";

/** Imprime a prancheta num iframe escondido, do tamanho dela; sai sozinho depois. */
export function printBoard(board: { title: string; html: string; w: number; h: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", PRINT_SANDBOX);
    frame.setAttribute("aria-hidden", "true");
    frame.title = board.title;
    Object.assign(frame.style, { position: "fixed", left: "-10000px", top: "0", width: `${board.w}px`, height: `${board.h}px`, border: "0" });
    const page = `<style>@page{size:${Math.round(board.w)}px ${Math.round(board.h)}px;margin:0}</style>`;
    frame.srcdoc = buildSrcdoc(page + board.html);
    const cleanup = () => setTimeout(() => frame.remove(), 1000);
    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        cleanup();
      }
    };
    document.body.appendChild(frame);
  });
}
