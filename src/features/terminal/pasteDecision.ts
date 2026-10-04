export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const PASTE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export interface PasteItem {
  kind: string;
  type: string;
  size?: number;
}

export type PasteDecision =
  | { action: "image"; index: number }
  | { action: "text" }
  | { action: "reject"; reason: "type" | "size" };

/** ¿Pegar una imagen o texto? Una imagen válida gana; si hay texto, el texto sigue como siempre. */
export function decidePaste(items: PasteItem[], text: string): PasteDecision {
  let reject: "type" | "size" | null = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== "file" || !it.type.startsWith("image/")) continue;
    if (!PASTE_IMAGE_TYPES.includes(it.type.toLowerCase())) { reject ??= "type"; continue; }
    if (it.size !== undefined && it.size > MAX_IMAGE_BYTES) { reject ??= "size"; continue; }
    return { action: "image", index: i };
  }
  if (text.length > 0 || !reject) return { action: "text" };
  return { action: "reject", reason: reject };
}
