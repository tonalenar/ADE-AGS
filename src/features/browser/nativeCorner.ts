import { createContext } from "react";

/**
 * O raio, em px da janela, dos cantos da tela do aparelho em volta da vista nativa do navegador. A vista nativa fica
 * por cima do DOM e não é recortada pelo `border-radius` da moldura; sem isto ela vaza pelos cantos arredondados.
 * 0 fora do modo aparelho.
 */
export const NativeCornerRadius = createContext(0);
