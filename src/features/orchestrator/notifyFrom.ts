/** O título do aviso não vem do agente: ignora `from` e usa o nome da aba, ou o genérico. */
export function notifyFromLabel(tabTitle: string | undefined): string {
  const name = tabTitle?.replace(/[\r\n]+/g, " ").trim().slice(0, 80);
  return name || "Agente";
}
