/**
 * O que se escreve DEPOIS de repor o histórico guardado de uma terminal, antes de o processo novo desenhar.
 *
 * O histórico é a saída crua do processo anterior. Se ele morreu com uma TUI desenhada (o painel de diff do Claude Code, um
 * diálogo, a tela alternativa do OpenCode), repor os bytes recria esse quadro na tela, e o processo novo, que desenha por cima só o
 * que é dele, deixa o resto: um painel velho cobrindo metade do terminal. Então: sai da tela alternativa, desliga o mouse e as
 * marcas de texto, e empurra o último quadro para o histórico com linhas em branco, deixando a tela livre para o processo novo.
 * O que foi escrito continua lá, para rolar para cima. Pura.
 */
export function scrollbackEnd(rows: number): string {
  const modes = [
    "\u001b[?1049l", // sai da tela alternativa
    "\u001b[?1000l", "\u001b[?1002l", "\u001b[?1003l", "\u001b[?1006l", // sem relato de mouse
    "\u001b[?2004l", // sem colar entre marcas (o processo novo pede de novo)
    "\u001b[0m", "\u001b[?25h", "\u001b(B",
  ].join("");
  return modes + "\r\n".repeat(Math.max(rows, 40));
}
