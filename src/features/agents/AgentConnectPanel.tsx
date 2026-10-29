import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";

import { AntigravityOAuthSection } from "@/features/accounts/AntigravityOAuthSection";
import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";
import type { AgentInfo } from "@/features/tabs/types";

import { accountConnectOffer } from "./accountConnect";

/**
 * Contas deste agente, na própria lista de TUIs. O formulário de API key do Claude
 * fica aqui; o login que precisa do programa abre o diálogo que já existia.
 */
export function AgentConnectPanel({ agent, onLogin }: {
  agent: AgentInfo;
  onLogin: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const accounts = useAccountsStore((s) => s.accounts);
  const systemAccounts = useAccountsStore((s) => s.systemAccounts);
  const offer = accountConnectOffer(agent.id, agent.available);
  const linked = [...systemAccounts, ...accounts].filter((a) => a.agentId === agent.id);

  return (
    <div className="flex flex-col gap-2 rounded-lg px-3 py-2.5 bg-gray-100/70 dark:bg-white/4">
      {agent.id !== "antigravity" && (
        linked.length === 0
          ? <p className="text-[11.5px] text-gray-500 dark:text-white/45">{t("settings.tuis.connect.none")}</p>
          : linked.map((account) => <LinkedAccount key={account.id} account={account} />)
      )}

      {offer.kind === "cli-login" && (
        <p className="text-[11.5px] leading-relaxed text-gray-500 dark:text-white/45">
          {t("settings.tuis.connect.cliLogin", { command: agent.command })}
        </p>
      )}

      {offer.kind === "found" && (
        <p className="text-[11.5px] leading-relaxed text-gray-500 dark:text-white/45">
          {t("settings.tuis.connect.found")}
        </p>
      )}

      {offer.kind === "program" && (
        <p className="text-[11.5px] leading-relaxed text-gray-500 dark:text-white/45">
          {t("settings.tuis.connect.missing", { command: agent.command })}
        </p>
      )}

      {offer.kind === "oauth" && <AntigravityOAuthSection />}

      {offer.kind === "api-key" && (
        <ClaudeKeyForm login={offer.login} onLogin={() => onLogin(agent.id)} />
      )}

      {offer.kind === "dialog" && (
        <div>
          <Button variant="primary" size="sm" onClick={() => onLogin(agent.id)}>
            {t("settings.accounts.add")}
          </Button>
        </div>
      )}
    </div>
  );
}

function LinkedAccount({ account }: { account: AgentAccount }) {
  const { t } = useTranslation();
  return (
    <p className="truncate text-[12px] text-gray-800 dark:text-gray-100">
      {account.label ?? account.name}
      <span className="text-gray-400 dark:text-white/40">
        {` · ${account.loggedIn ? t("accounts.ready") : t("accounts.needsLogin")}`}
        {account.kind === "api_key" ? " · API key" : ""}
      </span>
    </p>
  );
}

function ClaudeKeyForm({ login, onLogin }: { login: boolean; onLogin: () => void }) {
  const { t } = useTranslation();
  const accounts = useAccountsStore((s) => s.accounts);
  const createWithApiKey = useAccountsStore((s) => s.createWithApiKey);
  const checkHealth = useAccountsStore((s) => s.checkHealth);
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const taken = accounts.some((a) => a.agentId === "claude-code" && a.name === name.trim());
  const canCreate = name.trim().length > 0 && apiKey.trim().length > 0 && !taken && !busy;

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const account = await createWithApiKey("claude-code", name.trim(), apiKey.trim(), baseUrl.trim() || null);
      setName("");
      setApiKey("");
      setBaseUrl("");
      void checkHealth(account.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11.5px] leading-relaxed text-gray-500 dark:text-white/45">
        {t("settings.accounts.add.apiKeyHelperClaude")}
      </p>
      <Input
        label={t("settings.accounts.add.name")}
        value={name}
        onChange={(e) => { setName(e.target.value); setError(""); }}
        placeholder={t("settings.accounts.namePlaceholder")}
        variant="outline"
        error={taken ? t("settings.accounts.add.taken") : undefined}
      />
      <Input
        label={t("settings.accounts.add.apiKey")}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={apiKey}
        onChange={(e) => { setApiKey(e.target.value); setError(""); }}
        onKeyDown={(e) => { if (e.key === "Enter" && canCreate) void create(); }}
        placeholder="sk-ant-…"
        variant="outline"
      />
      <Input
        label={t("settings.accounts.add.baseUrl")}
        value={baseUrl}
        onChange={(e) => { setBaseUrl(e.target.value); setError(""); }}
        placeholder="https://openrouter.ai/api"
        variant="outline"
        helperText={t("settings.accounts.add.baseUrlHelper")}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={!canCreate} onClick={() => void create()}>
          {t("settings.accounts.add.createApiKey")}
        </Button>
        {login && (
          <Button variant="outline" size="sm" onClick={onLogin}>
            {t("settings.accounts.login.btn")}
          </Button>
        )}
      </div>
      {error && <p className="text-[11.5px] text-red-500 dark:text-red-400">{error}</p>}
    </div>
  );
}
