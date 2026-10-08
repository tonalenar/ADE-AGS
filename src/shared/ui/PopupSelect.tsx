import {
  Children, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type ChangeEvent, type ReactElement, type ReactNode, type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

/**
 * O seletor da app: um botão "pop-up" no estilo do macOS que abre um menu próprio.
 *
 * Por que não o `<select>` nativo: no Windows (WebView2) a lista que abre é a do sistema — branca,
 * sem o tema, sem raio, com o destaque cinza do Windows. Não há CSS que a alcance.
 *
 * Como trocar: tem a MESMA API do `<select>` (value/defaultValue, onChange com `event.target.value`,
 * filhos `<option>`/`<optgroup>`, disabled, aria-*). Por baixo continua existindo um `<select>`
 * escondido (sr-only, fora da ordem do Tab) com as mesmas opções: formulários, testes
 * (`fireEvent.change`) e leitores de tela continuam funcionando sem mudar nada.
 */

interface Opt { value: string; label: ReactNode; text: string; disabled: boolean; group: string | null }

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

function collect(children: ReactNode, group: string | null = null, out: Opt[] = []): Opt[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<{ value?: string | number; children?: ReactNode; disabled?: boolean; label?: string }>;
    if (el.type === "option") {
      const label = el.props.children;
      const value = el.props.value !== undefined ? String(el.props.value) : textOf(label);
      out.push({ value, label, text: textOf(label), disabled: !!el.props.disabled, group });
    } else if (el.type === "optgroup") {
      collect(el.props.children, el.props.label ?? null, out);
    } else if (el.props.children) {
      collect(el.props.children, group, out); // fragmentos e afins
    }
  });
  return out;
}

export type PopupSelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  /** Classe extra do BOTÃO visível (largura, altura). */
  className?: string;
  /** Mostrado quando nenhuma opção bate com o valor. */
  placeholder?: ReactNode;
};

