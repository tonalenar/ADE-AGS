import { AlertaToast } from "@/shared/ui/alerts";
import { uiErrorText } from "@/shared/uiErrorText";

/** Liga o switch na hora e desfaz se a gravação falhar. */
export async function persistToggle(
  next: boolean,
  setLocal: (value: boolean) => void,
  persist: () => Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  const previous = !next;
  setLocal(next);
  try {
    await persist();
  } catch (error) {
    setLocal(previous);
    onError(error);
  }
}

export function toastToggleError(title: string, error: unknown): void {
  void AlertaToast(title, uiErrorText(error), "error", 6000);
}
