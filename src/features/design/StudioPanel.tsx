import { useEffect, useMemo, useRef, useState } from "react";

import { PopupSelect } from "@/shared/ui/PopupSelect";
import { useTranslation } from "react-i18next";
import type { StudioBoard } from "./ArtboardFrame";
import type { TreeNode } from "./frameBridge";
import { SHAPE_COLORS, swatchClass, WIDTH_RANGE, type Shape, type ShapeColor, type ShapeData } from "./shapes";
import { NOTE_COLORS, noteBg } from "./studioModel";
import type { StudioNoteItem } from "./StudioNote";
import { groupTweaks, readTweaks, type Tweak } from "./tweaks";

export type PanelTab = "props" | "layers" | "code" | "tweaks";
export const PANEL_TABS: PanelTab[] = ["props", "layers", "code", "tweaks"];
/** A largura do painel (312 px) e os limites do arrasto pela borda esquerda. */
export const PANEL_SIZE = { initial: 312, min: 260, max: 560 } as const;
export const clampPanel = (w: number) => Math.round(Math.min(PANEL_SIZE.max, Math.max(PANEL_SIZE.min, Number.isFinite(w) ? w : PANEL_SIZE.initial)));

export type SaveOutcome = "ok" | "conflict" | "error";

const label = "w-[72px] shrink-0 text-[12px] text-gray-500 dark:text-white/45";
const input = `h-7 min-w-0 flex-1 rounded-md px-2 text-[12.5px] bg-gray-50 dark:bg-white/[0.05] text-gray-900 dark:text-white/85
  ring-1 ring-gray-200 dark:ring-white/10 outline-none focus:ring-accent-500 tabular-nums`;
const smallBtn = `h-7 px-2.5 rounded-md text-[12.5px] text-gray-700 dark:text-white/80 ring-1 ring-gray-200 dark:ring-white/10
  hover:bg-gray-50 dark:hover:bg-white/10 disabled:opacity-40 disabled:pointer-events-none`;

/**
 * O painel direito do estúdio (312 px, redimensionável, ⌘\): Propriedades, Camadas, Código e Tweaks.
 * Abaixo de 600 px de largura vira uma folha de baixo (`sheet`).
 */
export function StudioPanel(p: {
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  width: number;
  onWidth: (w: number) => void;
  sheet: boolean;
  onClose: () => void;
  board: (StudioBoard & { contentHeight: number | null }) | null;
  note: StudioNoteItem | null;
  shape: Shape | null;
  onBoard: (patch: Partial<{ title: string; x: number; y: number; w: number; h: number; radius: number }>) => void;
  onFitHeight: () => void;
  onNote: (patch: Partial<{ color: string | null; w: number; h: number }>) => void;
  onShape: (patch: Partial<ShapeData>) => void;
  tree: TreeNode[] | null;
  treeSelected: string | null;
  onPickNode: (selector: string) => void;
  onRefreshTree: () => void;
  onSaveHtml: (html: string, expectedVersion: number) => Promise<SaveOutcome>;
  onSaveTweaks: (values: Record<string, Tweak["value"]>) => void;
}) {
  const { t } = useTranslation();
  const [drag, setDrag] = useState(false);
  const frame = p.sheet
    ? "absolute inset-x-0 bottom-0 h-[45%] z-30 border-t rounded-t-xl"
    : "relative h-full shrink-0 border-l";
  return (
    <aside aria-label={t("design.panel.label")} style={p.sheet ? undefined : { width: p.width }}
      className={`${frame} flex flex-col min-h-0 border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-deep`}>
      {p.sheet ? (
        <div className="h-4 shrink-0 flex items-center justify-center" aria-hidden="true">
          <span className="w-9 h-1 rounded-full bg-gray-300 dark:bg-white/20" />
        </div>
      ) : (
        <div role="separator" aria-orientation="vertical" aria-label={t("design.panel.resize")} title={t("design.panel.resize")}
          className="absolute -left-[3px] top-0 bottom-0 w-[6px] z-10 cursor-col-resize"
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag(true); }}
          onPointerMove={(e) => { if (drag) p.onWidth(clampPanel(e.currentTarget.parentElement!.getBoundingClientRect().right - e.clientX)); }}
          onPointerUp={() => setDrag(false)}
          onDoubleClick={() => p.onWidth(PANEL_SIZE.initial)} />
      )}
      <div role="tablist" className="h-10 shrink-0 flex items-center gap-0.5 px-1.5 border-b border-gray-200 dark:border-white/[0.08]">
        {PANEL_TABS.map((id) => (
          <button key={id} type="button" role="tab" aria-selected={p.tab === id} onClick={() => p.onTab(id)}
            className={`h-7 px-2 rounded-md text-[12.5px] ${p.tab === id ? "bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white font-medium" : "text-gray-500 dark:text-white/50 hover:bg-gray-100/60 dark:hover:bg-white/[0.06]"}`}>
            {t(`design.panel.tab.${id}`)}
          </button>
        ))}
        <span className="flex-1" />
        <button type="button" onClick={p.onClose} aria-label={t("design.panel.close")} title={t("design.panel.close")}
          className="w-7 h-7 rounded-md text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/10">×</button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 text-[12.5px] text-gray-800 dark:text-white/85">
        {p.tab === "props" && <PropsTab {...p} />}
        {p.tab === "layers" && <LayersTab {...p} />}
        {p.tab === "code" && <CodeTab {...p} />}
        {p.tab === "tweaks" && <TweaksTab {...p} />}
      </div>
    </aside>
  );
}

