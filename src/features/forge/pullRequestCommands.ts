const COPY_NUMBER_BUTTON = "[data-ade-pr-copy-number]";

function visibleCopyNumberButton(): HTMLButtonElement | null {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  for (const button of document.querySelectorAll<HTMLButtonElement>(COPY_NUMBER_BUTTON)) {
    if (button.disabled || button.getClientRects().length === 0) continue;
    let current: Element | null = button;
    let visible = true;
    while (current) {
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") {
        visible = false;
        break;
      }
      current = current.parentElement;
    }
    if (visible) return button;
  }
  return null;
}

/** O atalho e a paleta só atuam sobre o botão de um PR realmente visível nesta janela. */
export function isPullRequestCopyAvailable(): boolean {
  return visibleCopyNumberButton() !== null;
}

export function copyVisiblePullRequestNumber(): boolean {
  const button = visibleCopyNumberButton();
  if (!button) return false;
  button.click();
  return true;
}
