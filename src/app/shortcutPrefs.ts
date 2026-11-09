import { create } from "zustand";
import { validateShortcutWhen } from "./shortcutWhen";

export interface ShortcutBinding {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export interface ShortcutContextRule {
  id: string;
  binding: ShortcutBinding | null;
  when: string;
}

export type BindingError = "key" | "modifier" | "altGr" | "reserved";

interface ShortcutPreferencesState {
  /** null significa que a ação ficou sem atalho. */
  bindings: Record<string, ShortcutBinding | null>;
  /** Expressão de contexto opcional, no formato seguro `when` do T3. */
  conditions: Record<string, string>;
  /** Regras adicionais: cada uma liga um acorde a um contexto da interface. */
  contextualRules: Record<string, ShortcutContextRule[]>;
  recordingId: string | null;
  setBinding: (id: string, binding: ShortcutBinding | null) => void;
  setCondition: (id: string, condition: string) => void;
  addContextualRule: (id: string, ruleId: string) => void;
  setContextualRuleBinding: (id: string, ruleId: string, binding: ShortcutBinding | null) => void;
  setContextualRuleWhen: (id: string, ruleId: string, condition: string) => void;
  removeContextualRule: (id: string, ruleId: string) => void;
  resetBinding: (id: string) => void;
  resetAll: () => void;
  setRecordingId: (id: string | null) => void;
}

const STORAGE_KEY = "cc-shortcut-bindings";
const NAMED_KEYS = new Set([
  "tab", "enter", "escape", "space", "backspace", "delete", "insert", "home", "end",
  "pageup", "pagedown", "arrowup", "arrowdown", "arrowleft", "arrowright",
]);
const MODIFIER_KEYS = new Set(["shift", "control", "ctrl", "alt", "meta", "os"]);

function normalizeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value === " ") return "space";
  const key = value.trim().toLowerCase();
  if (key.length === 1 && !/[\u0000-\u001f\u007f]/.test(key)) return key;
  if (NAMED_KEYS.has(key) || /^f([1-9]|1[0-2])$/.test(key)) return key;
  return null;
}

/** Valida e normaliza um acorde salvo ou recém-capturado. */
export function validateShortcutBinding(value: unknown): BindingError | ShortcutBinding {
  if (!value || typeof value !== "object") return "key";
  const raw = value as Record<string, unknown>;
  if ([raw.key].some((key) => typeof key === "string" && MODIFIER_KEYS.has(key.toLowerCase()))) return "key";
  const key = normalizeKey(raw.key);
  if (!key) return "key";
  const ctrl = raw.ctrl === true;
  const shift = raw.shift === true;
  const alt = raw.alt === true;
  const meta = raw.meta === true;
  if (!ctrl && !alt && !meta) return "modifier";
  // Ctrl+Alt também é a forma como AltGr chega em vários teclados; não o capture globalmente.
  if (ctrl && alt) return "altGr";
  // Preserve combinações globais de fechar, alternar app, Spotlight e Task Manager.
  if ((ctrl || meta) && ["q", "w", "r"].includes(key)) return "reserved";
  if ((alt && key === "tab") || (alt && key === "f4")) return "reserved";
  if (meta && ["tab", "space"].includes(key)) return "reserved";
  if (ctrl && shift && key === "escape") return "reserved";
  return { key, ctrl, shift, alt, meta };
}

export function isBindingError(value: BindingError | ShortcutBinding): value is BindingError {
  return typeof value === "string";
}

/** Um rótulo estável para comparar acordes sem depender da plataforma. */
export function shortcutBindingKey(binding: ShortcutBinding): string {
  return `${binding.ctrl ? "c" : ""}${binding.meta ? "m" : ""}${binding.alt ? "a" : ""}${binding.shift ? "s" : ""}:${binding.key}`;
}

function parseBindings(raw: unknown): Record<string, ShortcutBinding | null> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const parsed: Record<string, ShortcutBinding | null> = {};
  for (const [id, candidate] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9._:-]{0,100}$/i.test(id)) continue;
    if (candidate === null) { parsed[id] = null; continue; }
    const binding = validateShortcutBinding(candidate);
    if (!isBindingError(binding)) parsed[id] = binding;
  }
  return parsed;
}

function parseContextualRules(raw: unknown): Record<string, ShortcutContextRule[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const parsed: Record<string, ShortcutContextRule[]> = {};
  for (const [actionId, candidates] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9._:-]{0,100}$/i.test(actionId) || !Array.isArray(candidates)) continue;
    const rules: ShortcutContextRule[] = [];
    for (const candidate of candidates.slice(0, 20)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const value = candidate as Record<string, unknown>;
      const id = typeof value.id === "string" && /^[a-z0-9-]{1,80}$/i.test(value.id) ? value.id : null;
      if (!id || typeof value.when !== "string" || value.when.length > 256) continue;
      const checked = validateShortcutWhen(value.when);
      if (!checked.ok) continue;
      const binding = value.binding === null ? null : validateShortcutBinding(value.binding);
      if (binding !== null && isBindingError(binding)) continue;
      rules.push({ id, binding, when: checked.value });
    }
    if (rules.length) parsed[actionId] = rules;
  }
  return parsed;
}