function Empty({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div className="py-6 text-center">
      <div className="text-[13px] text-gray-700 dark:text-white/70">{t("design.panel.nothing")}</div>
      <div className="mt-1 text-[12px] text-gray-500 dark:text-white/45">{text}</div>
    </div>
  );
}

/** Um campo numérico que só grava ao confirmar (Enter ou sair), como os da tela de referência. */
function NumField({ name, value, onCommit, min, max }: { name: string; value: number; onCommit: (v: number) => void; min?: number; max?: number }) {
  const [v, setV] = useState(String(Math.round(value)));
  useEffect(() => setV(String(Math.round(value))), [value]);
  const commit = () => {
    const n = Number(v);
    if (!Number.isFinite(n)) return setV(String(Math.round(value)));
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, Math.round(n)));
    if (c !== Math.round(value)) onCommit(c);
    setV(String(c));
  };
  return (
    <label className="flex min-w-0 flex-1 items-center gap-1">
      <span className="w-4 text-[11px] text-gray-400">{name}</span>
      <input className={input} inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commit(); }} />
    </label>
  );
}

function Swatches({ colors, value, onPick, classOf, allowNone, noneLabel }: {
  colors: readonly string[]; value: string | null; onPick: (c: string | null) => void; classOf: (c: string) => string; allowNone?: boolean; noneLabel?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {allowNone && (
        <button type="button" aria-pressed={value === null} onClick={() => onPick(null)} title={noneLabel} aria-label={noneLabel}
          className={`w-5 h-5 rounded-full ring-1 ring-gray-300 dark:ring-white/20 bg-white dark:bg-transparent ${value === null ? "outline outline-2 outline-accent-500 outline-offset-1" : ""}`}>
          <span className="block w-full h-px rotate-45 bg-red-500" />
        </button>
      )}
      {colors.map((c) => (
        <button key={c} type="button" aria-pressed={value === c} onClick={() => onPick(c)} title={c} aria-label={c}
          className={`w-5 h-5 rounded-full ring-1 ring-black/10 ${classOf(c)} ${value === c ? "outline outline-2 outline-accent-500 outline-offset-1" : ""}`} />
      ))}
    </div>
  );
}

