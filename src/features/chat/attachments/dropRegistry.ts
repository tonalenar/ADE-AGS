import { create } from "zustand";

/**
 * Para onde vai o que a pessoa solta na janela: o composer do chat que está à vista se registra aqui, e o
 * ouvinte do arrasto nativo (`useChatFileDrop`) entrega os caminhos a ele. Só um composer vale de cada vez
 * (o último registrado): a tela "Nova conversa" e a conversa aberta nunca aparecem juntas.
 */
export interface DropSink {
  addPaths: (paths: string[]) => void;
}

const stack: DropSink[] = [];

export function registerDropSink(sink: DropSink): () => void {
  stack.push(sink);
  return () => {
    const at = stack.lastIndexOf(sink);
    if (at >= 0) stack.splice(at, 1);
  };
}

export const activeDropSink = (): DropSink | null => stack[stack.length - 1] ?? null;

/** O realce "Solte para anexar" na coluna do chat enquanto algo é arrastado por cima dela. */
export const useDropHighlight = create<{ on: boolean }>(() => ({ on: false }));

export function setDropHighlight(on: boolean): void {
  if (useDropHighlight.getState().on !== on) useDropHighlight.setState({ on });
}

/** O ponto (em px lógicos) está dentro do retângulo do elemento? Pura no retângulo. */
export function insideRect(rect: { left: number; top: number; right: number; bottom: number }, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
