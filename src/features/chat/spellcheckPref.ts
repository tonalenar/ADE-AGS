import { useEffect } from "react";

import { useChatPrefs } from "./chatPrefs";

/**
 * O `spellcheck` do `<html>` vale para todo campo de texto que não declara o seu: ligar ou desligar o corretor
 * nas Configurações alcança os campos longos de qualquer tela. Os campos de código, caminho e comando seguem com
 * `spellCheck={false}` próprio.
 */
export function useDocumentSpellcheck(): void {
  const enabled = useChatPrefs().spellcheck;
  useEffect(() => {
    document.documentElement.spellcheck = enabled;
  }, [enabled]);
}
