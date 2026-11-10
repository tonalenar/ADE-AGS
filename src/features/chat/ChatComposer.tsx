import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { canSubmit, composerMaxHeight, type Attachment } from "./attachments/attachModel";
import { COMPOSER_COMMAND_EVENT, FILE_PICKER_COMMAND_EVENT, type ComposerCommandDetail, type FilePickerCommandDetail } from "./composerCommands";
import { AttachmentStrip } from "./attachments/AttachmentStrip";
import { registerDropSink } from "./attachments/dropRegistry";
import { useAttachments } from "./attachments/useAttachments";
import { ArchiveIcon, ArrowUpIcon, PaperclipIcon, StopIcon, XIcon } from "./chatIcons";
import { withQuotes } from "./quotes/quoteModel";
import { ScreenRecordButton } from "@/features/recording/ScreenRecordButton";
import { DesktopSnapshotButton } from "@/features/recording/DesktopSnapshotButton";
import { VoiceInputButton } from "@/features/recording/VoiceInputButton";
import { QuoteCards } from "./quotes/QuoteCards";
import { addQuoteFor, clearQuotesFor, removeQuoteFor, useQuotes } from "./quotes/quoteStore";
import { QueueList } from "./QueueList";
import { useChatPrefs } from "./chatPrefs";
import { acknowledgeComposerAttachments, requestTabSearchJump, requestThreadSearchJump, takeComposerInserts, useChatStore, type QueuedMessage } from "./store";
import { getPromptStash, loadPromptStashes, MAX_PROMPT_STASHES, removePromptStash, savePromptStash, usePromptStash, type PromptStash } from "./promptStash";

/** O caminho do arquivo relativo à pasta da conversa (com `/`), ou o absoluto se for de fora. Pura. */
export function mentionFor(cwd: string | null, path: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const base = cwd ? norm(cwd).replace(/\/+$/, "") + "/" : null;
  const file = norm(path);
  const rel = base && file.startsWith(base) ? file.slice(base.length) : file;
  return `@${/\s/.test(rel) ? `"${rel}"` : rel}`;
}

/** Junta um trecho ao texto, com um espaço entre os dois e outro no fim. Pura. */
export function appendMention(prev: string, mention: string): string {
  return prev && !/\s$/.test(prev) ? `${prev} ${mention} ` : `${prev}${mention} `;
}

/** O que o `addon` do composer recebe: o texto, o cursor e como trocar os dois. */
export interface ComposerAddonContext {
  text: string;
  caret: number;
  apply: (text: string, caret: number) => void;
  /** Anexa arquivos escolhidos na paleta contextual e mostra os chips no composer. */
  addPaths: (paths: string[]) => Promise<boolean>;
  /** Registra a navegação por teclado do menu contextual aberto no composer. */
  registerKeyHandler: (handler: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean) => () => void;
}

/** O que os controles no rodapé precisam saber sobre o rascunho atual. */
export interface ComposerControlsContext {
  text: string;
  /** Há contexto adicional no composer. */
  hasExtraContext: boolean;
  /** Arquivos/imagens já aceitos pelo composer, para ações que encaminham o contexto. */
  attachments: Attachment[];
  /** Citações ainda não têm contrato de transferência para Comparar modelos. */
  hasQuotes: boolean;
}

/**
 * A caixa do composer da prancheta (a do T3 Code): cartão de vidro com cantos de 16 px, o texto em
 * cima e, embaixo, anexar à esquerda, os controles e o botão redondo de 32 px à direita. Enter
 * usa Shift+Enter para quebrar a linha e, durante um turno, segue a preferência de enviar agora ou pôr na fila;
 * ⌘/Ctrl+Enter executa a ação oposta. Na tela de conversa nova, pode iniciar a conversa em segundo plano.
 * `Alt+↑` carrega a mensagem mais recente da fila para edição, e o item
 * continua lá até salvar ou cancelar. A fila aparece acima da caixa (`QueueList`). Com o agente
 * trabalhando e a caixa vazia, o botão vira Parar.
 *
 * Anexos como no Claude Code: Cmd/Ctrl+V cola a imagem do clipboard, soltar arquivos na coluna do chat e
 * o clipe os põem numa fileira de miniaturas acima do texto; o bloco (miniaturas + texto) cresce até 40%
 * da janela e depois rola por dentro, sem barra, com o enviar sempre à vista. Enviar só com anexos vale.
 */
