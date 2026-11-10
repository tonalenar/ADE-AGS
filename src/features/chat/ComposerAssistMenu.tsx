import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { useTabsStore } from "@/features/tabs/store";
import { repoInfo } from "@/features/explorer/ipc";
import { useSkillsStore } from "@/features/skills/store";
import { alwaysOnSkills } from "@/features/skills/ipc";
import { SkillPalette, type SkillScopeTarget } from "@/features/skills/SkillPalette";
import type { SkillSummary } from "@/features/skills/types";
import { forgePulls } from "@/features/forge/ipc";
import type { ForgeItem } from "@/features/forge/types";

import { addSurface, setRightPanel } from "./store";
import { PROTOCOL_AGENTS, type ProviderSlashCommand } from "./chatModel";
import { legacyComposerCapabilityAvailable, matrixProviderForAgent, useHarnessCapability } from "./harnessCapabilities";
import { useChatPrefs } from "./chatPrefs";
import type { ComposerAddonContext } from "./ChatComposer";
import { AgentMono } from "./team/TeamParts";
import { mentionOptions, mentionSlug, type MentionOption } from "./team/teamModel";
import {
  DiffIcon, FilesIcon, GlobeIcon, MoreHorizontalIcon, PhoneIcon, PullRequestIcon, SettingsIcon, SideChatIcon, TerminalIcon, WrenchIcon,
} from "./chatIcons";

type Trigger = "@" | "/" | "$" | "#";

interface ActiveToken {
  trigger: Trigger;
  query: string;
  start: number;
}

interface AssistItem {
  key: string;
  group: "agents" | "files" | "commands" | "provider" | "skills" | "pullRequests";
  title: string;
  detail?: string;
  disabled?: boolean;
  icon: React.ReactNode;
  run: () => void;
}

export const COMMANDS = [
  { id: "model", label: "chat.composer.assist.command.model", detail: "chat.composer.assist.command.modelDetail" },
  { id: "terminal", label: "chat.composer.assist.command.terminal", detail: "chat.composer.assist.command.terminalDetail" },
  { id: "files", label: "chat.composer.assist.command.files", detail: "chat.composer.assist.command.filesDetail" },
  { id: "browser", label: "chat.composer.assist.command.browser", detail: "chat.composer.assist.command.browserDetail" },
  { id: "diff", label: "chat.composer.assist.command.diff", detail: "chat.composer.assist.command.diffDetail" },
  { id: "pr", label: "chat.composer.assist.command.pr", detail: "chat.composer.assist.command.prDetail" },
  { id: "device", label: "chat.composer.assist.command.device", detail: "chat.composer.assist.command.deviceDetail" },
  { id: "team", label: "chat.composer.assist.command.team", detail: "chat.composer.assist.command.teamDetail" },
  { id: "skills", label: "chat.composer.assist.command.skills", detail: "chat.composer.assist.command.skillsDetail" },
  { id: "side", label: "chat.composer.assist.command.side", detail: "chat.composer.assist.command.sideDetail" },
  { id: "compact", label: "chat.composer.assist.command.compact", detail: "chat.composer.assist.command.compactDetail" },
  { id: "plan", label: "chat.composer.assist.command.plan", detail: "chat.composer.assist.command.planDetail" },
  { id: "goal", label: "chat.composer.assist.command.goal", detail: "chat.composer.assist.command.goalDetail" },
  { id: "autocompact", label: "chat.composer.assist.command.autocompact", detail: "chat.composer.assist.command.autocompactDetail" },
  { id: "clear", label: "chat.composer.assist.command.clear", detail: "chat.composer.assist.command.clearDetail" },
] as const;

