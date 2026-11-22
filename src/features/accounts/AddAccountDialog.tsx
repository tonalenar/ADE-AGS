import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, Input } from "neogestify-ui-components";

import { PanelBoundary } from "@/app/PanelBoundary";
import { AccountColorPicker } from "@/features/accounts/AccountColorPicker";
import { LoginTerminal } from "@/features/accounts/LoginTerminal";
import { MultipleAccountsNote } from "@/features/accounts/MultipleAccountsNote";
import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";
import { accountFormMode, programPresent } from "@/features/agents/accountConnect";
import { agentIcon } from "@/features/agents/agentIcons";
import { useTabsStore } from "@/features/tabs/store";
import { AppDialog } from "@/shared/ui/AppDialog";

interface AddAccountDialogProps {
  /** Provedor pré-selecionado ao abrir o diálogo. */
  agentId: string;
  onClose: () => void;
  /** Com qual forma de entrada o formulário abre. */
  initialMode?: "login" | "api_key";
  /** Permite escolher/trocar o provedor no passo 1 (usado na aba Contas). */
  allowProviderPick?: boolean;
  /** Quando informado, pula o passo 1 e abre direto o passo 2 para refazer o login desta conta. */
  reloginAccount?: AgentAccount | null;
}

/**
 * Diálogo "Adicionar conta" em 2 passos:
 * 1) Provedor, nome, cor e como entrar (conta/assinatura ou chave de API no chaveiro);
 * 2) Login no navegador com opção de expandir o terminal real da CLI (sem nunca desmontar o PTY).
 */