export function ChatComposer({ placeholder, controls, leading = null, addon, onSubmit, onBackgroundSubmit, onSendAndNewThread, onStop, onQueue, queue: waiting = [], onUnqueue, onUpdateQueued, promptHistory = [], cwd = null, disabled = false, autoFocus = false, quoteKey = null, composerTarget = quoteKey, quoteThreadId, quoteSourceIds, turnActive = false, forceSend = false }: {
  placeholder: string;
  /** Logo depois do anexar, à esquerda (o segmentado "Time | Só o orquestrador", prancheta 15). */
  leading?: React.ReactNode;
  /** Acima da caixa, com o texto e o cursor (o menu do @agente do time). `apply` troca os dois. */
  addon?: (ctx: ComposerAddonContext) => React.ReactNode;
  /** Entre o espaço vazio e o botão de enviar. Pode ler o rascunho sem duplicar seu estado. */
  controls?: React.ReactNode | ((context: ComposerControlsContext) => React.ReactNode);
  /** `false` (ou erro) = não foi: o texto e os anexos continuam na caixa. */
  onSubmit: (text: string, attachments: Attachment[]) => boolean | void | Promise<boolean | void>;
  /** Inicia uma nova conversa sem selecioná-la e mantém o composer limpo para outro rascunho. */
  onBackgroundSubmit?: ((text: string, attachments: Attachment[]) => boolean | void | Promise<boolean | void>) | null;
  /** Inicia outro rascunho local depois que o envio ao fio atual for aceito. */
  onSendAndNewThread?: (() => void) | null;
  /** O agente está trabalhando: o botão vira Parar (com a caixa vazia). */
  onStop?: (() => void) | null;
  /** Põe a mensagem na fila da conversa (sai quando o turno acabar). */
  onQueue?: ((text: string, attachments: Attachment[]) => boolean | void) | null;
  /** As mensagens esperando a vez (aparecem acima da caixa, com editar e tirar). */
  queue?: QueuedMessage[];
  /** Tira a mensagem da fila e devolve o texto dela (`null` = já saiu). */
  onUnqueue?: ((id: string) => string | null) | null;
  /** Atualiza a mensagem sem tirá-la da posição atual. */
  onUpdateQueued?: ((id: string, text: string) => boolean) | null;
  /** Falas anteriores da pessoa na conversa, em ordem cronológica, para retomar com ↑/↓. */
  promptHistory?: string[];
  /** A pasta da conversa, para o anexo virar um caminho relativo. */
  cwd?: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
  /** A conversa de que vêm as citações («Comentar»): elas viram cartões acima do campo e vão na mensagem. */
  quoteKey?: string | null;
  /** Identidade de roteamento para capturas/anexos externos, inclusive no composer de conversa nova. */
  composerTarget?: string | null;
  /** IDs ainda presentes na timeline; citações sem origem carregada ficam sem ação de navegação. */
  quoteSourceIds?: ReadonlySet<string>;
  /** ID do fio de protocolo, separado da chave local do composer, quando a citação vem de uma thread. */
  quoteThreadId?: string;
  /** O agente está no meio de um turno; só então a preferência de acompanhamento altera Enter. */
  turnActive?: boolean;
  /** Uma pergunta/aprovação espera resposta direta, independentemente da preferência. */
  forceSend?: boolean;
}) {
  const { t } = useTranslation();
  // A leitura dos rascunhos roda uma vez ao montar; o `t` mais novo vale só para a mensagem de erro.
  const tRef = useRef(t);
  tRef.current = t;
  const eventTarget = composerTarget ?? quoteKey;
  const followUpBehavior = useChatPrefs().followUpBehavior;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submitInFlightRef = useRef(false);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const queuedDraft = useRef<{ id: string; text: string; caret: number } | null>(null);
  const [caret, setCaret] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [stashMenuOpen, setStashMenuOpen] = useState(false);
  const [stashStatus, setStashStatus] = useState("");
  const [stashBusy, setStashBusy] = useState(false);
  const [stashRestoring, setStashRestoring] = useState(false);
  const [pendingCrossProjectStash, setPendingCrossProjectStash] = useState<PromptStash | null>(null);
  const stashRestoringRef = useRef(false);
  const attachDialogOpenRef = useRef(false);
  const composerMountedRef = useRef(false);
  const deferredComposerActionRef = useRef(false);
  const processingAttachSeqsRef = useRef(new Set<number>());
  useEffect(() => {
    composerMountedRef.current = true;
    return () => { composerMountedRef.current = false; };
  }, []);
  const historyDraft = useRef<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const isComposerActive = useCallback(() => {
    const active = document.activeElement;
    return !!active && !!formRef.current?.contains(active);
  }, []);
  const addonKeyHandler = useRef<((event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean) | null>(null);
  const registerKeyHandler = useCallback((handler: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean) => {
    addonKeyHandler.current = handler;
    return () => { if (addonKeyHandler.current === handler) addonKeyHandler.current = null; };
  }, []);
  // O cursor pedido por `apply` (o @ trocado pelo apelido): aplicado depois de o texto mudar.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !ref.current) return;
    pendingCaret.current = null;
    ref.current.focus();
    ref.current.setSelectionRange(at, at);
    setCaret(at);
  }, [text]);
  const setComposerText = (next: string, at: number) => { pendingCaret.current = at; setText(next); };
  const apply = (next: string, at: number) => {
    if (stashRestoringRef.current) { setStashStatus(t("chat.stash.restoreInProgress")); return; }
    setComposerText(next, at);
  };
  const insertTranscript = (transcript: string) => {
    if (stashRestoringRef.current) return;
    const el = ref.current;
    const start = el?.selectionStart ?? caret;
    const end = el?.selectionEnd ?? start;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const phrase = transcript.trim();
    if (!phrase) return;
    const leadingSpace = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const trailingSpace = after.length > 0 && !/^\s/.test(after) ? " " : "";
    const insertion = `${leadingSpace}${phrase}${trailingSpace}`;
    apply(`${before}${insertion}${after}`, before.length + insertion.length);
  };
  const browseHistory = (direction: -1 | 1) => {
    if (promptHistory.length === 0) return false;
    if (direction === -1) {
      if (historyIndex === 0) return true;
      if (historyIndex === null) historyDraft.current = text;
      const next = historyIndex === null ? promptHistory.length - 1 : historyIndex - 1;
      const value = promptHistory[next];
      if (value === undefined) return false;
      setHistoryIndex(next);
      apply(value, value.length);
      return true;
    }
    if (historyIndex === null) return false;
    const next = historyIndex + 1;
    if (next >= promptHistory.length) {
      const draft = historyDraft.current ?? "";
      historyDraft.current = null;
      setHistoryIndex(null);
      apply(draft, draft.length);
      return true;
    }
    const value = promptHistory[next];
    if (value === undefined) return false;
    setHistoryIndex(next);
    apply(value, value.length);
    return true;
  };
  const attachments = useAttachments();
  const quotes = useQuotes(quoteKey);
  const quotesRef = useRef(quotes);
  quotesRef.current = quotes;
  const stashes = usePromptStash((s) => s.items);
  const stashLoaded = usePromptStash((s) => s.loaded);
  const hasStashContent = text.trim().length > 0 || attachments.list.length > 0 || quotes.length > 0;
  const stashContentRef = useRef("");
  stashContentRef.current = JSON.stringify({
    text,
    attachmentPaths: attachments.list.map((attachment) => attachment.path),
    quotes: quotes.map(({ text: quoteText, comment, originItemId }) => ({ text: quoteText, comment, originItemId })),
    quoteKey,
    cwd,
  });
  const quoteCards = quotes.map((quote) => ({
    ...quote,
    originItemId: quote.originItemId && quoteSourceIds?.has(quote.originItemId) ? quote.originItemId : undefined,
  }));
  const navigateToQuoteSource = (itemId: string) => {
    if (!quoteKey || !quoteSourceIds?.has(itemId)) return;
    if (quoteThreadId) requestThreadSearchJump(quoteThreadId, itemId);
    else if (quoteKey.startsWith("thread:")) requestThreadSearchJump(quoteKey.slice("thread:".length), itemId);
    else requestTabSearchJump(quoteKey, itemId);
  };
  const saveCurrentPrompt = async () => {
    if (!hasStashContent || editingQueueId || stashBusy) return;
    if (attachments.isIngestingAttachments()) {
      setStashStatus(t("chat.stash.attachmentsPending"));
      return;
    }
    setStashStatus("");
    const input = {
      text,
      attachmentPaths: attachments.list.map((attachment) => attachment.path),
      quotes: quotes.map(({ text: quoteText, comment, originItemId }) => ({ text: quoteText, comment, originItemId })),
      quoteKey,
      cwd,
    };
    const savedSnapshot = JSON.stringify(input);
    setStashBusy(true);
    try {
      await savePromptStash(input);
      // Se o conteúdo mudou enquanto o chaveiro gravava, preservamos a edição nova no composer.
      if (stashContentRef.current === savedSnapshot) {
        historyDraft.current = null;
        setHistoryIndex(null);
        setText("");
        attachments.clear();
        if (quoteKey) clearQuotesFor(quoteKey);
      }
      setStashMenuOpen(false);
      setStashStatus(t("chat.stash.saved"));
    } catch (error) {
      const detail = String(error);
      setStashStatus(detail.includes("Já há 10 rascunhos")
        ? t("chat.stash.limit", { count: MAX_PROMPT_STASHES })
        : t("chat.stash.saveFailed"));
      if (detail.includes("Já há 10 rascunhos")) {
        try { await loadPromptStashes(); } catch { /* Mantém o índice que já está em memória. */ }
        setStashMenuOpen(true);
      }
    } finally {
      setStashBusy(false);
    }
  };
  const normalizedWorkspace = (path: string | null) => {
    const normalized = path?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
    return normalized || null;
  };
  const workspaceLabel = (path: string | null) => {
    const normalized = normalizedWorkspace(path);
    if (!normalized) return t("chat.stash.noProject");
    const parts = normalized.split("/").filter(Boolean);
    return parts.slice(-3).join("/") || normalized;
  };
  const restoreLoadedPrompt = async (stash: PromptStash) => {
    if (stashRestoringRef.current) return;
    if (attachments.isIngestingAttachments()) {
      setStashStatus(t("chat.stash.attachmentsPending"));
      return;
    }
    if ((ref.current?.value ?? text).trim() || attachments.list.length > 0 || quotesRef.current.length > 0) {
      setStashStatus(t("chat.stash.composerChanged"));
      return;
    }
    const startingText = ref.current?.value ?? text;
    const startingQuotes = JSON.stringify(quotesRef.current.map(({ text: quoteText, comment, originItemId }) => ({ text: quoteText, comment, originItemId })));
    const composerStillUnchanged = () =>
      (ref.current?.value ?? text) === startingText
      && JSON.stringify(quotesRef.current.map(({ text: quoteText, comment, originItemId }) => ({ text: quoteText, comment, originItemId }))) === startingQuotes;
    if (!composerStillUnchanged()) {
      setStashStatus(t("chat.stash.composerChanged"));
      return;
    }

    stashRestoringRef.current = true;
    setStashRestoring(true);
    try {
      const attachmentsAccepted = await attachments.addPaths(stash.attachmentPaths);
      if (!composerStillUnchanged()) {
        for (const path of stash.attachmentPaths) attachments.remove(path);
        setStashStatus(t("chat.stash.composerChanged"));
        return;
      }
      historyDraft.current = null;
      setHistoryIndex(null);
      const restoredQuotes = stash.quotes.map(({ text: quoteText, comment, originItemId }) => ({
        text: quoteText,
        comment,
        originItemId: stash.quoteKey === quoteKey ? originItemId : undefined,
      }));
      const restoredText = quoteKey ? stash.text : withQuotes(stash.text, restoredQuotes);
      setComposerText(restoredText, restoredText.length);
      if (quoteKey) {
        for (const quote of restoredQuotes) addQuoteFor(quoteKey, quote);
      }
      setPendingCrossProjectStash(null);
      setStashMenuOpen(false);
      setStashStatus(attachmentsAccepted ? t("chat.stash.restored") : t("chat.stash.restoredAttachmentsWarning"));
      ref.current?.focus();
    } finally {
      stashRestoringRef.current = false;
      setStashRestoring(false);
    }
  };
  const restorePrompt = async (id: string) => {
    if (hasStashContent || editingQueueId || stashBusy) return;
    if (attachments.isIngestingAttachments()) {
      setStashStatus(t("chat.stash.attachmentsPending"));
      return;
    }
    setStashStatus("");
    const startingContent = stashContentRef.current;
    setStashBusy(true);
    try {
      const stash = await getPromptStash(id);
      if (!stash) {
        setStashStatus(t("chat.stash.restoreFailed"));
        return;
      }
      if (stashContentRef.current !== startingContent || (ref.current?.value ?? text) !== text) {
        setStashStatus(t("chat.stash.composerChanged"));
        return;
      }
      if (normalizedWorkspace(stash.cwd) !== normalizedWorkspace(cwd)) {
        setPendingCrossProjectStash(stash);
        setStashMenuOpen(true);
        setStashStatus(t("chat.stash.otherProject"));
        return;
      }
      await restoreLoadedPrompt(stash);
    } catch {
      setStashStatus(t("chat.stash.restoreFailed"));
    } finally {
      setStashBusy(false);
    }
  };
  const restoreCrossProjectPrompt = async () => {
    const stash = pendingCrossProjectStash;
    if (!stash || stashBusy) return;
    setStashStatus("");
    setStashBusy(true);
    try {
      await restoreLoadedPrompt(stash);
    } catch {
      setStashStatus(t("chat.stash.restoreFailed"));
    } finally {
      setStashBusy(false);
    }
  };
  const runPromptStashAction = () => {
    if (editingQueueId) return;
    if (hasStashContent) {
      void saveCurrentPrompt();
      return;
    }
    if (stashes.length === 1) {
      void restorePrompt(stashes[0]!.id);
      return;
    }
    if (stashes.length > 1) setStashMenuOpen((open) => !open);
  };
  useEffect(() => {
    if (!stashMenuOpen) return;
    if (stashes.length === 0) setStashMenuOpen(false);
  }, [stashMenuOpen, stashes.length]);
  useEffect(() => {
    let active = true;
    void loadPromptStashes().catch(() => {
      if (active) setStashStatus(tRef.current("chat.stash.loadFailed"));
    });
    return () => { active = false; };
  }, []);
  const deleteStash = async (id: string) => {
    if (stashBusy) return;
    setStashBusy(true);
    try {
      await removePromptStash(id);
      setStashStatus(t("chat.stash.removed"));
    } catch (error) {
      try { await loadPromptStashes(); } catch { /* Mantém o índice em memória. */ }
      setStashStatus(String(error).includes("foi ocultado")
        ? t("chat.stash.removePending")
        : t("chat.stash.removeFailed"));
    } finally {
      setStashBusy(false);
    }
  };
  const extras = attachments.list.length + quotes.length;
  const controlsContent = typeof controls === "function" ? controls({ text, hasExtraContext: extras > 0, attachments: attachments.list, hasQuotes: quotes.length > 0 }) : controls;
  const canSend = canSubmit(text, extras, disabled || !!editingQueueId || stashRestoring, busy);
  const stopping = !editingQueueId && !stashRestoring && !!onStop && text.trim().length === 0 && extras === 0;
  // O que se solta na janela chega aqui (o ouvinte nativo está no ChatShell).
  useEffect(() => registerDropSink({ addPaths: (paths) => {
    if (stashRestoringRef.current) { setStashStatus(t("chat.stash.retryAttachment")); return; }
    void attachments.addPaths(paths);
  } }), [attachments.addPaths, t]);

  // O que o painel manda para a conversa (a captura de um aparelho) entra no fim do texto.
  const insertQueue = useChatStore((s) => s.composerInsertQueue);
  useEffect(() => {
    const hasMatching = insertQueue.some((event) => event.target == null || event.target === eventTarget);
    if (stashRestoringRef.current) {
      if (hasMatching) deferredComposerActionRef.current = true;
      return;
    }
    const pending = takeComposerInserts(eventTarget);
    if (pending.length === 0) return;
    setText((prev) => pending.reduce((value, event) => appendMention(value, event.text), prev));
    ref.current?.focus();
    if (deferredComposerActionRef.current) {
      deferredComposerActionRef.current = false;
      const message = t("chat.stash.deferredComposerAction");
      setStashStatus((previous) => previous ? `${previous} ${message}` : message);
    }
  }, [insertQueue, eventTarget, stashRestoring, t]);

  // Capturas de vídeo entram como anexos locais e ficam para revisão antes do envio.
  const attachQueue = useChatStore((s) => s.composerAttachQueue);
  useEffect(() => {
    const pending = attachQueue.filter((event) => event.target == null || event.target === eventTarget);
    if (stashRestoringRef.current) {
      if (pending.length > 0) deferredComposerActionRef.current = true;
      return;
    }
    for (const event of pending) {
      if (processingAttachSeqsRef.current.has(event.seq)) continue;
      processingAttachSeqsRef.current.add(event.seq);
      void attachments.addPaths(event.paths).finally(() => {
        processingAttachSeqsRef.current.delete(event.seq);
        if (!composerMountedRef.current) return;
        acknowledgeComposerAttachments([event.seq]);
        ref.current?.focus();
        if (deferredComposerActionRef.current) {
          deferredComposerActionRef.current = false;
          const message = t("chat.stash.deferredComposerAction");
          setStashStatus((previous) => previous ? `${previous} ${message}` : message);
        }
      });
    }
  }, [attachQueue, attachments.addPaths, eventTarget, stashRestoring, t]);

  // O bloco cresce com o texto e com as miniaturas até 40% da janela; a caixa tem a altura do texto todo
  // e quem rola é o miolo (`scroller`), de modo que o enviar não sai da tela.
  const scroller = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState(() => composerMaxHeight(window.innerHeight));
  useEffect(() => {
    const onResize = () => setMaxHeight(composerMaxHeight(window.innerHeight));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // A altura segue o texto: a cada mudança do texto e também quando a largura da caixa muda (o painel
  // direito abre, a janela redimensiona, o composer sai de um espaço sem largura): o texto quebra de outro
  // jeito e a altura de antes ficaria curta ou sobrando.
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    // Escrevendo no fim, o cursor acompanha o texto que desce.
    if (scroller.current && el.selectionStart === el.value.length) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, []);
  useLayoutEffect(fit, [fit, text, extras]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth === width) return;
      width = el.offsetWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  const queue = (): boolean => {
    if (submitInFlightRef.current || stashRestoringRef.current || editingQueueId || !onQueue || !canSubmit(text, extras, disabled, false)) return false;
    if (onQueue(withQuotes(text, quotes), attachments.list) === false) return false;
    historyDraft.current = null;
    setHistoryIndex(null);
    setText("");
    attachments.clear();
    if (quoteKey) clearQuotesFor(quoteKey);
    return true;
  };

  const enterQueues = turnActive && !forceSend && followUpBehavior === "queue" && !!onQueue;
  const submitForEnter = () => enterQueues ? queue() : void submit();
  const submitForModifiedEnter = () => {
    if (!turnActive && onBackgroundSubmit) { void submit(true); return; }
    if (!turnActive && onQueue) { queue(); return; }
    if (turnActive && !forceSend && !enterQueues && onQueue) { queue(); return; }
    if (turnActive && !forceSend && enterQueues) { void submit(); return; }
    if (onQueue) { queue(); return; }
    void submit();
  };

  const submit = async (background = false) => {
    if (submitInFlightRef.current || editingQueueId || !canSend) return false;
    submitInFlightRef.current = true;
    setBusy(true);
    try {
      // As citações vão depois do texto (o `@agente` do começo continua valendo) e antes dos anexos.
      const send = background && onBackgroundSubmit ? onBackgroundSubmit : onSubmit;
      if ((await send(withQuotes(text, quotes), attachments.list)) === false) return false;
      historyDraft.current = null;
      setHistoryIndex(null);
      setText("");
      attachments.clear();
      if (quoteKey) clearQuotesFor(quoteKey);
      return true;
    } catch {
      /* quem envia mostra o erro; o texto fica para tentar de novo */
      return false;
    } finally {
      submitInFlightRef.current = false;
      setBusy(false);
    }
  };

  const sendAndNewThread = async () => {
    if (!onSendAndNewThread || forceSend || !canSend) return;
    if (await submit()) onSendAndNewThread();
  };
  const sendAlternate = () => {
    if (!turnActive || forceSend || !onQueue || !canSend) return;
    submitForModifiedEnter();
  };
  const sendBackground = () => {
    if (turnActive || forceSend || !onBackgroundSubmit || !canSend) return;
    void submit(true);
  };

  const sendAlternateAvailable = Boolean(eventTarget && turnActive && !forceSend && onQueue && canSend);
  const sendBackgroundAvailable = Boolean(eventTarget && !turnActive && !forceSend && onBackgroundSubmit && canSend);
  const sendAndNewThreadAvailable = Boolean(eventTarget && onSendAndNewThread && !forceSend && canSend);

  const attach = async () => {
    if (stashRestoringRef.current || attachDialogOpenRef.current) return;
    attachDialogOpenRef.current = true;
    try {
      const picked = await openDialog({ multiple: true, directory: false, defaultPath: cwd ?? undefined, title: t("chat.composer.attach") });
      const files = typeof picked === "string" ? [picked] : picked ?? [];
      if (files.length === 0) return;
      // A mesma regra de soltar: viram miniaturas, com os mesmos limites.
      if (stashRestoringRef.current) {
        setStashStatus(t("chat.stash.retryAttachment"));
        return;
      }
      await attachments.addPaths(files);
      ref.current?.focus();
    } finally {
      attachDialogOpenRef.current = false;
    }
  };
  const attachRef = useRef(attach);
  attachRef.current = attach;
  useEffect(() => {
    if (!eventTarget) return;
    const onFilePickerCommand = (event: Event) => {
      const detail = (event as CustomEvent<FilePickerCommandDetail>).detail;
      if (detail?.target !== eventTarget || disabled) return;
      event.stopImmediatePropagation();
      void attachRef.current();
    };
    window.addEventListener(FILE_PICKER_COMMAND_EVENT, onFilePickerCommand);
    return () => window.removeEventListener(FILE_PICKER_COMMAND_EVENT, onFilePickerCommand);
  }, [disabled, eventTarget]);

  const composerCommandRef = useRef<(command: ComposerCommandDetail["command"]) => void>(() => undefined);
  composerCommandRef.current = (command) => {
    if (command === "sendAlternate") sendAlternate();
    else if (command === "sendBackground") sendBackground();
    else if (command === "sendAndNewThread") void sendAndNewThread();
  };
  useEffect(() => {
    if (!eventTarget) return;
    const onComposerCommand = (event: Event) => {
      const detail = (event as CustomEvent<ComposerCommandDetail>).detail;
      if (detail?.target !== eventTarget) return;
      const available = detail.command === "sendAlternate" ? sendAlternateAvailable
        : detail.command === "sendBackground" ? sendBackgroundAvailable
          : detail.command === "sendAndNewThread" ? sendAndNewThreadAvailable : false;
      if (!available) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      composerCommandRef.current(detail.command);
    };
    window.addEventListener(COMPOSER_COMMAND_EVENT, onComposerCommand);
    return () => window.removeEventListener(COMPOSER_COMMAND_EVENT, onComposerCommand);
  }, [eventTarget, sendAlternateAvailable, sendBackgroundAvailable, sendAndNewThreadAvailable]);

  const editQueued = (id: string) => {
    const item = waiting.find((queued) => queued.id === id);
    if (!item) return;
    queuedDraft.current = { id, text, caret: ref.current?.selectionStart ?? text.length };
    historyDraft.current = null;
    setHistoryIndex(null);
    setEditingQueueId(id);
    apply(item.text, item.text.length);
    ref.current?.focus();
  };

  const restoreQueuedDraft = (draft: { text: string; caret: number } | null, editedText: string) => {
    const restored = draft?.text.trim() ? draft.text : editedText;
    apply(restored, draft?.text.trim() ? Math.min(draft.caret, restored.length) : restored.length);
  };

  const cancelQueuedEdit = () => {
    const original = queuedDraft.current;
    queuedDraft.current = null;
    setEditingQueueId(null);
    restoreQueuedDraft(original, "");
  };

  const saveQueuedEdit = (id: string) => {
    if (editingQueueId !== id || !text.trim()) return;
    const original = queuedDraft.current;
    if (onUpdateQueued?.(id, text)) {
      queuedDraft.current = null;
      setEditingQueueId(null);
      restoreQueuedDraft(original, "");
      return;
    }
    // A mensagem pode ter começado a ser enviada enquanto a pessoa editava. Não descarta o texto alterado.
    queuedDraft.current = null;
    setEditingQueueId(null);
    restoreQueuedDraft(original, text);
  };

  // Se o runner consumir a mensagem durante a edição, devolve o texto editado ao composer vazio.
  useEffect(() => {
    if (!editingQueueId || waiting.some((item) => item.id === editingQueueId)) return;
    const original = queuedDraft.current;
    queuedDraft.current = null;
    setEditingQueueId(null);
    restoreQueuedDraft(original, text);
  }, [editingQueueId, waiting, text]);

  return (
    <>
    {onUnqueue && onUpdateQueued && <QueueList items={waiting} editingId={editingQueueId} canSave={!!text.trim()}
      onEdit={editQueued} onSave={saveQueuedEdit} onCancel={cancelQueuedEdit} onRemove={(id) => { onUnqueue(id); }} />}
    <form ref={formRef}
      onSubmit={(e) => { e.preventDefault(); submitForEnter(); }}
      className="relative w-full rounded-[20px] border border-black/[0.10] dark:border-white/[0.10]
        bg-white dark:bg-surface-raised
        shadow-[0_1px_3px_rgba(0,0,0,0.06)] dark:shadow-none"
    >
      {stashMenuOpen && stashes.length > 0 && (
        <div role="menu" aria-label={t("chat.stash.menuTitle")}
          className="absolute bottom-full left-3 z-30 mb-2 w-[min(420px,calc(100vw-2rem))] max-h-72 overflow-y-auto rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-white dark:bg-surface-raised shadow-xl">
          <div className="sticky top-0 flex items-start justify-between gap-3 px-3 py-2.5 border-b border-black/[0.07] dark:border-white/[0.08] bg-white dark:bg-surface-raised">
            <div className="min-w-0">
              <p className="m-0 text-chat-note font-medium">{t("chat.stash.menuTitle")}</p>
              <p className="m-0 mt-0.5 text-chat-caption text-gray-500 dark:text-white/45">{t("chat.stash.sessionHint")}</p>
            </div>
            <button type="button" onClick={() => setStashMenuOpen(false)} aria-label={t("chat.stash.close")}
              className="w-6 h-6 shrink-0 rounded-md flex items-center justify-center text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/10">
              <XIcon className="w-3.5 h-3.5" />
            </button>
          </div>
          {pendingCrossProjectStash && (
            <div role="alert" className="mx-2 mt-2 rounded-lg border border-amber-500/30 bg-amber-50 dark:bg-amber-950/25 px-3 py-2.5">
              <p className="m-0 text-chat-note text-amber-900 dark:text-amber-100">{t("chat.stash.otherProject")}</p>
              <p className="m-0 mt-1 text-chat-caption text-amber-800 dark:text-amber-200/80">
                {t("chat.stash.workspacePair", { source: workspaceLabel(pendingCrossProjectStash.cwd), destination: workspaceLabel(cwd) })}
              </p>
              <div className="mt-2 flex items-center justify-end gap-2">
                <button type="button" onClick={() => { setPendingCrossProjectStash(null); setStashStatus(""); }} disabled={stashBusy}
                  className="px-2.5 py-1 rounded-md text-chat-caption text-gray-600 dark:text-white/60 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40">
                  {t("chat.stash.cancelRestore")}
                </button>
                <button type="button" onClick={() => { void restoreCrossProjectPrompt(); }} disabled={stashBusy || hasStashContent || attachments.ingesting}
                  className="px-2.5 py-1 rounded-md text-chat-caption font-medium bg-accent-600 text-white hover:bg-accent-700 disabled:opacity-40">
                  {t("chat.stash.restoreHere")}
                </button>
              </div>
            </div>
          )}
          <ul className="list-none m-0 p-1.5 flex flex-col gap-1">
            {stashes.map((stash) => {
              const title = t("chat.stash.itemTitle", { date: new Date(stash.savedAt).toLocaleString() });
              return (
                <li key={stash.id} className="flex items-center gap-1 rounded-lg hover:bg-gray-100 dark:hover:bg-white/[0.07]">
                  <button type="button" role="menuitem" onClick={() => { void restorePrompt(stash.id); }} title={title}
                    disabled={hasStashContent || attachments.ingesting || editingQueueId !== null || stashBusy || pendingCrossProjectStash !== null}
                    className="min-w-0 flex-1 px-2.5 py-2 text-left">
                    <span className="block truncate text-chat-note font-medium text-gray-800 dark:text-gray-100">{title}</span>
                    <span className="block truncate text-chat-caption text-gray-500 dark:text-white/45">
                      {t("chat.stash.meta", { attachments: stash.attachmentCount, quotes: stash.quoteCount })}
                    </span>
                  </button>
                  <button type="button" onClick={() => { void deleteStash(stash.id); }} disabled={stashBusy || pendingCrossProjectStash !== null}
                    aria-label={t("chat.stash.removeItem", { prompt: title })} title={t("chat.stash.remove")}
                    className="w-7 h-7 mr-1 shrink-0 rounded-md flex items-center justify-center text-gray-500 dark:text-white/50 hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-40">
                    <XIcon className="w-3.5 h-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {stashStatus && <p className="mx-4 mb-2 text-chat-caption text-gray-500 dark:text-white/50" role="status" aria-live="polite">{stashStatus}</p>}
      {addon?.({ text, caret, apply, addPaths: async (paths) => {
        if (stashRestoringRef.current) { setStashStatus(t("chat.stash.retryAttachment")); return false; }
        return attachments.addPaths(paths);
      }, registerKeyHandler })}
      <div ref={scroller} style={{ maxHeight }} className="cc-scroll-hidden">
        <QuoteCards items={quoteCards} onRemove={(id) => { if (!stashRestoringRef.current && quoteKey) removeQuoteFor(quoteKey, id); }} onNavigate={navigateToQuoteSource} className="px-4 pt-3.5" />
        <AttachmentStrip items={attachments.list} onRemove={stashRestoring ? undefined : attachments.remove} cwd={cwd} className={`px-4 ${quotes.length > 0 ? "pt-2" : "pt-3.5"}`} />
        {attachments.notices.length > 0 && (
          <ul role="status" className="list-none m-0 px-5 pt-2 flex flex-col gap-0.5 text-chat-caption text-amber-700 dark:text-amber-400">
            {attachments.notices.map((n) => <li key={n}>{n}</li>)}
          </ul>
        )}
      <label className={`block px-5 pb-2 ${extras > 0 ? "pt-3" : "pt-4"}`}>
        <span className="sr-only">{t("chat.composer.label")}</span>
        <textarea ref={ref} rows={1} value={text} autoFocus={autoFocus} data-chat-composer="" data-chat-composer-target={eventTarget ?? undefined}
          data-chat-composer-send-alternate={sendAlternateAvailable ? "true" : undefined}
          data-chat-composer-send-background={sendBackgroundAvailable ? "true" : undefined}
          data-chat-composer-send-and-new-thread={sendAndNewThreadAvailable ? "true" : undefined}
          disabled={disabled || stashRestoring}
          onPaste={(event) => { if (stashRestoringRef.current) { event.preventDefault(); setStashStatus(t("chat.stash.retryAttachment")); return; } attachments.onPaste(event); }}
          onChange={(e) => {
            if (stashRestoringRef.current) return;
            historyDraft.current = null;
            setHistoryIndex(null);
            setText(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
              e.preventDefault();
              e.stopPropagation();
              runPromptStashAction();
              return;
            }
            if (stashMenuOpen && e.key === "Escape") {
              e.preventDefault();
              setStashMenuOpen(false);
              return;
            }
            if (addonKeyHandler.current?.(e)) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            if (editingQueueId && e.key === "Escape") {
              e.preventDefault();
              cancelQueuedEdit();
              return;
            }
            if (editingQueueId && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (e.metaKey || e.ctrlKey) saveQueuedEdit(editingQueueId);
              return;
            }
            if (!editingQueueId && e.altKey && e.key === "ArrowUp" && waiting.length > 0) {
              const newest = waiting.reduce((latest, item) => {
                const sequence = Number(/^q(\d+)$/.exec(item.id)?.[1]);
                const latestSequence = Number(/^q(\d+)$/.exec(latest.id)?.[1]);
                return Number.isFinite(sequence) && Number.isFinite(latestSequence) && sequence > latestSequence ? item : latest;
              });
              e.preventDefault();
              editQueued(newest.id);
              return;
            }
            const collapsed = e.currentTarget.selectionStart === e.currentTarget.selectionEnd;
            if (collapsed && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && extras === 0) {
              if (e.key === "ArrowUp" && !e.currentTarget.value.slice(0, e.currentTarget.selectionStart).includes("\n") && browseHistory(-1)) {
                e.preventDefault();
                return;
              }
              if (e.key === "ArrowDown" && !e.currentTarget.value.slice(e.currentTarget.selectionEnd).includes("\n") && browseHistory(1)) {
                e.preventDefault();
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (e.metaKey || e.ctrlKey) {
                if (!e.altKey) submitForModifiedEnter();
              } else submitForEnter();
            }
          }}
          placeholder={placeholder}
          className="block w-full resize-none bg-transparent outline-none text-chat-prose
            text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-white/35" />
      </label>
      </div>
      {/*
        A linha de baixo fica numa linha só: o grupo da esquerda (anexar, "Time | Só o orquestrador") não encolhe, e
        o da direita encolhe por dentro (o nome do modelo trunca; com a coluna estreita, os rótulos viram ícones com
        tooltip, ver `ComposerColumn`). Só numa coluna muito estreita (< 28rem) ela volta a quebrar, para nada passar
        da borda do cartão. O enviar é sempre o último, no canto.
      */}
      <div data-composer-row className="flex flex-nowrap @max-[28rem]/composer:flex-wrap items-center gap-x-1 gap-y-1 px-3 pb-2.5">
        <div data-composer-left className="flex shrink-0 items-center gap-0.5">
        <button type="button" onClick={() => { void attach(); }} aria-label={t("chat.composer.attach")} title={t("chat.composer.attach")} disabled={disabled || stashRestoring}
          className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white">
          <PaperclipIcon className="w-4 h-4" />
        </button>
        <button type="button" data-chat-prompt-stash="" onClick={() => {
          if (hasStashContent) void saveCurrentPrompt();
          else if (stashes.length > 0) setStashMenuOpen((open) => !open);
        }}
          disabled={editingQueueId !== null || stashBusy || attachments.ingesting || (!hasStashContent && (!stashLoaded || stashes.length === 0))}
          aria-label={t(hasStashContent ? "chat.stash.save" : stashes.length > 0 ? "chat.stash.open" : "chat.stash.restore")}
          aria-haspopup="menu" aria-expanded={stashMenuOpen}
          title={`${t(hasStashContent ? "chat.stash.save" : stashes.length > 0 ? "chat.stash.open" : "chat.stash.restore")} · ⌘/Ctrl+S · ${t("chat.stash.sessionHint")}`}
          className="relative w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white disabled:opacity-35 disabled:hover:bg-transparent">
          <ArchiveIcon className="w-4 h-4" />
          {stashes.length > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-0.5 rounded-full flex items-center justify-center bg-accent-600 text-[9px] leading-none font-semibold text-white">{stashes.length}</span>}
        </button>
        <DesktopSnapshotButton target={eventTarget} disabled={stashRestoring} className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white disabled:opacity-40" />
        <ScreenRecordButton kind="desktop" target="main-display" composerTarget={eventTarget} label={t("screenRecording.display")} disabled={stashRestoring} className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white" />
        <VoiceInputButton onTranscript={insertTranscript} isComposerActive={isComposerActive} disabled={disabled || stashRestoring} className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white disabled:opacity-40" />
        {leading}
        </div>
        <div data-composer-right className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-0.5">
        <div data-composer-controls className="flex min-w-0 flex-nowrap items-center justify-end gap-x-0.5">{controlsContent}</div>
        {stopping ? (
          <button type="button" onClick={() => onStop?.()} aria-label={t("chat.composer.stop")} title={t("chat.composer.stop")}
            className="ml-1 w-8 h-8 shrink-0 rounded-full flex items-center justify-center bg-red-600/90 text-white hover:bg-red-600">
            <StopIcon className="w-2.5 h-2.5" />
          </button>
        ) : (
          <button type="submit" disabled={!canSend} aria-label={enterQueues ? t("chat.composer.queueAction") : t("chat.composer.send")} title={enterQueues ? t("chat.composer.queueAction") : onBackgroundSubmit ? `${t("chat.composer.send")} · ${t("chat.composer.sendBackgroundShortcut")}` : t("chat.composer.send")}
            className={`ml-1 w-8 h-8 shrink-0 rounded-full flex items-center justify-center transition-transform
              ${canSend ? "bg-accent-600 text-white hover:scale-105" : "bg-gray-900/12 dark:bg-white/12 text-white dark:text-surface-deep cursor-default"}`}>
            <ArrowUpIcon className="w-3.5 h-3.5" />
          </button>
        )}
        </div>
      </div>
    </form>
    </>
  );
}
