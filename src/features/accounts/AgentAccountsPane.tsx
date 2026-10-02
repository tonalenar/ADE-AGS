import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AddIcon, Avatar, Badge, Button, EmptyState, InfoIcon, Tooltip, TrashIcon, UserIcon,
} from "neogestify-ui-components";

import { useAccountsStore } from "@/features/accounts/store";
import type { AccountCapableAgent, AgentAccount } from "@/features/accounts/types";
import { AddAccountDialog } from "@/features/accounts/AddAccountDialog";
import { LoginTerminal } from "@/features/accounts/LoginTerminal";
import { AppDialog } from "@/shared/ui/AppDialog";

/** Una cuenta: nombre simbólico, quién está logueado, y qué se puede hacer con ella. */
const HEALTH_VARIANT = {
  ok: "success",
  not_logged_in: "warning",
  invalid: "danger",
  unknown: "neutral",
} as const;

/** El resultado de "Verificar": lo que dijo la CLI (o el proveedor), no el marcador del disco. */
function HealthBadge({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const health = useAccountsStore((s) => s.health[accountId]);
  if (!health) return null;
  if (health === "checking") {
    return <Badge variant="neutral" size="sm" className="shrink-0">{t("settings.accounts.health.checking")}</Badge>;
  }
  const extra = [health.email, health.plan, health.detail].filter(Boolean).join(" · ");
  return (
    <Tooltip content={extra} placement="bottom">
      <Badge variant={HEALTH_VARIANT[health.status]} size="sm" className="shrink-0">
        {t(`settings.accounts.health.${health.status}`)}
      </Badge>
    </Tooltip>
  );
}

function AccountRow({ account, onLogin, onDelete }: {
  account: AgentAccount;
  onLogin: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const checkHealth = useAccountsStore((s) => s.checkHealth);
  const checking = useAccountsStore((s) => s.health[account.id] === "checking");
  const byKey = account.kind === "api_key";

  return (
    <div className="cc-t group flex items-center gap-3 px-3 h-12 rounded-lg
      bg-white dark:bg-white/4
      hover:bg-gray-50 dark:hover:bg-white/6">

      {/* Iniciales en vez del logo de la TUI: en una lista de cuentas del MISMO servicio,
          repetir su logo en cada fila no distingue nada. El nombre sí — y de paso el
          Avatar deriva de él un color estable por cuenta. El punto de estado dice si
          tiene sesión iniciada. */}
      <Avatar
        name={account.name}
        size="sm"
        shape="square"
        status={account.loggedIn ? "online" : "offline"}
      />

      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-[12.5px] font-semibold text-gray-800 dark:text-gray-100">
            {account.name}
          </span>
          {byKey && (
            <Badge variant="info" size="sm" className="shrink-0">
              {t("settings.accounts.add.mode.apiKey")}
            </Badge>
          )}
          {!account.loggedIn && (
            <Badge variant="warning" size="sm" className="shrink-0">
              {t("settings.accounts.notLoggedIn")}
            </Badge>
          )}
          <HealthBadge accountId={account.id} />
        </div>
        {/* Cuando la TUI expone el mail se muestra: es lo que de verdad distingue una
            cuenta de otra — el nombre simbólico lo eligió el usuario y puede mentir.
            La ruta del perfil va en el tooltip: hace falta para depurar, pero mostrarla
            en cada fila llenaba la lista de texto que nadie lee. */}
        <Tooltip content={`${account.envVar}=${account.dir}`} placement="bottom">
          <span className="truncate text-[10.5px] text-gray-400 dark:text-white/35">
            {account.label ?? (account.loggedIn
              ? t("settings.accounts.loggedIn")
              : t("settings.accounts.pendingLogin"))}
          </span>
        </Tooltip>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <Button
          variant="outline"
          size="sm"
          disabled={checking}
          onClick={() => void checkHealth(account.id)}
        >
          {t("settings.accounts.health.check")}
        </Button>
        {/* Una cuenta por API key no tiene login que rehacer: se cambia la key creando
            otra cuenta. */}
        {!byKey && <Button
          variant={account.loggedIn ? "outline" : "primary"}
          size="sm"
          onClick={onLogin}
        >
          {account.loggedIn
            ? t("settings.accounts.relogin")
            : t("settings.accounts.login.btn")}
        </Button>}
        {onDelete && <Tooltip content={t("settings.accounts.delete.action")} placement="left">
          <Button variant="icon"
            onClick={onDelete}
            aria-label={t("settings.accounts.delete.action")}
            className="cc-t flex items-center justify-center w-7 h-7 rounded-md shrink-0
              text-gray-400 dark:text-white/35
              hover:text-red-500 dark:hover:text-red-400
              hover:bg-gray-200 dark:hover:bg-white/10 p-0"
          >
            <TrashIcon className="w-3.5 h-3.5" />
          </Button>
        </Tooltip>}
      </div>
    </div>
  );
}

/** Las cuentas de una TUI: sus perfiles, el login de cada uno y cómo borrarlos. */
export function AgentAccountsPane({ agent }: { agent: AccountCapableAgent }) {
  const { t } = useTranslation();
  const accounts = useAccountsStore((s) => s.accounts);
  const systemAccounts = useAccountsStore((s) => s.systemAccounts);
  const load = useAccountsStore((s) => s.load);
  const remove = useAccountsStore((s) => s.remove);
  const [adding, setAdding] = useState(false);
  const [loginFor, setLoginFor] = useState<AgentAccount | null>(null);
  const [deleting, setDeleting] = useState<AgentAccount | null>(null);
  const [error, setError] = useState("");

  const rows = useMemo(
    () => accounts.filter((a) => a.agentId === agent.agentId),
    [accounts, agent.agentId]
  );

  const handleDelete = async (deleteFiles: boolean) => {
    if (!deleting) return;
    try {
      await remove(deleting.id, deleteFiles);
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2 h-9 shrink-0 px-4
        border-b border-gray-200 dark:border-white/8">
        <span className="flex-1 min-w-0 truncate text-[11.5px] font-semibold
          text-gray-700 dark:text-gray-300">
          {t("settings.accounts.of", { agent: agent.label })}
        </span>
        <Badge variant="info" size="sm" className="font-mono shrink-0">
          {agent.envVar}
        </Badge>
        <Tooltip content={t("settings.accounts.add")} placement="bottom">
          <Button variant="icon"
            onClick={() => setAdding(true)}
            disabled={!agent.installed}
            aria-label={t("settings.accounts.add")}
            className="cc-t flex items-center justify-center w-6 h-6 rounded-md shrink-0
              text-gray-400 dark:text-white/35
              hover:text-gray-700 dark:hover:text-white
              hover:bg-gray-200 dark:hover:bg-white/10
              disabled:opacity-40 disabled:hover:bg-transparent p-0"
          >
            <AddIcon className="w-3.5 h-3.5" />
          </Button>
        </Tooltip>
      </div>

      <div className="flex-1 min-h-0 cc-scroll flex flex-col gap-1.5 p-3">
        {systemAccounts.filter((a) => a.agentId === agent.agentId).map((account) => (
          <AccountRow key={account.id} account={account} onLogin={() => setLoginFor(account)} />
        ))}
        {rows.length === 0 ? (
          <EmptyState
            className="m-auto"
            icon={<UserIcon className="w-7 h-7" />}
            title={t("settings.accounts.emptyForAgent")}
            action={
              <Button
                variant="primary"
                size="sm"
                disabled={!agent.installed}
                onClick={() => setAdding(true)}
              >
                {t("settings.accounts.add")}
              </Button>
            }
          />
        ) : (
          rows.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              onLogin={() => setLoginFor(account)}
              onDelete={() => setDeleting(account)}
            />
          ))
        )}
      </div>

      {error && (
        <p className="shrink-0 px-4 pb-2 text-[11px] text-red-500 dark:text-red-400">
          {error}
        </p>
      )}

      {/* La cuenta del sistema siempre está y no se administra desde acá: es la que
          usan las tabs que no eligen ninguna, y borrarla desde la app sería borrar
          el login que el usuario hizo por fuera. */}
      <div className="flex items-start gap-2 shrink-0 px-4 py-2
        border-t border-gray-200 dark:border-white/8
        bg-gray-100/60 dark:bg-black/20
        text-[10.5px] text-gray-400 dark:text-white/35">
        <InfoIcon className="w-3.5 h-3.5 mt-px shrink-0" />
        <span>{t("settings.accounts.systemDefault")}</span>
      </div>

      {adding && (
        <AddAccountDialog agentId={agent.agentId} onClose={() => setAdding(false)} />
      )}

      {loginFor && (
        <AppDialog
          title={t("settings.accounts.login.title", { name: loginFor.name })}
          onClose={() => { setLoginFor(null); load().catch((e) => setError(String(e))); }}
          size="lg"
          closeOnBackdrop={false}
          closeOnEsc={false}
          footer={
            <Button variant="primary" onClick={() => { setLoginFor(null); load().catch((e) => setError(String(e))); }}>
              {t("settings.accounts.login.done")}
            </Button>
          }
        >
          <p className="text-xs text-gray-500 dark:text-white/50 mb-3">
            {t("settings.accounts.login.helper", { command: loginFor.loginCommand })}
          </p>
          <LoginTerminal account={loginFor} />
        </AppDialog>
      )}

      {deleting && (
        <AppDialog
          title={t("settings.accounts.delete.title", { name: deleting.name })}
          onClose={() => setDeleting(null)}
          size="sm"
          footer={
            <>
              <Button variant="outline" onClick={() => setDeleting(null)}>
                {t("btn.cancel")}
              </Button>
              {/* Dos salidas distintas a propósito: quitarla de la app es reversible
                  (se vuelve a agregar con el mismo nombre y el login sigue ahí), borrar la
                  carpeta con las credenciales no lo es. */}
              <Button variant="outline" onClick={() => handleDelete(false)}>
                {t("settings.accounts.delete.keepFiles")}
              </Button>
              <Button variant="danger" onClick={() => handleDelete(true)}>
                {t("settings.accounts.delete.withFiles")}
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t("settings.accounts.delete.body")}
          </p>
          <code className="block mt-2 text-[11px] font-mono break-all
            text-gray-500 dark:text-gray-400">
            {deleting.dir}
          </code>
        </AppDialog>
      )}
    </>
  );
}
