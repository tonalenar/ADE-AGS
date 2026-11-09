import { Terminal } from "@/features/terminal/LazyTerminal";
import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";
import { accountLoginAccountId, accountLoginCommand } from "./login";

interface LoginTerminalProps {
  account: AgentAccount;
}

/**
 * Terminal efímera, dedicada a loguearse en una cuenta.
 *
 * Es una `Terminal` normal con dos diferencias que importan:
 *
 * - Envía solo el ID de la cuenta; Rust resuelve el perfil al crear el proceso, así que el
 *   login que hagas acá adentro queda en ESA cuenta y no toca la del sistema.
 * - No es una tab: no se persiste, no aparece en el historial de sesiones y su proceso
 *   muere al cerrar el diálogo (el cleanup de `Terminal` mata el PTY al desmontar).
 *
 * El cwd es el home y no un proyecto: loguearse no tiene nada que ver con un repo, y
 * arrancar una TUI dentro de un proyecto puede disparar su indexado o sus permisos de
 * carpeta — ruido innecesario para un flujo que solo tiene que llegar al navegador.
 */
export function LoginTerminal({ account }: LoginTerminalProps) {
  const load = useAccountsStore((s) => s.load);
  return (
    <div className="h-96 rounded-lg overflow-hidden border border-gray-200 dark:border-white/10">
      <Terminal
        command={accountLoginCommand(account)}
        agentId={account.agentId}
        accountId={accountLoginAccountId(account.id)}
        isActive
        // Al salir la TUI se refresca la lista: si el login funcionó, la fila de la cuenta
        // pasa a mostrar el mail en vez de "sin iniciar sesión".
        onExit={() => { load().catch(console.error); }}
      />
    </div>
  );
}