/** O token contextual imediatamente antes do cursor: @arquivo, /comando ou $skill. */
export function activeToken(text: string, caret: number): ActiveToken | null {
  const match = /(?:^|\s)([@/$#])([^\s]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  return {
    trigger: match[1] as Trigger,
    query: match[2] ?? "",
    start: caret - (match[2]?.length ?? 0) - 1,
  };
}

export function replaceToken(text: string, caret: number, token: ActiveToken, replacement: string): { text: string; caret: number } {
  const next = text.slice(0, token.start) + replacement + text.slice(caret);
  return { text: next, caret: token.start + replacement.length };
}

function normalized(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? path;
}

function skillSlug(skill: SkillSummary): string {
  return basename(skill.sourcePath) || normalized(skill.name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function skillAttached(skill: SkillSummary, workspaceId: string, cwd: string, tabId: string | null): boolean {
  return skill.usedBy.some((use) => use.scope === "tab"
    ? !!tabId && use.tabId === tabId
    : use.workspaceId === workspaceId && (!use.cwd || use.cwd === cwd));
}

function fileAbsolute(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${rel.replace(/^[\\/]+/, "")}`;
}

function attachSelectedFile(context: ComposerAddonContext, path: string): void {
  const token = activeToken(context.text, context.caret);
  if (!token) return;
  const next = replaceToken(context.text, context.caret, token, "");
  context.apply(next.text, next.caret);
  void context.addPaths([path]);
}

/**
 * Autocomplete do composer no estilo T3, conectado aos recursos da ADE:
 * - `@` sugere agentes do time e arquivos com mudanças; escolher um arquivo o anexa como contexto revisável;
 * - `/` abre superfícies da conversa, o seletor de agente/modelo ou a gestão de skills;
 * - `$` sugere skills instaladas e disponíveis para o agente atual.
 */
export function ComposerAssistMenu({
  cwd,
  agentId,
  conversationKey = null,
  teamOptions = [],
  providerCommands = [],
  onPlan,
  context,
}: {
  cwd: string | null;
  agentId: string | null;
  /** Id da aba ou `thread:<id>`; necessário para abrir a gestão de skills no alcance correto. */
  conversationKey?: string | null;
  teamOptions?: MentionOption[];
  /** Comandos anunciados pela sessão ACP atual; só aparecem em conversa OpenCode ativa. */
  providerCommands?: ProviderSlashCommand[];
  /** Alterna o modo Plano da conversa; omitido quando o agente não oferece esse modo ou está ocupado. */
  onPlan?: () => void;
  context: ComposerAddonContext;
}) {
  const { t } = useTranslation();
  const showSkillsInSlashMenu = useChatPrefs().showSkillsInSlashMenu;
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const skills = useSkillsStore((s) => s.skills);
  const skillsLoading = useSkillsStore((s) => s.loading);
  const loadSkills = useSkillsStore((s) => s.loadSkills);
  const [alwaysOn, setAlwaysOn] = useState<Set<string>>(() => new Set());
  const [changedFiles, setChangedFiles] = useState<{ root: string; rel: string }[]>([]);
  const [pullRequests, setPullRequests] = useState<ForgeItem[]>([]);
  const [manageSkills, setManageSkills] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const itemNodes = useRef(new Map<string, HTMLButtonElement>());
  const requestedSkills = useRef(false);

  const token = useMemo(() => activeToken(context.text, context.caret), [context.text, context.caret]);
  const tokenKey = token ? `${token.trigger}:${token.start}:${token.query}:${context.caret}` : null;
  const tabId = conversationKey && !conversationKey.startsWith("thread:") ? conversationKey : null;
  const capabilitySurface = conversationKey?.startsWith("thread:") ? "chat" : "tui";
  const matrixApplies = capabilitySurface === "chat";
  const matrixProvider = matrixProviderForAgent(agentId);
  const compactAvailability = useHarnessCapability(capabilitySurface, matrixProvider, "compact");
  const goalAvailability = useHarnessCapability(capabilitySurface, matrixProvider, "goal");

  useEffect(() => {
    if (skills.length === 0 && !skillsLoading && !requestedSkills.current) {
      requestedSkills.current = true;
      void loadSkills().catch(() => undefined);
    }
  }, [skills.length, skillsLoading, loadSkills]);

  useEffect(() => {
    let current = true;
    void alwaysOnSkills().then((ids) => { if (current) setAlwaysOn(new Set(ids)); }).catch(() => undefined);
    return () => { current = false; };
  }, []);

  // Lê apenas o resumo git (sem varrer o projeto inteiro), e só enquanto o token @ está aberto.
  useEffect(() => {
    if (!cwd || token?.trigger !== "@") return;
    let current = true;
    setChangedFiles([]);
    void repoInfo(cwd).then((info) => {
      if (!current || !info.root) return;
      setChangedFiles(Object.keys(info.changes).map((rel) => ({ root: info.root!, rel })));
    }).catch(() => undefined);
    return () => { current = false; };
  }, [cwd, token?.trigger]);

  // Busca PRs abertos só quando a pessoa digita `#`; não faz polling enquanto o composer está inativo.
  useEffect(() => {
    if (!cwd || token?.trigger !== "#") { setPullRequests([]); return; }
    let current = true;
    setPullRequests([]);
    void forgePulls(cwd, "open").then((items) => {
      if (current) setPullRequests(items);
    }).catch(() => {
      if (current) setPullRequests([]);
    });
    return () => { current = false; };
  }, [cwd, token?.trigger]);

  const compatibleSkills = useMemo(() => skills.filter((skill) => {
    const compatible = !agentId || skill.compatibleAgents.length === 0 || skill.compatibleAgents.includes(agentId);
    const mounted = skillAttached(skill, workspaceId, cwd ?? "", tabId) || alwaysOn.has(skill.id);
    return compatible && mounted;
  }), [skills, agentId, workspaceId, cwd, tabId, alwaysOn]);

  const items = useMemo<AssistItem[]>(() => {
    if (!token || dismissed === tokenKey) return [];
    const query = normalized(token.query);
    const matches = (...values: (string | null | undefined)[]) => !query || values.some((value) => normalized(value ?? "").includes(query));

    if (token.trigger === "@") {
      const agents = mentionOptions(teamOptions, token.query).map((option): AssistItem => ({
        key: `agent:${option.ref}`,
        group: "agents",
        title: option.name,
        detail: t(`chat.team.roles.${option.role}`, { defaultValue: option.role }),
        icon: <AgentMono agentId={option.agentId} label={option.name} size={16} />,
        run: () => {
          const found = activeToken(context.text, context.caret);
          if (!found) return;
          const inserted = `@${mentionSlug(option.name)} `;
          const next = replaceToken(context.text, context.caret, found, inserted);
          context.apply(next.text, next.caret);
        },
      }));
      const files = changedFiles
        .filter(({ rel }) => matches(rel, basename(rel)))
        .slice(0, 8)
        .map(({ root, rel }): AssistItem => ({
          key: `file:${root}:${rel}`,
          group: "files",
          title: basename(rel),
          detail: rel,
          icon: <FilesIcon className="w-4 h-4" />,
          run: () => {
            attachSelectedFile(context, fileAbsolute(root, rel));
          },
        }));
      const browse: AssistItem = {
        key: "browse-files",
        group: "files",
        title: t("chat.composer.assist.browse"),
        detail: cwd ?? t("chat.composer.assist.noFolder"),
        icon: <FilesIcon className="w-4 h-4" />,
        run: () => {
          if (!cwd) return;
          void openDialog({ multiple: false, directory: false, defaultPath: cwd, title: t("chat.composer.assist.browse") })
            .then((picked) => {
              if (typeof picked !== "string" || !picked) return;
              attachSelectedFile(context, picked);
            }).catch(() => undefined);
        },
      };
      return [...agents, ...files, browse];
    }

    if (token.trigger === "#") {
      return pullRequests
        .filter((pull) => matches(pull.number.toString(), pull.title, pull.sourceBranch, pull.targetBranch, pull.author))
        .slice(0, 12)
        .map((pull): AssistItem => ({
          key: `pull:${pull.number}`,
          group: "pullRequests",
          title: `#${pull.number} ${pull.title}`,
          detail: pull.sourceBranch && pull.targetBranch ? `${pull.sourceBranch} → ${pull.targetBranch}` : pull.author ?? undefined,
          icon: <PullRequestIcon className="w-4 h-4" />,
          run: () => {
            const found = activeToken(context.text, context.caret);
            if (!found) return;
            const inserted = `PR #${pull.number}: ${pull.title} (${pull.webUrl}) `;
            const next = replaceToken(context.text, context.caret, found, inserted);
            context.apply(next.text, next.caret);
          },
        }));
    }

    const skillsForToken = (token.trigger !== "/" || showSkillsInSlashMenu ? compatibleSkills : [])
      .filter((skill) => matches(skill.name, skill.description, skillSlug(skill), skill.categories.join(" ")))
      .slice(0, 12)
      .map((skill): AssistItem => ({
        key: `skill:${skill.id}`,
        group: "skills",
        title: skill.name,
        detail: skill.description ?? skillSlug(skill),
        icon: <WrenchIcon className="w-4 h-4" />,
        run: () => {
          if (!token) return;
          const invocation = `${token.trigger}${skillSlug(skill)} `;
          const next = replaceToken(context.text, context.caret, token, invocation);
          context.apply(next.text, next.caret);
        },
      }));

    const manage: AssistItem = {
      key: "manage-skills",
      group: "skills",
      title: t("chat.composer.assist.manageSkills"),
      detail: t("chat.composer.assist.manageSkillsDetail"),
      icon: <WrenchIcon className="w-4 h-4" />,
      run: () => {
        const next = replaceToken(context.text, context.caret, token, "");
        context.apply(next.text, next.caret);
        setManageSkills(true);
      },
    };

    if (token.trigger === "$" ) return [...skillsForToken, manage];

    const commandItems: AssistItem[] = COMMANDS
      .filter((command) => (command.id !== "side" || (!!conversationKey && !!agentId && (!!PROTOCOL_AGENTS[agentId] || agentId.startsWith("local-acp-"))))
        && (command.id !== "plan" || !!onPlan)
        && (command.id !== "clear" || !!conversationKey?.startsWith("thread:"))
        && (command.id !== "compact" || (!!conversationKey && (matrixApplies || legacyComposerCapabilityAvailable(capabilitySurface, matrixProvider, "compact"))))
        && (command.id !== "goal" || (!!conversationKey && (matrixApplies || legacyComposerCapabilityAvailable(capabilitySurface, matrixProvider, "goal"))))
        && (command.id !== "autocompact" || (!!conversationKey && legacyComposerCapabilityAvailable(capabilitySurface, matrixProvider, "autocompact")))
        && matches(command.id, t(command.label), t(command.detail)))
      .map((command): AssistItem => ({
        key: `command:${command.id}`,
        group: "commands",
        title: t(command.label),
        detail: matrixApplies && command.id === "compact" && !compactAvailability.available ? compactAvailability.reason ?? ""
          : matrixApplies && command.id === "goal" && !goalAvailability.available ? goalAvailability.reason ?? ""
            : t(command.detail),
        disabled: matrixApplies && ((command.id === "compact" && !compactAvailability.available)
          || (command.id === "goal" && !goalAvailability.available)),
        icon: command.id === "model" ? <SettingsIcon className="w-4 h-4" />
          : command.id === "terminal" ? <TerminalIcon className="w-4 h-4" />
            : command.id === "files" ? <FilesIcon className="w-4 h-4" />
            : command.id === "browser" ? <GlobeIcon className="w-4 h-4" />
              : command.id === "diff" ? <DiffIcon className="w-4 h-4" />
                : command.id === "pr" ? <PullRequestIcon className="w-4 h-4" />
                : command.id === "device" ? <PhoneIcon className="w-4 h-4" />
                  : command.id === "side" ? <SideChatIcon className="w-4 h-4" />
                  : <MoreHorizontalIcon className="w-4 h-4" />,
        run: () => {
          if (command.id === "plan") {
            const next = replaceToken(context.text, context.caret, token, "");
            context.apply(next.text, next.caret);
            onPlan?.();
            return;
          }
          if (command.id === "compact" || command.id === "goal" || command.id === "autocompact" || command.id === "clear") {
            const next = replaceToken(context.text, context.caret, token, `/${command.id} `);
            context.apply(next.text, next.caret);
            return;
          }
          const next = replaceToken(context.text, context.caret, token, "");
          context.apply(next.text, next.caret);
          switch (command.id) {
            case "model": {
              const textarea = document.querySelector<HTMLTextAreaElement>("[data-chat-composer]");
              textarea?.closest("form")?.querySelector<HTMLButtonElement>("[data-chat-agent-model-picker]")?.click();
              break;
            }
            case "terminal": setRightPanel("shell"); break;
            case "files": addSurface("files"); break;
            case "browser": addSurface("browser"); break;
            case "diff": setRightPanel("diff"); break;
            case "pr": setRightPanel("pr"); break;
            case "device": addSurface("ios"); break;
            case "team": addSurface("team"); break;
            case "skills": setManageSkills(true); break;
            case "side": addSurface("side"); break;
          }
        },
      }));
    const reservedCommands = new Set([
      ...commandItems.map((command) => normalized(command.key.slice("command:".length))),
      ...(showSkillsInSlashMenu ? compatibleSkills.map((skill) => normalized(skillSlug(skill))) : []),
    ]);
    const providerItems: AssistItem[] = token.trigger === "/" && token.start === 0 && conversationKey?.startsWith("thread:") && (agentId === "opencode" || !!agentId?.startsWith("local-acp-"))
      ? providerCommands
        .filter((command) => !reservedCommands.has(normalized(command.name)))
        .filter((command) => matches(command.name, command.description, command.inputHint))
        .map((command): AssistItem => ({
          key: `provider:${normalized(command.name)}`,
          group: "provider",
          title: `/${command.name}`,
          detail: [command.inputHint, command.description].filter(Boolean).join(" · ") || undefined,
          icon: <AgentMono agentId={agentId ?? "opencode"} label={agentId === "opencode" ? "OpenCode" : "ACP"} size={16} />,
          run: () => {
            const found = activeToken(context.text, context.caret);
            if (!found || found.trigger !== "/" || found.start !== 0) return;
            const next = replaceToken(context.text, context.caret, found, `/${command.name} `);
            context.apply(next.text, next.caret);
          },
        }))
      : [];
    return [...commandItems, ...providerItems, ...skillsForToken, ...(showSkillsInSlashMenu ? [manage] : [])];
  }, [token, tokenKey, dismissed, teamOptions, changedFiles, pullRequests, compatibleSkills, context, cwd, t, showSkillsInSlashMenu, onPlan, providerCommands, conversationKey, agentId, compactAvailability.available, compactAvailability.reason, goalAvailability.available, goalAvailability.reason]);

  const groups = useMemo(() => {
    const result: { group: AssistItem["group"]; label: string; items: AssistItem[] }[] = [];
    for (const item of items) {
      const last = result[result.length - 1];
      if (last?.group === item.group) last.items.push(item);
      else result.push({ group: item.group, label: t(`chat.composer.assist.group.${item.group}`), items: [item] });
    }
    return result;
  }, [items, t]);

  useEffect(() => { setCursor(0); }, [tokenKey, items.length]);
  useEffect(() => {
    const item = items[cursor];
    if (item) itemNodes.current.get(item.key)?.scrollIntoView({ block: "nearest" });
  }, [cursor, items]);

  const choose = useCallback((item: AssistItem | undefined) => {
    if (!item?.disabled) item?.run();
  }, []);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!token || dismissed === tokenKey || items.length === 0) return false;
    if (event.key === "ArrowDown") { setCursor((index) => (index + 1) % items.length); return true; }
    if (event.key === "ArrowUp") { setCursor((index) => (index - 1 + items.length) % items.length); return true; }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { choose(items[cursor]); return true; }
    if (event.key === "Escape") { setDismissed(tokenKey); return true; }
    return false;
  }, [token, dismissed, tokenKey, items, cursor, choose]);

  useEffect(() => context.registerKeyHandler(handleKeyDown), [context.registerKeyHandler, handleKeyDown]);

  const showMenu = !!token && dismissed !== tokenKey && items.length > 0;
  const target: SkillScopeTarget | null = cwd ? {
    scope: tabId ? "tab" : "workspace",
    workspaceId,
    ...(tabId ? { tabId } : {}),
    cwd,
    agentId,
    label: basename(cwd),
  } : null;

  return (
    <>
      {showMenu && (
        <div role="listbox" aria-label={t("chat.composer.assist.label")}
          className="mx-3 mt-2 max-h-72 overflow-y-auto cc-scroll-hidden p-1 rounded-xl text-chat-note
            bg-white/95 dark:bg-surface-raised/95 shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_8px_24px_-12px_rgba(0,0,0,0.45)]">
          {groups.map((group) => (
            <div key={group.group}>
              <div className="px-2.5 pt-2 pb-1 text-[9.5px] font-extrabold uppercase tracking-[0.11em] text-gray-400 dark:text-white/30">
                {group.label}
              </div>
              {group.items.map((item) => {
                const index = items.indexOf(item);
                const selected = index === cursor;
                return (
                  <button key={item.key} ref={(node) => { if (node) itemNodes.current.set(item.key, node); else itemNodes.current.delete(item.key); }}
                    type="button" role="option" aria-selected={selected} aria-disabled={item.disabled || undefined} disabled={item.disabled}
                    title={item.disabled ? item.detail : undefined}
                    onMouseDown={(event) => { event.preventDefault(); choose(item); }}
                    onMouseMove={() => setCursor(index)}
                    className={`w-full min-w-0 flex items-center gap-2 h-9 px-2.5 rounded-lg text-left
                      ${item.disabled ? "cursor-not-allowed opacity-45" : selected ? "bg-accent-500/12 text-gray-900 dark:bg-accent-400/15 dark:text-white" : "text-gray-700 dark:text-white/75 hover:bg-gray-100 dark:hover:bg-white/[0.06]"}`}>
                    <span className="w-5 h-5 shrink-0 flex items-center justify-center text-gray-500 dark:text-white/50">{item.icon}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium" title={item.title}>{item.title}</span>
                    {item.detail && <span className="max-w-[48%] truncate text-[10.5px] text-gray-400 dark:text-white/35" title={item.detail}>{item.detail}</span>}
                    {selected && <kbd className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-gray-200/80 dark:bg-white/[0.08]">↵</kbd>}
                  </button>
                );
              })}
            </div>
          ))}
          <div className="flex justify-end px-2.5 pt-1.5 pb-1 text-[10px] text-gray-400 dark:text-white/30">
            {t("chat.composer.assist.hint")}
          </div>
        </div>
      )}
      {manageSkills && target && <SkillPalette target={target} onClose={() => setManageSkills(false)} />}
    </>
  );
}