function PropsTab(p: Parameters<typeof StudioPanel>[0]) {
  const { t } = useTranslation();
  if (p.board) {
    const b = p.board;
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className={label}>{t("design.panel.title")}</span>
          <TitleField value={b.title} onCommit={(title) => p.onBoard({ title })} />
        </div>
        <div className="flex items-center gap-2">
          <span className={label}>{t("design.panel.position")}</span>
          <NumField name="X" value={b.x} onCommit={(x) => p.onBoard({ x })} />
          <NumField name="Y" value={b.y} onCommit={(y) => p.onBoard({ y })} />
        </div>
        <div className="flex items-center gap-2">
          <span className={label}>{t("design.panel.size")}</span>
          <NumField name="L" value={b.w} min={120} max={8000} onCommit={(w) => p.onBoard({ w })} />
          <NumField name="A" value={b.h} min={120} max={8000} onCommit={(h) => p.onBoard({ h })} />
        </div>
        <div className="flex items-center gap-2">
          <span className={label}>{t("design.panel.radius")}</span>
          <NumField name="R" value={b.radius} min={0} max={200} onCommit={(radius) => p.onBoard({ radius })} />
        </div>
        <button type="button" className={smallBtn} disabled={!b.contentHeight} onClick={p.onFitHeight}>{t("design.studio.fitHeight")}</button>
      </div>
    );
  }
  if (p.note) {
    const n = p.note;
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2">
          <span className={label}>{t("design.panel.color")}</span>
          <Swatches colors={NOTE_COLORS} value={n.color ?? "yellow"} onPick={(c) => p.onNote({ color: c === "yellow" ? null : c })} classOf={noteBg} />
        </div>
        <div className="flex items-center gap-2">
          <span className={label}>{t("design.panel.size")}</span>
          <NumField name="L" value={n.w} min={80} max={2000} onCommit={(w) => p.onNote({ w })} />
          <NumField name="A" value={n.h} min={40} max={2000} onCommit={(h) => p.onNote({ h })} />
        </div>
      </div>
    );
  }
  if (p.shape) {
    const s = p.shape;
    const filled = s.kind === "rect" || s.kind === "oval";
    return (
      <div className="space-y-3">
        <div className="text-[12px] text-gray-500 dark:text-white/45">{t(`design.studio.tool.${s.kind}`)}</div>
        <div className="flex items-start gap-2">
          <span className={label}>{s.kind === "text" ? t("design.panel.color") : t("design.panel.stroke")}</span>
          <Swatches colors={SHAPE_COLORS} value={s.data.stroke} onPick={(c) => p.onShape({ stroke: (c ?? "black") as ShapeColor })} classOf={(c) => swatchClass(c as ShapeColor)} />
        </div>
        {filled && (
          <div className="flex items-start gap-2">
            <span className={label}>{t("design.panel.fill")}</span>
            <Swatches colors={SHAPE_COLORS} value={s.data.fill} allowNone noneLabel={t("design.panel.noFill")} onPick={(c) => p.onShape({ fill: c as ShapeColor | null })} classOf={(c) => swatchClass(c as ShapeColor)} />
          </div>
        )}
        {s.kind === "text" ? (
          <div className="flex items-center gap-2">
            <span className={label}>{t("design.panel.fontSize")}</span>
            <NumField name="" value={s.data.size} min={8} max={200} onCommit={(size) => p.onShape({ size })} />
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className={label}>{t("design.panel.strokeWidth")}</span>
            <input type="range" min={WIDTH_RANGE.min} max={WIDTH_RANGE.max} value={s.data.width} aria-label={t("design.panel.strokeWidth")}
              onChange={(e) => p.onShape({ width: Number(e.target.value) })} className="flex-1 accent-accent-500" />
            <span className="w-6 text-right tabular-nums">{s.data.width}</span>
          </div>
        )}
      </div>
    );
  }
  return <Empty text={t("design.panel.propsHint")} />;
}

function TitleField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { const n = v.trim(); if (n && n !== value) onCommit(n); else setV(value); };
  return <input className={input} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commit(); }} />;
}

