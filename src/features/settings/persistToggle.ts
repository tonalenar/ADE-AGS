import { AlertaToast } from "@/shared/ui/alerts";

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
  void AlertaToast(title, String(error), "error", 6000);
}
