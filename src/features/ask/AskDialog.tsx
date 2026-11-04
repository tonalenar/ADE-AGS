import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";
import { agentPaint } from "@/features/browser/agentPaint";
import { useAskStore, type AskReview, type UserQuestion } from "./askStore";

/** `2:05` — lo que queda antes de que la pregunta se venza sola. */
function left(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Lo que un agente pregunta cuando no lo puede averiguar leyendo.
 *
 * De a una: con varios agentes corriendo, dos diálogos encima no se pueden contestar, y el
 * que quedó atrás no se ve. Las demás esperan su turno — igual están bloqueadas del otro
 * lado, así que la cola es real, no una simplificación.
 *
 * Cerrar es una respuesta válida ("no te contesto"), y el agente lo recibe como tal: dejarlo
 * esperando media hora a algo que la persona ya decidió no contestar es peor.
 */
export function AskDialog() {
  const { t } = useTranslation();
  const question = useAskStore((s) => s.questions[0]);
  const answer = useAskStore((s) => s.answer);
  const [text, setText] = useState("");
  const [now, setNow] = useState(() => Date.now());

  // Cada pregunta arranca limpia: lo tipeado para la anterior no es una respuesta a esta,
  // y el reloj tiene que contar desde AHORA (el estado venía de cuando se montó el shell).
  useEffect(() => {
    setText("");
    setNow(Date.now());
  }, [question?.id]);

  useEffect(() => {
    if (!question) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [question]);

  if (!question) return null;
  const paint = agentPaint(question.fromId);
  const remaining = question.expiresAt - now;
  const free = question.options.length === 0;
  if (question.review && question.options.length >= 2) {
    return <ReviewDialog question={question} review={question.review} remaining={remaining} answer={answer} />;
  }

  return (
    <AppDialog
      title={t("ask.title", { agent: question.from })}
      size="sm"
      onClose={() => answer(question.id, null)}
      closeOnEsc
      footer={
        <>
          <Button variant="outline" onClick={() => answer(question.id, null)}>
            {t("ask.skip")}
          </Button>
          {free && (
            <Button variant="primary" disabled={!text.trim()} onClick={() => answer(question.id, text.trim())}>
              {t("ask.send")}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* La pregunta la escribió un agente: va como cita, no como texto de la app. La
            barrita es del color de quien pregunta, el mismo de su tab. */}
        <div className={`flex gap-2.5 px-3 py-2.5 rounded-lg ${paint.tint}`}>
          <span className={`w-[3px] shrink-0 rounded-full ${paint.strip}`} />
          <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-gray-800 dark:text-gray-200">
            {question.question}
          </p>
        </div>

        {free ? (
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && text.trim()) answer(question.id, text.trim());
            }}
            placeholder={question.placeholder || t("ask.placeholder")}
            variant="outline"
            autoFocus
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            {question.options.map((option) => (
              <Button variant="custom"
                key={option}
                onClick={() => answer(question.id, option)}
                className="cc-t text-left px-3 py-2 rounded-lg text-[12.5px]
                  border border-gray-200 dark:border-white/10
                  text-gray-800 dark:text-gray-200
                  hover:bg-gray-100 dark:hover:bg-white/8
                  hover:border-gray-300 dark:hover:border-white/20 inline-block"
              >
                {option}
              </Button>
            ))}
          </div>
        )}

        <p className="text-[11px] text-gray-400 dark:text-white/35">
          {question.late ? t("ask.late") : t("ask.waiting", { time: left(remaining) })}
        </p>
      </div>
    </AppDialog>
  );
}

/**
 * A confirmação de uma ação do JEV num aparelho: a foto com o ponto do toque, a ação em destaque e
 * botões de verdade. As opções vêm do backend em ordem fixa: autorizar, [sempre], recusar. O texto
 * do botão é traduzido aqui; a resposta é a opção original, que é o que o backend compara.
 * Fechar ou Esc = recusar: um "não respondi" deixaria o agente achando que houve falha.
 */
function ReviewDialog({ question, review, remaining, answer }: {
  question: UserQuestion;
  review: AskReview;
  remaining: number;
  answer: (id: string, answer: string | null) => void;
}) {
  const { t } = useTranslation();
  const paint = agentPaint(question.fromId);
  const options = question.options;
  const allow = options[0];
  const deny = options[options.length - 1];
  const always = options.length >= 3 ? options[1] : undefined;
  const reply = (option: string) => answer(question.id, option);

  return (
    <AppDialog
      title={t(`ask.review.title.${review.surface}`)}
      size="md"
      onClose={() => reply(deny)}
      closeOnEsc
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2 [&>button]:whitespace-nowrap">
          <Button variant="outline" onClick={() => reply(deny)}>{t("ask.review.deny")}</Button>
          {always && <Button variant="outline" onClick={() => reply(always)}>{t("ask.review.always")}</Button>}
          <Button variant="primary" autoFocus onClick={() => reply(allow)}>{t("ask.review.allow")}</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[12px] text-gray-500 dark:text-white/50">
          <span className={`h-2 w-2 shrink-0 rounded-full ${paint.strip}`} />
          <span className={`font-medium ${paint.ink}`}>{question.from}</span>
          <span>{t("ask.review.wants")}</span>
        </div>
        <p className="text-[15px] font-medium leading-snug text-gray-900 dark:text-white">{review.action}</p>

        {review.image && (
          <div className="flex justify-center rounded-lg bg-gray-100 p-2 dark:bg-white/[0.04]">
            <div className="relative inline-block">
              <img
                src={review.image}
                alt={t("ask.review.photo")}
                draggable={false}
                className="block max-h-[340px] w-auto rounded-md border border-gray-200 dark:border-white/10"
              />
              {review.point && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-accent-500 bg-accent-500/25 ring-4 ring-white/90 animate-pulse"
                  style={{ left: `${review.point[0] * 100}%`, top: `${review.point[1] * 100}%` }}
                />
              )}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-1 text-[12px] leading-relaxed text-gray-500 dark:text-white/50">
          <p>{t("ask.review.why")}</p>
          {always && <p>{t("ask.review.alwaysHint")}</p>}
          <p className="tabular-nums text-gray-400 dark:text-white/35">
            {question.late ? t("ask.late") : t("ask.review.left", { time: left(remaining) })}
          </p>
        </div>
      </div>
    </AppDialog>
  );
}
