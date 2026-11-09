import { useEffect, useState } from "react";

import { normalizeProjectPath } from "./chatProjectPrefs";

export type ChatProjectIcon =
  | { kind: "emoji"; value: string }
  | { kind: "monogram"; value: string }
  | { kind: "image"; value: string };

export interface ChatProjectIdentity {
  known: boolean;
  pinned: boolean;
  archived: boolean;
  icon: ChatProjectIcon | null;
  name: string | null;
  branch: string | null;
}

const STORAGE_KEY = "cc-chat-project-identity";
const CHANGE_EVENT = "cc-chat-project-identity-changed";
const MAX_ICON_DATA_URL_CHARS = 360_000;
const EMPTY: ChatProjectIdentity = { known: false, pinned: false, archived: false, icon: null, name: null, branch: null };

function parseIcon(raw: unknown): ChatProjectIcon | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.kind === "emoji" || candidate.kind === "monogram") {
    if (typeof candidate.value !== "string") return null;
    const value = candidate.value.trim().slice(0, candidate.kind === "emoji" ? 16 : 4);
    return value ? { kind: candidate.kind, value } : null;
  }
  if (candidate.kind === "image" && typeof candidate.value === "string"
    && candidate.value.length <= MAX_ICON_DATA_URL_CHARS
    && /^data:image\/(png|jpeg|webp);base64,/i.test(candidate.value)) {
    return { kind: "image", value: candidate.value };
  }
  return null;
}

function parseIdentity(raw: unknown): ChatProjectIdentity {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY;
  const value = raw as Record<string, unknown>;
  return {
    known: value.known === true,
    pinned: value.pinned === true,
    archived: value.archived === true,
    icon: parseIcon(value.icon),
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 160) : null,
    branch: typeof value.branch === "string" && value.branch.trim() ? value.branch.trim().slice(0, 160) : null,
  };
}

function readAll(): Record<string, ChatProjectIdentity> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, ChatProjectIdentity> = {};
    for (const [cwd, value] of Object.entries(parsed as Record<string, unknown>)) {
      const identity = parseIdentity(value);
      if (cwd && (identity.known || identity.pinned || identity.archived || identity.icon)) result[normalizeProjectPath(cwd)] = identity;
    }
    return result;
  } catch {
    return {};
  }
}

export function chatProjectIdentity(cwd: string): ChatProjectIdentity {
  return readAll()[normalizeProjectPath(cwd)] ?? EMPTY;
}

export function setChatProjectIdentity(cwd: string, patch: Partial<ChatProjectIdentity>): void {
  try {
    const all = readAll();
    const key = normalizeProjectPath(cwd);
    const current = all[key] ?? EMPTY;
    const next = parseIdentity({ ...current, ...patch });
    if (next.known || next.pinned || next.archived || next.icon) all[key] = next;
    else delete all[key];
    if (Object.keys(all).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    else localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // Identidade visual e organização não bloqueiam conversas se o armazenamento local falhar.
  }
}

/** Remove a identidade local quando a pessoa escolhe esquecer o workspace fechado. */
export function forgetChatProjectIdentity(cwd: string): void {
  try {
    const all = readAll();
    delete all[normalizeProjectPath(cwd)];
    if (Object.keys(all).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    else localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // Esquecer o rótulo não deve impedir o fluxo de esquecer o workspace.
  }
}

/** Mantém badges e a sidebar sincronizados quando a identidade do projeto muda. */
export function useChatProjectIdentity(cwd: string | null | undefined): ChatProjectIdentity {
  const [identity, setIdentity] = useState(() => cwd ? chatProjectIdentity(cwd) : EMPTY);
  useEffect(() => {
    if (!cwd) { setIdentity(EMPTY); return; }
    const refresh = () => setIdentity(chatProjectIdentity(cwd));
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    refresh();
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [cwd]);
  return identity;
}

export function useChatProjectIdentityList(): Record<string, ChatProjectIdentity> {
  const [identities, setIdentities] = useState(readAll);
  useEffect(() => {
    const refresh = () => setIdentities(readAll());
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    refresh();
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return identities;
}