export function PopupSelect({ children, className = "", placeholder, value, defaultValue, onChange, disabled, id, title, ...rest }: PopupSelectProps) {
  const options = useMemo(() => collect(children), [children]);
  const nativeRef = useRef<HTMLSelectElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const buttonId = useId();
  const controlled = value !== undefined;
  const [inner, setInner] = useState<string>(String(defaultValue ?? options[0]?.value ?? ""));
  const current = controlled ? String(value ?? "") : inner;
  const selected = options.find((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number; maxHeight: number } | null>(null);

  const choose = useCallback((opt: Opt) => {
    if (opt.disabled) return;
    setOpen(false);
    buttonRef.current?.focus();
    if (opt.value === current) return;
    if (!controlled) setInner(opt.value);
    const native = nativeRef.current;
    if (native) {
      native.value = opt.value;
      onChange?.({ target: native, currentTarget: native } as unknown as ChangeEvent<HTMLSelectElement>);
    }
  }, [controlled, current, onChange]);

  // Abre embaixo do botão (ou em cima, se não couber), alinhado à esquerda e com a largura dele.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const want = Math.min(320, options.length * 28 + 12);
    const up = below < Math.min(want, 180) && above > below;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 180) - 8)),
      top: up ? Math.max(8, r.top - Math.min(want, above) - 4) : r.bottom + 4,
      minWidth: r.width,
      maxHeight: up ? Math.min(want, above) : Math.min(want, below),
    });
    setActive(Math.max(0, options.findIndex((o) => o.value === current)));
  }, [open, options, current]);

  useLayoutEffect(() => {
    const el = menuRef.current as (HTMLDivElement & { showPopover?: () => void }) | null;
    if (!open || !pos || !el?.showPopover) return;
    try { el.showPopover(); } catch { /* sem suporte: fica o portal com z-index */ }
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    const openedAt = performance.now();
    const onScroll = (e: Event) => {
      if (performance.now() - openedAt < 200) return;
      const t = e.target as Node;
      if (t === menuRef.current || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", () => setOpen(false), { once: true });
    return () => {
      document.removeEventListener("mousedown", close, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (!id) return;
    const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    if (label && !label.id) label.id = `${id}-label`;
  }, [id]);

  useEffect(() => {
    if (!open || active < 0) return;
    const menu = menuRef.current;
    const item = menu?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!menu || !item) return;
    if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop - 4;
    else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight + 4;
  }, [open, active]);

  const move = (dir: 1 | -1) => {
    if (!options.length) return;
    let i = active;
    for (let n = 0; n < options.length; n++) {
      i = (i + dir + options.length) % options.length;
      if (!options[i].disabled) break;
    }
    setActive(i);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault(); setOpen(true); return;
    }
    if (!open) return;
    if (e.key === "Escape" || e.key === "Tab") { setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (options[active]) choose(options[active]); }
    else if (e.key.length === 1) {
      const k = e.key.toLowerCase();
      const i = options.findIndex((o, idx) => idx > active && !o.disabled && o.text.toLowerCase().startsWith(k));
      const j = i >= 0 ? i : options.findIndex((o) => !o.disabled && o.text.toLowerCase().startsWith(k));
      if (j >= 0) setActive(j);
    }
  };

  let lastGroup: string | null = null;
  // Quem passava `w-full` ao <select> espera ocupar a linha: o invólucro acompanha.
  const full = /(^|\s)(w-full|flex-1)(\s|$)/.test(className);
  return (
    <span className={`relative ${full ? "flex w-full" : "inline-flex"} min-w-0`}>
      {/* O <select> de verdade: escondido, mas vivo para formulários, testes e leitores de tela. */}
      <select ref={nativeRef} id={id} {...rest} value={controlled ? current : undefined} defaultValue={controlled ? undefined : defaultValue}
        disabled={disabled} onChange={(e) => { if (!controlled) setInner(e.target.value); onChange?.(e); }}
        tabIndex={-1} className="sr-only">
        {children}
      </select>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        id={buttonId}
        title={title}
        aria-label={rest["aria-label"]}
        aria-labelledby={!rest["aria-label"] && id ? `${id}-label ${buttonId}` : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className={`group inline-flex items-center justify-between gap-2 h-[30px] min-w-0 pl-3 pr-2 rounded-md text-left text-[13px]
          bg-white dark:bg-surface-raised text-gray-900 dark:text-gray-100
          shadow-[0_0_0_0.5px_rgba(0,0,0,0.16),0_1px_2px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.12),0_1px_2px_rgba(0,0,0,0.4)]
          hover:bg-gray-50 dark:hover:bg-[#333336] disabled:opacity-50 disabled:cursor-not-allowed
          focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent-500/30
          ${open ? "ring-[3px] ring-accent-500/25" : ""} ${className}`}
      >
        <span className={`truncate ${selected ? "" : "text-gray-400 dark:text-gray-500"}`}>{selected ? selected.label : (placeholder ?? "")}</span>
        <ChevronsIcon className="w-3 h-3.5 shrink-0 text-gray-400 dark:text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-200" />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          {...{ popover: "manual" }}
          onKeyDown={onKeyDown}
          style={{ position: "fixed", inset: "auto", margin: 0, border: 0, left: pos.left, top: pos.top, minWidth: pos.minWidth, maxHeight: pos.maxHeight, zIndex: 10050, color: "inherit" }}
          className="cc-scroll overflow-y-auto p-1 rounded-lg text-[13px]
            bg-white/90 dark:bg-[#2a2a2d]/90 backdrop-blur-xl
            shadow-[0_0_0_0.5px_rgba(0,0,0,0.14),0_10px_30px_rgba(0,0,0,0.18)] dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.12),0_10px_30px_rgba(0,0,0,0.55)]"
        >
          {options.map((o, i) => {
            const header = o.group !== lastGroup && o.group ? o.group : null;
            lastGroup = o.group;
            const isSel = o.value === current;
            const isActive = i === active;
            return (
              <div key={`${o.group ?? ""}:${o.value}:${i}`}>
                {header && <div className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-400 dark:text-gray-500">{header}</div>}
                <div
                  role="option"
                  aria-selected={isSel}
                  aria-disabled={o.disabled || undefined}
                  data-index={i}
                  onMouseEnter={() => !o.disabled && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(o)}
                  className={`flex items-center gap-2 h-[26px] pl-1.5 pr-3 rounded-[5px] whitespace-nowrap cursor-default select-none
                    ${o.disabled ? "text-gray-300 dark:text-white/25" : isActive ? "bg-accent-500 text-white" : "text-gray-800 dark:text-gray-100"}`}
                >
                  <span className={`w-3.5 shrink-0 text-[11px] ${isActive ? "text-white" : "text-accent-500 dark:text-accent-400"}`}>{isSel ? "✓" : ""}</span>
                  <span className="truncate">{o.label}</span>
                </div>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </span>
  );
}

function ChevronsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M3 6l3-3 3 3M3 10l3 3 3-3" />
    </svg>
  );
}
