import { COMPOSER_FADE, listBottomInset } from "./composerLayout";
import { useElementHeight } from "./ComposerColumn";

/**
 * O quadro da conversa como no Claude Code: a lista rola POR BAIXO do composer. A lista ocupa a altura
 * toda; o composer é um bloco sólido sobreposto ao fim dela, com um degradê curto no alto para o texto
 * que desce "entrar" na caixa. A altura real do composer (medida) vira o espaço no fim da lista, para a
 * última mensagem poder subir acima do cartão. O degradê deixa a barra de rolagem livre à direita.
 */
export function ChatFrame({ list, composer }: { list: (bottomInset: number) => React.ReactNode; composer: React.ReactNode }) {
  const { ref, height } = useElementHeight<HTMLDivElement>();
  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      {list(listBottomInset(height))}
      <div ref={ref} className="absolute inset-x-0 bottom-0 pointer-events-none">
        <div aria-hidden="true" style={{ height: COMPOSER_FADE }} className="mr-3.5 bg-gradient-to-t from-white dark:from-surface-deep to-transparent" />
        <div className="mr-3.5 pointer-events-auto bg-white dark:bg-surface-deep">{composer}</div>
      </div>
    </div>
  );
}
