import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, EmptyState, UserIcon } from "neogestify-ui-components";

import { useAccountsStore } from "@/features/accounts/store";
import { AgentAccountsPane } from "@/features/accounts/AgentAccountsPane";
import { AntigravityAccountsPane } from "@/features/accounts/AntigravityAccountsPane";
import { agentIcon } from "@/features/agents/agentIcons";
import { GitAccountsPane } from "@/features/forge/GitAccountsPane";
import { FORGE_KINDS, ForgeIcon, forgeLabel } from "@/features/forge/forgeMeta";
import { useForgeStore } from "@/features/forge/store";
import type { ForgeKind } from "@/features/forge/types";

/** Qué servicio se está mirando: una TUI o un tipo de host git. */
export type AccountsSection = { kind: "agent"; id: string } | { kind: "git"; id: ForgeKind };

function NavHeading({ children }: { children: React.ReactNode }) {
  return (
    <span className="block px-1.5 pt-3 pb-1.5 text-[9.5px] font-extrabold uppercase
      tracking-[0.11em] text-gray-400 dark:text-white/30">
      {children}
    </span>
  );
}

function NavItem({ active, onClick, icon, label, count, title }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
  title: string;
}) {
  return (
    <Button variant="custom"
      onClick={onClick}
      // El número solo no dice qué es: al lado de un nombre puede leerse como una versión.
      title={title}
      className={`cc-t flex items-center gap-2 w-full h-8 px-2 rounded-lg text-left
        ${active
          ? "bg-accent-500/12 dark:bg-accent-400/13 text-gray-900 dark:text-white font-semibold"
          : "text-gray-600 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-white/6"}`}
    >
      {icon}
      <span className="flex-1 min-w-0 truncate text-[11.5px]">{label}</span>
      <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/30">{count || ""}</span>
    </Button>
  );
}

/**
 * Onde se gerenciam as contas: a coluna da esquerda são os SERVIÇOS, em dois grupos.
 *
 * - **TUIs**: perfis das TUIs que suportam várias contas. Aqui o app não guarda credenciais:
 *   cada conta é uma pasta e o login quem faz é a TUI.
 * - **Git**: GitHub, GitLab, Gitea/Forgejo ou qualquer host. Estas SIM têm um token, no chaveiro
 *   do sistema, e são as que usam o controle de versão, o clonar do início e as tools de git do MCP.
 *
 * Vive dentro da seção Contas das Configurações (antes era um modal à parte). `focus` deixa quem
 * está em volta escolher o serviço (o "⋯ → Gerenciar" de uma conta).
 */
export function AccountsManager({ focus }: { focus?: AccountsSection | null }) {
  const { t } = useTranslation();
  const accounts = useAccountsStore((s) => s.accounts);
  const capable = useAccountsStore((s) => s.capable);
  const loadAgents = useAccountsStore((s) => s.load);
  const gitAccounts = useForgeStore((s) => s.accounts);
  const loadGit = useForgeStore((s) => s.load);
  const [section, setSection] = useState<AccountsSection | null>(focus ?? null);
  useEffect(() => { if (focus) setSection(focus); }, [focus]);
  const [error, setError] = useState("");

  useEffect(() => {
    loadAgents().catch((e) => setError(String(e)));
    loadGit().catch((e) => setError(String(e)));
  }, [loadAgents, loadGit]);

  /** TUIs que se muestran: las instaladas, más las que ya tengan cuentas creadas (para no
   *  esconder cuentas existentes si la TUI se desinstaló). */
  const shown = useMemo(
    () => capable.filter((c) => c.installed || accounts.some((a) => a.agentId === c.agentId)),
    [capable, accounts]
  );

  // Se elige algo solo: la pantalla arranca mostrando algo en vez de un hueco.
  useEffect(() => {
    if (section) return;
    setSection(shown.length > 0 ? { kind: "agent", id: shown[0].agentId } : { kind: "git", id: "github" });
  }, [section, shown]);

  const agent = section?.kind === "agent" ? shown.find((c) => c.agentId === section.id) : undefined;

  return (
    <div className="flex h-[560px] min-h-0 overflow-hidden rounded-xl bg-white shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.1)] dark:bg-surface dark:shadow-[inset_0_0_0_0.5px_rgba(84,84,88,0.55)]">
      {/* ══ los servicios ═════════════════════════════════════════════════ */}
      <nav className="flex flex-col w-48 shrink-0 min-h-0
        border-r border-gray-200 dark:border-white/8 bg-gray-100/50 dark:bg-black/20">
        <div className="flex-1 min-h-0 cc-scroll px-1.5 pb-2">
          <NavHeading>{t("accounts.group.tuis")}</NavHeading>
          {shown.length === 0 ? (
            <p className="px-2 pb-1 text-[10.5px] text-gray-400 dark:text-white/30">{t("settings.accounts.noneInstalled")}</p>
          ) : shown.map((c) => {
            const Icon = agentIcon(c.agentId, c.label);
            const n = accounts.filter((a) => a.agentId === c.agentId).length;
            return (
              <NavItem
                key={c.agentId}
                active={section?.kind === "agent" && section.id === c.agentId}
                onClick={() => setSection({ kind: "agent", id: c.agentId })}
                icon={<Icon className="w-3.5 h-3.5 shrink-0" />}
                label={c.label}
                count={n}
                // `count` SÍ es lo que se quiere acá: la clave tiene formas _one/_other.
                title={t("settings.accounts.count", { count: n })}
              />
            );
          })}

          <NavItem active={section?.kind === "agent" && section.id === "antigravity"}
            onClick={() => setSection({ kind: "agent", id: "antigravity" })}
            icon={<UserIcon className="w-3.5 h-3.5" />} label="Antigravity" count={0}
            title={t("accounts.antigravity.connect")} />
          <NavHeading>{t("accounts.group.git")}</NavHeading>
          {FORGE_KINDS.map((kind) => {
            const n = gitAccounts.filter((a) => a.kind === kind).length;
            return (
              <NavItem
                key={kind}
                active={section?.kind === "git" && section.id === kind}
                onClick={() => setSection({ kind: "git", id: kind })}
                icon={<ForgeIcon kind={kind} className="w-3.5 h-3.5 shrink-0" />}
                label={forgeLabel(kind, t)}
                count={n}
                title={t("settings.accounts.count", { count: n })}
              />
            );
          })}
        </div>
        {/* Las TUIs instaladas que NO aparecen tienen un motivo, y decirlo evita que se
            lea como un olvido. */}
        <p className="shrink-0 px-3 py-2 text-[10px] leading-relaxed
          border-t border-gray-200 dark:border-white/8 text-gray-400 dark:text-white/30">
          {t("settings.accounts.unsupportedNote")}
        </p>
      </nav>

      {/* ══ sus cuentas ═══════════════════════════════════════════════════ */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {section?.kind === "git" ? (
          <GitAccountsPane kind={section.id} />
        ) : section?.kind === "agent" && section.id === "antigravity" ? (
          <AntigravityAccountsPane />
        ) : agent ? (
          <AgentAccountsPane agent={agent} />
        ) : (
          <EmptyState className="m-auto" icon={<UserIcon className="w-8 h-8" />} title={t("settings.accounts.noneInstalled")} />
        )}
        {error && <p className="shrink-0 px-4 pb-2 text-[11px] text-red-500 dark:text-red-400">{error}</p>}
      </div>
    </div>
  );
}
