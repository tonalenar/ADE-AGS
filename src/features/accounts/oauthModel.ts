/**
 * Conectar uma conta do Antigravity pelo OAuth PRÓPRIO do app (para ler a cota de uso). Lógica pura da tela;
 * o fluxo em si (cofre do sistema, callback local, troca do código) é do backend (`antigravity_oauth.rs`).
 */

/** O mesmo teste do backend (`valid_client`): o id de um cliente OAuth Google termina assim e só tem estes caracteres. Pura. */
export function clientIdLooksValid(id: string): boolean {
  const value = id.trim();
  return value.length > 0 && value.length <= 512 && value.endsWith(".apps.googleusercontent.com") && /^[A-Za-z0-9._-]+$/.test(value);
}

/** O segredo não pode ser vazio, passar de 512 caracteres nem ter caracteres de controle (igual ao backend). Pura. */
export function clientSecretLooksValid(secret: string): boolean {
  return secret.length > 0 && secret.length <= 512 && !/[\u0000-\u001f\u007f]/.test(secret);
}

/** O nome da conta: 1 a 100 caracteres, sem controle. Pura. */
export function accountNameLooksValid(name: string): boolean {
  const value = name.trim();
  return value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Mostra só o começo e o fim do id do cliente: o resto não precisa ficar à vista. Pura. */
export function maskClientId(id: string): string {
  const [head] = id.split(".apps.googleusercontent.com");
  return head.length <= 12 ? id : `${head.slice(0, 8)}…${head.slice(-4)}.apps.googleusercontent.com`;
}

/** Só se abre no navegador um endereço https do Google: o app nunca abre o que o backend não montou. Pura. */
export function isGoogleAuthUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "accounts.google.com";
  } catch {
    return false;
  }
}