function loadPreferences(): { bindings: Record<string, ShortcutBinding | null>; conditions: Record<string, string>; contextualRules: Record<string, ShortcutContextRule[]> } {
  try {
    if (typeof localStorage === "undefined") return { bindings: {}, conditions: {}, contextualRules: {} };
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { bindings: {}, conditions: {}, contextualRules: {} };
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && Object.prototype.hasOwnProperty.call(parsed, "bindings")) {
      const envelope = parsed as Record<string, unknown>;
      const conditions: Record<string, string> = {};
      if (envelope.conditions && typeof envelope.conditions === "object" && !Array.isArray(envelope.conditions)) {
        for (const [id, value] of Object.entries(envelope.conditions as Record<string, unknown>)) {
          if (/^[a-z0-9][a-z0-9._:-]{0,100}$/i.test(id) && typeof value === "string" && value.length <= 256 && value.trim()) {
            conditions[id] = value.trim();
          }
        }
      }
      return {
        bindings: parseBindings(envelope.bindings),
        conditions,
        contextualRules: parseContextualRules(envelope.contextualRules),
      };
    }
    // A versão anterior gravava diretamente o mapa de combinações.
    return { bindings: parseBindings(parsed), conditions: {}, contextualRules: {} };
  } catch {
    return { bindings: {}, conditions: {}, contextualRules: {} };
  }
}

const initialPreferences = loadPreferences();

/** Id que separa a gravação de um acorde adicional da gravação do acorde principal. */
export function contextualRuleRecordingId(actionId: string, ruleId: string): string {
  return `rule:${actionId}:${ruleId}`;
}

export function parseContextualRuleRecordingId(value: string): { actionId: string; ruleId: string } | null {
  if (!value.startsWith("rule:")) return null;
  const separator = value.indexOf(":", 5);
  if (separator < 0) return null;
  const actionId = value.slice(5, separator);
  const ruleId = value.slice(separator + 1);
  return actionId && ruleId ? { actionId, ruleId } : null;
}

export const useShortcutPreferences = create<ShortcutPreferencesState>((set) => ({
  ...initialPreferences,
  recordingId: null,
  setBinding: (id, binding) => set((state) => ({
    bindings: { ...state.bindings, [id]: binding },
    recordingId: null,
  })),
  setCondition: (id, condition) => set((state) => {
    const conditions = { ...state.conditions };
    if (condition.trim()) conditions[id] = condition.trim();
    else delete conditions[id];
    return { conditions };
  }),
  addContextualRule: (id, ruleId) => set((state) => {
    const rules = state.contextualRules[id] ?? [];
    if (rules.length >= 20 || rules.some((rule) => rule.id === ruleId)) return state;
    return { contextualRules: { ...state.contextualRules, [id]: [...rules, { id: ruleId, binding: null, when: "" }] } };
  }),
  setContextualRuleBinding: (id, ruleId, binding) => set((state) => {
    const rules = state.contextualRules[id] ?? [];
    if (!rules.some((rule) => rule.id === ruleId)) return state;
    return {
      contextualRules: { ...state.contextualRules, [id]: rules.map((rule) => rule.id === ruleId ? { ...rule, binding } : rule) },
      recordingId: null,
    };
  }),
  setContextualRuleWhen: (id, ruleId, condition) => set((state) => {
    const rules = state.contextualRules[id] ?? [];
    if (!rules.some((rule) => rule.id === ruleId)) return state;
    return { contextualRules: { ...state.contextualRules, [id]: rules.map((rule) => rule.id === ruleId ? { ...rule, when: condition.trim() } : rule) } };
  }),
  removeContextualRule: (id, ruleId) => set((state) => {
    const rules = (state.contextualRules[id] ?? []).filter((rule) => rule.id !== ruleId);
    const contextualRules = { ...state.contextualRules };
    if (rules.length) contextualRules[id] = rules;
    else delete contextualRules[id];
    return { contextualRules, recordingId: state.recordingId === contextualRuleRecordingId(id, ruleId) ? null : state.recordingId };
  }),
  resetBinding: (id) => set((state) => {
    const bindings = { ...state.bindings };
    const conditions = { ...state.conditions };
    const contextualRules = { ...state.contextualRules };
    delete bindings[id];
    delete conditions[id];
    delete contextualRules[id];
    return { bindings, conditions, contextualRules, recordingId: null };
  }),
  resetAll: () => set({ bindings: {}, conditions: {}, contextualRules: {}, recordingId: null }),
  setRecordingId: (recordingId) => set({ recordingId }),
}));

useShortcutPreferences.subscribe((state) => {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 3, bindings: state.bindings, conditions: state.conditions, contextualRules: state.contextualRules }));
    }
  } catch {
    /* A preferência segue ativa nesta sessão, mesmo se não puder ser persistida. */
  }
});
