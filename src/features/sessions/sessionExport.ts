/** Escolhe o destino e grava. Qualquer rejeição (diálogo ou escrita) sobe para o caller tratar. */
export async function pickAndExport(
  pick: () => Promise<string | null | undefined>,
  write: (dest: string) => Promise<void>,
): Promise<"cancel" | "ok"> {
  const dest = await pick();
  if (!dest) return "cancel";
  await write(dest);
  return "ok";
}