export function AddAccountDialog({
  agentId: initialAgentId,
  onClose,
  initialMode = "login",
  allowProviderPick = false,
  reloginAccount = null,
}: AddAccountDialogProps) {
  const { t } = useTranslation();
  const capable = useAccountsStore((s) => s.capable);
  const accounts = useAccountsStore((s) => s.accounts);
  const create = useAccountsStore((s) => s.create);
  const createWithApiKey = useAccountsStore((s) => s.createWithApiKey);
  const checkHealth = useAccountsStore((s) => s.checkHealth);
  const setIdentity = useAccountsStore((s) => s.setIdentity);
  const detectedAgents = useTabsStore((s) => s.detectedAgents);

  const [agentId, setAgentId] = useState(reloginAccount?.agentId ?? initialAgentId);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [mode, setMode] = useState<"login" | "api_key">(initialMode);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<AgentAccount | null>(reloginAccount);
  const [showTerminal, setShowTerminal] = useState(false);

  const agent = capable.find((c) => c.agentId === agentId) ?? capable[0];
  const effectiveAgentId = agent?.agentId ?? agentId;
  const seen = detectedAgents.some((a) => a.id === effectiveAgentId && a.available);
  const taken = accounts.some((a) => a.agentId === effectiveAgentId && a.name === name.trim());
  const form = agent ? accountFormMode(effectiveAgentId, programPresent(agent.installed, seen), true) : "blocked";
  const showKey = form === "api-key" || form === "both";
  const showLogin = form === "login" || form === "both";
  const usingKey = showKey && (form === "api-key" || mode === "api_key");
  const canCreate = !!agent && form !== "blocked" && !!name.trim() && !taken && (!usingKey || apiKey.trim().length > 0);

  const applyIdentity = async (accountId: string) => {
    if (!color) return;
    try {
      await setIdentity(accountId, null, color);
    } catch {
      // A conta já existe; a cor pode ser ajustada depois.
    }
  };

  const handleCreate = async () => {
    if (!agent) return;
    setBusy(true);
    setError("");
    try {
      if (usingKey) {
        const account = await createWithApiKey(effectiveAgentId, name.trim(), apiKey.trim(), baseUrl.trim() || null);
        await applyIdentity(account.id);
        void checkHealth(account.id);
        onClose();
        return;
      }
      const account = await create(effectiveAgentId, name.trim());
      await applyIdentity(account.id);
      setCreated(account);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const wayLoginTitle = (id: string) => {
    if (id === "antigravity") return t("settings.accounts.add.way.google");
    if (id === "claude-code") return t("settings.accounts.add.way.claude");
    if (id === "codex") return t("settings.accounts.add.way.codex");
    return t("settings.accounts.add.way.generic");
  };

  // ── Passo 2: login (terminal montado de forma estável para nunca matar o PTY) ──
  if (created) {
    return (
      <AppDialog
        title={
          <PanelBoundary name="login-conta-titulo" fallback={<span>{created.name}</span>}>
            <LoginStepTitle name={created.name} relogin={Boolean(reloginAccount)} />
          </PanelBoundary>
        }
        ariaLabel={created.name}
        onClose={onClose}
        size={showTerminal ? "lg" : "md"}
        closeOnBackdrop={false}
        closeOnEsc={false}
        footer={
          <PanelBoundary name="login-conta-rodape">
            <LoginStepDone onDone={onClose} />
          </PanelBoundary>
        }
      >
        <PanelBoundary name="login-conta-texto">
          <LoginStepIntro
            command={created.loginCommand}
            showTerminal={showTerminal}
            onToggleTerminal={() => setShowTerminal((v) => !v)}
          />
        </PanelBoundary>
        {/* O container muda apenas visibilidade CSS: o LoginTerminal permanece montado no mesmo pai para preservar o PTY. */}
        <div className={showTerminal ? "mt-3" : "sr-only h-0 overflow-hidden"} aria-hidden={!showTerminal}>
          <LoginTerminal account={created} />
        </div>
      </AppDialog>
    );
  }

  // ── Passo 1: provedor, nome, cor e como entrar ─────────────────────────────
  return (
    <AppDialog
      title={t("settings.accounts.add.title")}
      onClose={onClose}
      size="md"
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
            onClick={() => void handleCreate()}
          >
            {usingKey ? t("settings.accounts.add.createApiKey") : t("settings.accounts.add.continue")}
          </Button>
        </>
      }
    >
      {!agent ? (
        <p className="text-[12.5px] text-gray-500 dark:text-white/50">
          {t("settings.accounts.add.noneInstalled")}
        </p>
      ) : (
        <div className="flex flex-col gap-3.5">
          {allowProviderPick && capable.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-gray-700 dark:text-gray-200">
                {t("settings.accounts.add.provider")}
              </span>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5" role="radiogroup" aria-label={t("settings.accounts.add.provider")}>
                {capable.map((c) => {
                  const Icon = agentIcon(c.agentId, c.label);
                  const active = c.agentId === effectiveAgentId;
                  return (
                    <button
                      key={c.agentId}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => {
                        setAgentId(c.agentId);
                        setMode("login");
                        setError("");
                      }}
                      className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5 text-[12px] transition-colors
                        ${active
                          ? "border-accent-500 bg-accent-500/10 text-gray-900 dark:text-white font-medium"
                          : "border-gray-200 dark:border-white/[0.08] text-gray-600 dark:text-white/65 hover:bg-gray-50 dark:hover:bg-white/[0.04]"}`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="truncate max-w-full">{c.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {form === "blocked" ? (
            <p className="m-0 text-[12.5px] text-gray-500 dark:text-white/50">
              {t("settings.accounts.add.needsProgram")}
            </p>
          ) : (
            <>
              <MultipleAccountsNote agentId={effectiveAgentId} agentLabel={agent.label} />

              <Input
                label={t("settings.accounts.add.name")}
                value={name}
                onChange={(e) => { setName(e.target.value); setError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter" && canCreate && !busy) void handleCreate(); }}
                placeholder={t("settings.accounts.namePlaceholder")}
                variant="outline"
                autoFocus
                error={taken ? t("settings.accounts.add.taken") : undefined}
              />

              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-gray-700 dark:text-gray-200">
                  {t("settings.accounts.add.color")}
                </span>
                <AccountColorPicker value={color} onChange={setColor} label={t("settings.accounts.add.color")} />
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-gray-700 dark:text-gray-200">
                  {t("providers.method.title")}
                </span>
                <div role="radiogroup" aria-label={t("providers.method.title")} className="flex flex-col gap-1.5">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!usingKey}
                    disabled={!showLogin}
                    onClick={() => { setMode("login"); setError(""); }}
                    className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-45 disabled:cursor-not-allowed
                      ${!usingKey
                        ? "border-accent-500 bg-accent-500/8 dark:bg-accent-500/12"
                        : "border-gray-200 dark:border-white/[0.08] hover:bg-gray-50 dark:hover:bg-white/[0.03]"}`}
                  >
                    <span aria-hidden="true" className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${!usingKey ? "border-accent-500" : "border-gray-300 dark:border-white/25"}`}>
                      {!usingKey && <span className="h-2 w-2 rounded-full bg-accent-500" />}
                    </span>
                    <span className="flex flex-col gap-0.5 min-w-0">
                      <b className="text-[12.5px] font-semibold text-gray-900 dark:text-white">{wayLoginTitle(effectiveAgentId)}</b>
                      <small className="text-[11.5px] text-gray-500 dark:text-white/50">{t("settings.accounts.add.way.browserHint")}</small>
                    </span>
                  </button>

                  <button
                    type="button"
                    role="radio"
                    aria-checked={usingKey}
                    disabled={!showKey}
                    onClick={() => { setMode("api_key"); setError(""); }}
                    className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-45 disabled:cursor-not-allowed
                      ${usingKey
                        ? "border-accent-500 bg-accent-500/8 dark:bg-accent-500/12"
                        : "border-gray-200 dark:border-white/[0.08] hover:bg-gray-50 dark:hover:bg-white/[0.03]"}`}
                  >
                    <span aria-hidden="true" className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${usingKey ? "border-accent-500" : "border-gray-300 dark:border-white/25"}`}>
                      {usingKey && <span className="h-2 w-2 rounded-full bg-accent-500" />}
                    </span>
                    <span className="flex flex-col gap-0.5 min-w-0">
                      <b className="text-[12.5px] font-semibold text-gray-900 dark:text-white">{t("settings.accounts.add.mode.apiKey")}</b>
                      <small className="text-[11.5px] text-gray-500 dark:text-white/50">
                        {showKey ? t("settings.accounts.add.way.apiKeyHint") : t("settings.accounts.add.way.apiKeyUnavailable")}
                      </small>
                    </span>
                  </button>
                </div>
              </div>

              {usingKey && (
                <>
                  <Input
                    label={t("settings.accounts.add.apiKey")}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); setError(""); }}
                    onKeyDown={(e) => { if (e.key === "Enter" && canCreate && !busy) void handleCreate(); }}
                    placeholder={effectiveAgentId === "codex" ? "sk-…" : "sk-ant-…"}
                    variant="outline"
                    helperText={effectiveAgentId === "codex"
                      ? t("settings.accounts.add.apiKeyHelperCodex")
                      : t("settings.accounts.add.apiKeyHelperClaude")}
                  />
                  {effectiveAgentId === "claude-code" && (
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

function LoginStepIntro({ command, showTerminal, onToggleTerminal }: {
  command: string;
  showTerminal: boolean;
  onToggleTerminal: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center text-center gap-2 py-2">
      <AnimateSpin className="w-6 h-6 text-accent-500" />
      <b className="text-[14px] font-semibold text-gray-900 dark:text-white">
        {t("settings.accounts.login.browserTitle")}
      </b>
      <p className="m-0 max-w-md text-[12.5px] leading-relaxed text-gray-500 dark:text-white/55">
        {t("settings.accounts.login.browserDesc")}
      </p>
      <p className="m-0 text-[11.5px] text-gray-400 dark:text-white/40">
        {t("settings.accounts.login.helper", { command })}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="mt-1"
        onClick={onToggleTerminal}
      >
        {showTerminal ? t("settings.accounts.login.hideTerminal") : t("settings.accounts.login.showTerminal")}
      </Button>
    </div>
  );
}

function LoginStepTitle({ name, relogin }: { name: string; relogin: boolean }) {
  const { t } = useTranslation();
  return <>{t(relogin ? "settings.accounts.relogin.title" : "settings.accounts.login.title", { name })}</>;
}

function LoginStepDone({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const load = useAccountsStore((s) => s.load);
  return (
    <Button
      variant="primary"
      onClick={async () => {
        try { await load(); } finally { onDone(); }
      }}
    >
      {t("settings.accounts.login.done")}
    </Button>
  );
}
