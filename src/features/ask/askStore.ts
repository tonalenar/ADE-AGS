import { create } from "zustand";

/**
 * Las preguntas que un agente le está haciendo al usuario ahora mismo.
 *
 * Una pregunta no se guarda en la base: vale mientras el agente está del otro lado
 * esperándola. Si la app se cierra, el agente se entera por su lado (se le vence el pedido)
 * y una pregunta resucitada al reabrir sería una que ya no contesta nadie.
 */
/** O que o JEV quer fazer num aparelho, para o diálogo mostrar a foto em vez de um caminho. */
export interface AskReview {
  surface: "ios" | "mac";
  action: string;
  /** URL de dados da foto (já reduzida); ausente quando não deu para ler. */
  image?: string;
  /** O ponto do toque, em proporção da foto (0 a 1). */
  point?: [number, number];
}

const inUnit = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

/** Lê a `review` que vem do backend. Qualquer coisa fora do formato vira `undefined`, e o diálogo cai no texto. */
export function parseReview(raw: unknown): AskReview | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "computer_use" || (r.surface !== "ios" && r.surface !== "mac")) return undefined;
  if (typeof r.action !== "string" || !r.action.trim()) return undefined;
  const image = typeof r.image === "string" && r.image.startsWith("data:image/") ? r.image : undefined;
  const p = r.point;
  const point = Array.isArray(p) && p.length === 2 && inUnit(p[0]) && inUnit(p[1]) ? ([p[0], p[1]] as [number, number]) : undefined;
  return { surface: r.surface, action: r.action.trim(), image, point };
}

export interface UserQuestion {
  id: string;
  question: string;
  /** Vacío = respuesta libre. Si no, un botón por opción. */
  options: string[];
  placeholder?: string;
  /** Quién pregunta, con el nombre que la interfaz ya le da. */
  from: string;
  /** Su id: de ahí sale el color, el MISMO que el de su tab y el de su navegador. Del
   *  nombre saldría otro, y el color dejaría de servir para saber quién es. */
  fromId: string;
  /** Cuándo vence, para que la tarjeta no prometa una espera infinita. */
  expiresAt: number;
  /** Venceu o prazo: o agente já recebeu `pending` e seguiu. A resposta, se vier, vira mensagem. */
  late?: boolean;
  /** Confirmação de uma ação do JEV: o diálogo mostra a foto, o ponto e botões de verdade. */
  review?: AskReview;
  /** O campo é `password` e a resposta segue pelo canal de segredo, nunca pelo transcript. */
  secret?: boolean;
  resolve: (answer: string | null) => void;
}

interface AskState {
  questions: UserQuestion[];
  add: (q: UserQuestion) => void;
  /** Contesta una y la saca. `null` = la cerró sin contestar. */
  answer: (id: string, answer: string | null) => void;
  /** Vence o prazo sem tirar a pergunta da tela: quem responder depois chama `deliver`. */
  expire: (id: string, deliver: (answer: string) => void) => void;
  /** Tira a pergunta da tela SEM responder: o prazo venceu e quem perguntou já recebeu `pending`.
   *  `answer(id, null)` aqui viraria "o usuário não respondeu", que do outro lado é erro. */
  drop: (id: string) => void;
}

export const useAskStore = create<AskState>((set, get) => ({
  questions: [],
  add: (q) => set((s) => ({ questions: [...s.questions, q] })),
  answer: (id, answer) => {
    const q = get().questions.find((x) => x.id === id);
    if (!q) return;
    set((s) => ({ questions: s.questions.filter((x) => x.id !== id) }));
    q.resolve(answer);
  },
  drop: (id) => set((s) => ({ questions: s.questions.filter((x) => x.id !== id) })),
  expire: (id, deliver) =>
    set((s) => ({
      questions: s.questions.map((q) =>
        q.id === id ? { ...q, late: true, resolve: (answer) => { if (answer !== null) deliver(answer); } } : q,
      ),
    })),
}));