function LayersTab(p: Parameters<typeof StudioPanel>[0]) {
  const { t } = useTranslation();
  if (!p.board) return <Empty text={t("design.panel.layersHint")} />;
  if (!p.tree) return <p className="py-4 text-center text-gray-500 dark:text-white/45">{t("design.panel.layersLoading")}</p>;
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-gray-500 dark:text-white/45">{p.board.title}</span>
        <button type="button" className={smallBtn} onClick={p.onRefreshTree}>{t("design.panel.refresh")}</button>
      </div>
      {p.tree.length === 0 && <p className="text-gray-500 dark:text-white/45">{t("design.panel.layersEmpty")}</p>}
      <ul role="tree" aria-label={t("design.panel.tab.layers")} className="font-mono text-[11.5px]">
        {p.tree.map((n) => (
          <li key={n.selector} role="treeitem" aria-selected={p.treeSelected === n.selector}>
            <button type="button" onClick={() => p.onPickNode(n.selector)} title={n.selector}
              className={`w-full h-6 rounded flex items-center gap-1 text-left truncate ${p.treeSelected === n.selector ? "bg-accent-500/15 text-accent-700 dark:text-accent-300" : "hover:bg-gray-100 dark:hover:bg-white/[0.06]"}`}
              style={{ paddingLeft: 4 + n.depth * 12 }}>
              <span className="text-accent-600 dark:text-accent-300">{n.tag}</span>
              {n.id && <span className="text-gray-500">#{n.id}</span>}
              {!n.id && n.cls && <span className="text-gray-400 truncate">.{n.cls.split(/\s+/)[0]}</span>}
              {n.text && <span className="truncate font-sans text-gray-500 dark:text-white/45">“{n.text}”</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CodeTab(p: Parameters<typeof StudioPanel>[0]) {
  const { t } = useTranslation();
  const b = p.board;
  const [draft, setDraft] = useState(b?.html ?? "");
  const [base, setBase] = useState<{ id: string; version: number } | null>(b ? { id: b.id, version: b.version } : null);
  const [state, setState] = useState<"idle" | "saving" | "conflict" | "saved">("idle");
  // Outra prancheta, ou a mesma mudou lá fora sem edição local: acompanha o servidor.
  const server = useRef(b?.html ?? "");
  useEffect(() => {
    if (!b) return;
    if (base?.id !== b.id || (draft === server.current && state !== "conflict")) {
      setDraft(b.html);
      setBase({ id: b.id, version: b.version });
      setState("idle");
    }
    server.current = b.html;
  }, [b?.id, b?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!b || !base) return <Empty text={t("design.panel.codeHint")} />;
  const dirty = draft !== b.html;
  const save = async (version: number) => {
    setState("saving");
    const out = await p.onSaveHtml(draft, version);
    setState(out === "conflict" ? "conflict" : out === "ok" ? "saved" : "idle");
    if (out === "ok") setBase({ id: b.id, version: b.version + 1 });
  };
  return (
    <div className="flex h-full flex-col gap-2">
      {state === "conflict" && (
        <div role="alert" className="rounded-md bg-amber-400/15 p-2 text-[12px] text-amber-800 dark:text-amber-200">
          {t("design.panel.conflict", { version: b.version })}
          <div className="mt-1.5 flex gap-1.5">
            <button type="button" className={smallBtn} onClick={() => { setDraft(b.html); setBase({ id: b.id, version: b.version }); setState("idle"); }}>{t("design.panel.reload")}</button>
            <button type="button" className={smallBtn} onClick={() => void save(b.version)}>{t("design.panel.overwrite")}</button>
          </div>
        </div>
      )}
      <textarea value={draft} spellCheck={false} aria-label={t("design.panel.tab.code")}
        onChange={(e) => { setDraft(e.target.value); if (state === "saved") setState("idle"); }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "s" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (dirty) void save(base.version); } }}
        className="min-h-[240px] flex-1 resize-none rounded-md bg-gray-50 dark:bg-white/[0.04] p-2 font-mono text-[11.5px] leading-relaxed ring-1 ring-gray-200 dark:ring-white/10 outline-none focus:ring-accent-500" />
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[11.5px] text-gray-500 dark:text-white/45">v{b.version}{state === "saved" ? ` · ${t("design.panel.saved")}` : ""}</span>
        <button type="button" className={smallBtn} disabled={!dirty} onClick={() => setDraft(b.html)}>{t("design.panel.discard")}</button>
        <button type="button" disabled={!dirty || state === "saving"} onClick={() => void save(base.version)}
          className="h-7 px-2.5 rounded-md text-[12.5px] font-medium bg-accent-500 text-white hover:bg-accent-600 disabled:opacity-40 disabled:pointer-events-none">
          {t("design.panel.save")}
        </button>
      </div>
    </div>
  );
}

function TweaksTab(p: Parameters<typeof StudioPanel>[0]) {
  const { t } = useTranslation();
  const tweaks = useMemo(() => (p.board ? readTweaks(p.board.html) : []), [p.board]);
  const [values, setValues] = useState<Record<string, Tweak["value"]>>({});
  useEffect(() => setValues({}), [p.board?.id, p.board?.version]);
  if (!p.board) return <Empty text={t("design.panel.tweaksHint")} />;
  if (tweaks.length === 0) return <p className="py-4 text-gray-500 dark:text-white/45">{t("design.panel.noTweaks")}</p>;
  const val = (tw: Tweak) => (tw.name in values ? values[tw.name] : tw.value);
  const set = (name: string, v: Tweak["value"]) => setValues((s) => ({ ...s, [name]: v }));
  const dirty = Object.keys(values).length > 0;
  return (
    <div className="space-y-4">
      {groupTweaks(tweaks).map((g) => (
        <section key={g.section ?? "_"} className="space-y-2">
          {g.section && <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-white/45">{g.section}</h3>}
          {g.items.map((tw) => (
            <div key={tw.name} className="flex items-center gap-2">
              <span className={`${label} truncate`} title={tw.name}>{tw.name}</span>
              <TweakControl tweak={tw} value={val(tw)} onChange={(v) => set(tw.name, v)} />
              {tw.name in values && (
                <button type="button" className="text-[11px] text-gray-500 hover:underline" onClick={() => setValues((s) => { const n = { ...s }; delete n[tw.name]; return n; })}>{t("design.panel.reset")}</button>
              )}
            </div>
          ))}
        </section>
      ))}
      <div className="flex gap-1.5 border-t border-gray-200 dark:border-white/[0.08] pt-3">
        <button type="button" className={smallBtn} disabled={!dirty} onClick={() => setValues({})}>{t("design.panel.reset")}</button>
        <span className="flex-1" />
        <button type="button" className={smallBtn} disabled={!dirty} onClick={() => { p.onSaveTweaks(values); setValues({}); }}>{t("design.panel.saveDefaults")}</button>
      </div>
    </div>
  );
}

function TweakControl({ tweak, value, onChange }: { tweak: Tweak; value: Tweak["value"]; onChange: (v: Tweak["value"]) => void }) {
  switch (tweak.editor) {
    case "boolean":
      return <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="accent-accent-500" />;
    case "enum":
      return (
        <PopupSelect value={String(value)} onChange={(e) => onChange(e.target.value)} aria-label={tweak.name}>
          {tweak.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </PopupSelect>
      );
    case "range":
      return <input type="range" className="flex-1 accent-accent-500" min={tweak.min ?? 0} max={tweak.max ?? 100} step={tweak.step ?? 1} value={Number(value)} onChange={(e) => onChange(Number(e.target.value))} />;
    case "int":
    case "float":
      return <input className={input} inputMode="decimal" value={String(value)} onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(tweak.editor === "int" ? Math.round(n) : n); }} />;
    default:
      // Texto e cor: o valor é do usuário/agente, editado como texto (sem seletor de cor nativo, que só aceita hex).
      return <input className={input} value={String(value)} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => onChange(e.target.value)} />;
  }
}
