import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge, Button, Input,
} from "neogestify-ui-components";

import { accountFormMode, programPresent } from "@/features/agents/accountConnect";
import { useAccountsStore } from "@/features/accounts/store";
import { useTabsStore } from "@/features/tabs/store";
import type { AgentAccount } from "@/features/accounts/types";
import { LoginTerminal } from "@/features/accounts/LoginTerminal";
import { AccountColorPicker } from "@/features/accounts/AccountColorPicker";
import { MultipleAccountsNote } from "@/features/accounts/MultipleAccountsNote";
import { agentIcon } from "@/features/agents/agentIcons";
import { AppDialog } from "@/shared/ui/AppDialog";
import { PanelBoundary } from "@/app/PanelBoundary";

interface AddAccountDialogProps {
  /** El servicio para el que se crea. Viene de la sección en la que estás parado, y no se
   *  vuelve a preguntar: ya lo elegiste al entrar ahí. */
  agentId: string;
  onClose: () => void;
  /** Com qual forma de entrada o formulário abre (a página Providers já a escolheu). */
  initialMode?: "login" | "api_key";
}

/**
 * Alta de una cuenta: ponerle nombre y loguearse.
 *
 * Antes preguntaba OTRA VEZ de qué TUI era, con un selector igual al de la pantalla desde
 * la que se abre. Estando en la sección de Claude Code, el botón de agregar solo puede
 * querer decir una cosa — y peor, el selector dejaba crear la cuenta en otro servicio y
 * aparecer en una sección distinta de la que estabas mirando.
 *
 * El login es una terminal de verdad y no un formulario de mail y contraseña: el de estas
 * CLIs es un flujo propio (abre el navegador, pide un código, elige plan) y cambia entre
 * versiones. Reimplementarlo significaría manejar credenciales acá adentro y romperse en la
 * próxima actualización de la TUI. Corriendo el login real, la app nunca ve una credencial.
 */
