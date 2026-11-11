import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useUiStore } from "@/app/uiStore";
import { useAgentsStore } from "@/features/agents/store";
import { useSkillsStore } from "@/features/skills/store";
import { SettingsSidebar } from "@/features/settings/SettingsSidebar";
import { SettingsPageBody } from "@/features/settings/SettingsPages";
import { RestoreDeviceDefaultsButton } from "@/features/settings/RestoreDeviceDefaultsButton";
import { SETTINGS_PAGE_LABEL_KEYS, settingsPageDescKey, type SettingsPageId } from "@/features/settings/settingsNav";
import { useSettingsTargetStore } from "@/features/settings/settingsTarget";

/** O caminho da página no cabeçalho: "Configurações / Aparência". */
function SettingsBreadcrumb({ page }: { page: SettingsPageId }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("settings.breadcrumb")} className="flex min-w-0 items-center gap-2 text-[13px]">
      <span className="shrink-0 text-gray-500 dark:text-white/50">{t("settings.breadcrumb")}</span>
      <span aria-hidden="true" className="text-gray-300 dark:text-white/25">/</span>
      <span aria-current="page" title={t(SETTINGS_PAGE_LABEL_KEYS[page])} className="truncate font-medium text-gray-900 dark:text-white">{t(SETTINGS_PAGE_LABEL_KEYS[page])}</span>
    </nav>
  );
}

/** Quanto tempo o bloco que a busca achou fica destacado. */
const FLASH_MS = 1400;
const FLASH_CLASSES = ["ring-2", "ring-accent-500/50", "rounded-xl"];

/**
 * Consome o pedido da busca: quando a página certa está aberta, rola até o bloco e o destaca. O bloco
 * pode demorar um quadro a montar (uma aba que acabou de trocar), então tenta por alguns quadros.
 */
function useScrollToTarget(section: SettingsPageId, container: React.RefObject<HTMLElement | null>): void {
  const target = useSettingsTargetStore((s) => s.target);
  useEffect(() => {
    if (!target || target.page !== section) return;
    let frame = 0;
    let tries = 0;
    const reach = () => {
      const el = container.current?.querySelector<HTMLElement>(`[data-settings-anchor="${CSS.escape(target.anchor)}"]`);
      if (!el) {
        if (++tries < 15) frame = requestAnimationFrame(reach);
        else useSettingsTargetStore.getState().clear();
        return;
      }
      el.scrollIntoView({ block: "center" });
      el.classList.add(...FLASH_CLASSES);
      window.setTimeout(() => el.classList.remove(...FLASH_CLASSES), FLASH_MS);
      useSettingsTargetStore.getState().clear();
    };
    frame = requestAnimationFrame(reach);
    return () => cancelAnimationFrame(frame);
  }, [target, section, container]);
}

/**
 * A tela de Configurações (prancheta 5), a mesma nas abas, no canvas e no chat: o menu agrupado à
 * esquerda, o caminho no cabeçalho e a página aberta no meio, com título e subtítulo.
 *
 * As páginas são as do T3 Code (Geral, Aparência, Chat, Provedores…) e as da ADE que não têm par nele
 * (Memória, Decisões, Orquestrador, CLI…) no grupo "ADE". Cada página é um corpo em `SettingsPages.tsx`.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const section = useUiStore((s) => s.settingsSection);
  const loadSkillsDir = useSkillsStore((s) => s.loadSkillsDir);
  const loadCustomAgents = useAgentsStore((s) => s.loadCustomAgents);
  const scrollRef = useRef<HTMLElement>(null);
  useScrollToTarget(section, scrollRef);

  useEffect(() => {
    loadSkillsDir();
    loadCustomAgents().catch(console.error);
  }, [loadSkillsDir, loadCustomAgents]);

  return (
    <div className="@container flex h-full min-h-0 w-full bg-white dark:bg-surface-deep">
      <SettingsSidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Modal de Configurações (como no T3 Code): o caminho ("Configurações / página") fica no cabeçalho. */}
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-gray-200 px-5 dark:border-white/[0.08]">
          <SettingsBreadcrumb page={section} />
          {/* Como no T3 Code, o "restaurar" aparece só na página Geral. */}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {section === "general" && <RestoreDeviceDefaultsButton />}
          </div>
        </header>

        <main ref={scrollRef} className="cc-scroll min-w-0 flex-1 px-6 sm:px-12 pt-4 pb-12">
          <div className={`${section === "decisions" ? "max-w-[1040px]" : "max-w-[736px]"} mx-auto flex flex-col gap-7`}>
            {/* A página tem título e subtítulo (prancheta 5); os cartões vêm abaixo. */}
            <div>
              <h1 className="m-0 text-[24px] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">{t(SETTINGS_PAGE_LABEL_KEYS[section])}</h1>
              <p className="mt-1.5 mb-0 text-[14px] text-gray-500 dark:text-white/50">{t(settingsPageDescKey(section))}</p>
            </div>
            <SettingsPageBody page={section} />
          </div>
        </main>
      </div>
    </div>
  );
}
