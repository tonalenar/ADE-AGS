/**
 * A fonte da terminal, pedida cedo e sem segurar a home.
 *
 * Um `@font-face` não baixa nada até alguém usá-lo, e o xterm mede a célula no
 * instante em que abre. Medir com a fonte de reserva deixa a grade com outra
 * largura e a TUI nasce com colunas que não são as reais. Por isso a promise
 * existe: a home pinta na hora, e só a primeira medição do xterm espera.
 *
 * O teto é o mesmo de antes. Sem a fonte, a app abre com a de reserva.
 */
const TERMINAL_FONT = '13px "JetBrains Mono Variable"';
const FONT_WAIT_MS = 1500;

function loadTerminalFont(): Promise<void> {
  const fonts = globalThis.document?.fonts;
  const pending = fonts?.load
    ? fonts.load(TERMINAL_FONT).then(() => undefined).catch(() => undefined)
    : Promise.resolve();
  return Promise.race([
    pending,
    new Promise<void>((resolve) => {
      setTimeout(resolve, FONT_WAIT_MS);
    }),
  ]);
}

/** Resolve quando a JetBrains Mono pode ser medida, ou aos 1,5 s com a reserva. */
export const fontsReady: Promise<void> = loadTerminalFont();