export function AddAccountDialog({ agentId, onClose, initialMode = "login" }: AddAccountDialogProps) {
  const { t } = useTranslation();
  const capable = useAccountsStore((s) => s.capable);
  const accounts = useAccountsStore((s) => s.accounts);
  const create = useAccountsStore((s) => s.create);
  const createWithApiKey = useAccountsStore((s) => s.createWithApiKey);
  const checkHealth = useAccountsStore((s) => s.checkHealth);
  const setIdentity = useAccountsStore((s) => s.setIdentity);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [mode, setMode] = useState<"login" | "api_key">(initialMode);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** Cuenta ya creada: pasamos a la terminal de login. */
  const [created, setCreated] = useState<AgentAccount | null>(null);

  const agent = capable.find((c) => c.agentId === agentId);
  const seen = useTabsStore((s) => s.detectedAgents.some((a) => a.id === agentId && a.available));
  const taken = accounts.some((a) => a.agentId === agentId && a.name === name.trim());
  const form = agent ? accountFormMode(agentId, programPresent(agent.installed, seen), true) : "blocked";
  const showKey = form === "api-key" || form === "both";
  const showLogin = form === "login" || form === "both";
  const usingKey = showKey && (form === "api-key" || mode === "api_key");
  const canCreate = !!agent && form !== "blocked" && !!name.trim() && !taken && (!usingKey || apiKey.trim().length > 0);

  // Nome de exibição e cor são opcionais e só enfeite: se gravar falhar, a conta já existe e
  // dá para personalizá-la depois, então o erro não trava o fluxo.
  const applyIdentity = async (accountId: string) => {
    if (!displayName.trim() && !color) return;
    try {
      await setIdentity(accountId, displayName.trim() || null, color);
    } catch {
      // Ver acima.
    }
  };

  const handleCreate = async () => {
    setBusy(true);
    setError("");
    try {
      if (usingKey) {
        const account = await createWithApiKey(agentId, name.trim(), apiKey.trim(), baseUrl.trim() || null);
        await applyIdentity(account.id);
        // La lista ya la muestra; la verificación corre en segundo plano y su resultado
        // aparece en la fila (ver `AgentAccountsPane`).
        void checkHealth(account.id);
        onClose();
        return;
      }
      const account = await create(agentId, name.trim());
      await applyIdentity(account.id);
      setCreated(account);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // ── Paso 2: login ─────────────────────────────────────────
  if (created) {
    return (
      <AppDialog
        // O título é um nó dentro de fronteira: um erro nele cai no nome da conta (texto simples), e não sobe até
        // a página. O nome acessível do diálogo vem do dado (o nome da conta), não de uma chamada de tradução.
        title={
          <PanelBoundary name="login-conta-titulo" fallback={<span>{created.name}</span>}>
            <LoginStepTitle name={created.name} />
          </PanelBoundary>
        }
        ariaLabel={created.name}
        onClose={onClose}
        size="lg"
        // Cerrar sin querer a mitad de un login (un click fuera, un Esc) deja la cuenta
        // creada pero vacía, y desde afuera parece que "no funcionó". Se sale por el botón.
        closeOnBackdrop={false}
        closeOnEsc={false}
        // O rodapé e o texto são partes que não são terminal: cada um numa fronteira própria, para um erro neles
        // não subir até a página e derrubar o terminal de login (que é filho direto do diálogo, abaixo).
        footer={
          <PanelBoundary name="login-conta-rodape">
            <LoginStepDone onDone={onClose} />
          </PanelBoundary>
        }
      >
        <PanelBoundary name="login-conta-texto">
          <LoginStepHelp command={created.loginCommand} />
        </PanelBoundary>
        <LoginTerminal account={created} />
      </AppDialog>
    );
  }

  // ── Paso 1: el nombre ─────────────────────────────────────
  const Icon = agent ? agentIcon(agent.agentId, agent.label) : null;

  return (
    <AppDialog
      title={agent
        ? t("settings.accounts.add.titleFor", { agent: agent.label })
        : t("settings.accounts.add.title")}
      onClose={onClose}
      size="sm"
      closeOnBackdrop={!busy}
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !canCreate}
            onClick={handleCreate}
          >
            {usingKey ? t("settings.accounts.add.createApiKey") : t("settings.accounts.add.next")}
          </Button>
        </>
      }
    >
      {!agent ? (
        <p className="text-[12px] text-gray-500 dark:text-gray-400">
          {t("settings.accounts.add.noneInstalled")}
        </p>
      ) : form === "blocked" ? (
        <p className="text-[12px] text-gray-500 dark:text-gray-400">
          {t("settings.accounts.add.needsProgram")}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Para qué servicio es. Va como dato, no como elección: es lo que estabas
              mirando, y decirlo acá evita tener que confiar en haber leído el título. */}
          <div className="flex items-center gap-2 h-9 px-3 rounded-lg
            bg-gray-100/70 dark:bg-white/4">
            {Icon && <Icon className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-gray-400" />}
            <span className="flex-1 min-w-0 truncate text-[12px]
              text-gray-700 dark:text-gray-300">
              {agent.label}
            </span>
            <Badge variant="info" size="sm" className="font-mono shrink-0">
              {agent.envVar}
            </Badge>
          </div>

          <MultipleAccountsNote agentId={agentId} agentLabel={agent.label} />

          <Input
            label={t("settings.accounts.add.name")}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canCreate && !busy) handleCreate();
            }}
            placeholder={t("settings.accounts.namePlaceholder")}
            variant="outline"
            autoFocus
            error={taken ? t("settings.accounts.add.taken") : undefined}
            helperText={t("settings.accounts.add.nameHelper", { envVar: agent.envVar })}
          />

          <Input
            label={t("settings.accounts.add.displayName")}
            value={displayName}
            maxLength={40}
            onChange={(e) => setDisplayName(e.target.value)}
            variant="outline"
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-gray-700 dark:text-gray-300">
              {t("settings.accounts.add.color")}
            </span>
            <AccountColorPicker value={color} onChange={setColor} label={t("settings.accounts.add.color")} />
          </div>

          {showKey && showLogin && (
            <div className="flex gap-1.5" role="radiogroup">
              {(["login", "api_key"] as const).map((m) => (
                <Button
                  key={m}
                  size="sm"
                  variant={mode === m ? "primary" : "outline"}
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => { setMode(m); setError(""); }}
                >
                  {m === "login" ? t("settings.accounts.add.mode.login") : t("settings.accounts.add.mode.apiKey")}
                </Button>
              ))}
            </div>
          )}

          {usingKey && (
            <>
              <Input
                label={t("settings.accounts.add.apiKey")}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setError(""); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canCreate && !busy) handleCreate();
                }}
                placeholder={agentId === "codex" ? "sk-…" : "sk-ant-…"}
                variant="outline"
                helperText={agentId === "codex"
                  ? t("settings.accounts.add.apiKeyHelperCodex")
                  : t("settings.accounts.add.apiKeyHelperClaude")}
              />
              {agentId === "claude-code" && (
                <Input
                  label={t("settings.accounts.add.baseUrl")}
                  value={baseUrl}
                  onChange={(e) => { setBaseUrl(e.target.value); setError(""); }}
                  placeholder="https://openrouter.ai/api"
                  variant="outline"
                  helperText={t("settings.accounts.add.baseUrlHelper")}
                />
              )}
            </>
          )}
        </div>
      )}

      {error && (
        <p className="mt-3 text-[11.5px] text-red-500 dark:text-red-400">{error}</p>
      )}
    </AppDialog>
  );
}

/**
 * Título do passo de login. Componente próprio, para que o `t` dele rode dentro da fronteira do título, e não
 * na função do diálogo.
 */
function LoginStepTitle({ name }: { name: string }) {
  const { t } = useTranslation();
  return <>{t("settings.accounts.login.title", { name })}</>;
}

/**
 * Texto do passo de login (o comando a rodar). Componente próprio: ele renderiza dentro da sua fronteira,
 * e não na função do diálogo, então um erro aqui fica aqui.
 */
function LoginStepHelp({ command }: { command: string }) {
  const { t } = useTranslation();
  return (
    <p className="text-[11.5px] text-gray-500 dark:text-white/45 mb-3">
      {t("settings.accounts.login.helper", { command })}
    </p>
  );
}

/**
 * Botão de concluir o passo de login: recarrega a lista (mesmo se falhar, o login já foi feito) e fecha.
 * Componente próprio, pelo mesmo motivo de `LoginStepHelp`.
 */
function LoginStepDone({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const load = useAccountsStore((s) => s.load);
  return (
    <Button
      variant="primary"
      onClick={async () => {
        // Se recarregar a lista falhar, ainda assim se fecha: o login já foi feito.
        try { await load(); } finally { onDone(); }
      }}
    >
      {t("settings.accounts.login.done")}
    </Button>
  );
}
