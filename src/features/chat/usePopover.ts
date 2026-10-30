import { useEffect, useRef, useState } from "react";

/** Um popover que fecha ao clicar fora ou com Esc. `ref` vai no contêiner (gatilho + menu). */
export function usePopover<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      // O menu de um seletor (PopupSelect) é desenhado num portal, fora deste contêiner. Clicar nele
      // não é sair do popover: fechar aqui desmontaria o seletor antes da escolha ser registrada.
      if ((e.target as Element).closest?.("[data-popup-menu]")) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}
