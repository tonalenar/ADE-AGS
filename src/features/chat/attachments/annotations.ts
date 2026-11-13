import type { MarkPoint } from "./mediaViewerModel";

/** As ferramentas de marcação do visualizador (como no recorte do Windows). */
export type AnnotationTool = "pen" | "highlighter" | "arrow" | "rect" | "ellipse" | "text" | "step" | "blur" | "eraser";

/** As cores da paleta: nomes de tokens do tema, nunca hex. */
export const ANNOTATION_COLORS = ["red-500", "orange-500", "yellow-400", "green-500", "accent-500", "white", "gray-950"] as const;
export type AnnotationColor = (typeof ANNOTATION_COLORS)[number];

/** Uma marca na imagem, em coordenadas normalizadas (0–1) da imagem. `width` também é relativo à largura. */
export type Annotation =
  | { kind: "pen" | "highlighter"; color: AnnotationColor; width: number; points: MarkPoint[] }
  | { kind: "arrow" | "rect" | "ellipse" | "blur"; color: AnnotationColor; width: number; from: MarkPoint; to: MarkPoint }
  | { kind: "text"; color: AnnotationColor; width: number; at: MarkPoint; text: string }
  | { kind: "step"; color: AnnotationColor; width: number; at: MarkPoint; n: number };

/** As marcas definidas por dois cantos (seta, retângulo, elipse, pixelar). */
export type BoxMark = Extract<Annotation, { from: MarkPoint }>;

export const colorVar = (color: AnnotationColor) => `var(--color-${color})`;

/** O próximo número da ferramenta de passos: continua de onde parou, mesmo depois de apagar o meio. */
export function nextStepNumber(marks: Annotation[]): number {
  return marks.reduce((max, mark) => (mark.kind === "step" ? Math.max(max, mark.n) : max), 0) + 1;
}

/** O nome da cópia anotada: `foto.jpg` → `foto-anotado.png` (o Rust escolhe `-2`, `-3` se já existir). */
export function annotatedName(name: string): string {
  return `${name.replace(/\.[^./\\]+$/, "")}-anotado.png`;
}

/** Retângulo normalizado a partir de dois cantos quaisquer. */
export function boxOf(from: MarkPoint, to: MarkPoint) {
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
}

/** Uma forma vazia demais (um clique sem arrastar) não vira marca. */
export function isDegenerate(mark: Annotation): boolean {
  if (mark.kind === "pen" || mark.kind === "highlighter") return mark.points.length < 2;
  if (mark.kind === "text") return mark.text.trim() === "";
  if (mark.kind === "step") return false;
  if (!("from" in mark)) return true;
  const box = boxOf(mark.from, mark.to);
  return box.width < 0.004 && box.height < 0.004;
}

function distanceToSegment(p: MarkPoint, a: MarkPoint, b: MarkPoint, aspect: number): number {
  const ax = a.x, ay = a.y * aspect, bx = b.x, by = b.y * aspect, px = p.x, py = p.y * aspect;
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Se o ponto `p` (normalizado) toca a marca. `aspect` = altura/largura da imagem, para medir em distância real. */
export function hitsAnnotation(mark: Annotation, p: MarkPoint, aspect = 1, tolerance = 0.012): boolean {
  const slack = tolerance + mark.width / 2;
  switch (mark.kind) {
    case "pen":
    case "highlighter":
      return mark.points.some((point, i) => i > 0 && distanceToSegment(p, mark.points[i - 1]!, point, aspect) <= slack) || (mark.points.length === 1 && distanceToSegment(p, mark.points[0]!, mark.points[0]!, aspect) <= slack);
    case "arrow":
      return distanceToSegment(p, mark.from, mark.to, aspect) <= slack;
    case "rect":
    case "ellipse":
    case "blur": {
      const box = boxOf(mark.from, mark.to);
      return p.x >= box.x - slack && p.x <= box.x + box.width + slack && p.y >= box.y - slack && p.y <= box.y + box.height + slack;
    }
    case "text":
      return Math.abs(p.x - mark.at.x) < 0.15 && Math.abs(p.y - mark.at.y) < 0.04;
    case "step":
      return Math.hypot(p.x - mark.at.x, (p.y - mark.at.y) * aspect) <= 0.03;
  }
}

/** A borracha apaga a marca mais de cima que o ponto toca. Devolve a lista nova e a marca apagada. */
export function eraseAt(marks: Annotation[], p: MarkPoint, aspect = 1): { marks: Annotation[]; removed: Annotation | null } {
  for (let i = marks.length - 1; i >= 0; i--) {
    if (hitsAnnotation(marks[i]!, p, aspect)) return { marks: [...marks.slice(0, i), ...marks.slice(i + 1)], removed: marks[i]! };
  }
  return { marks, removed: null };
}

/** As duas pontas da cabeça da seta, em pixels. */
export function arrowHead(from: { x: number; y: number }, to: { x: number; y: number }, size: number): [{ x: number; y: number }, { x: number; y: number }] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI / 7;
  return [
    { x: to.x - size * Math.cos(angle - spread), y: to.y - size * Math.sin(angle - spread) },
    { x: to.x - size * Math.cos(angle + spread), y: to.y - size * Math.sin(angle + spread) },
  ];
}

/** Lê um token de cor do tema para pintar no canvas. */
export function resolveColor(color: AnnotationColor): string {
  if (typeof document === "undefined") return color;
  return getComputedStyle(document.documentElement).getPropertyValue(`--color-${color}`).trim() || color;
}

/** Pinta as marcas por cima de uma imagem já desenhada no canvas (`source` é a mesma imagem, para o desfoque). */
export function paintAnnotations(context: CanvasRenderingContext2D, marks: Annotation[], width: number, height: number, source?: CanvasImageSource) {
  const px = (p: MarkPoint) => ({ x: p.x * width, y: p.y * height });
  for (const mark of marks) {
    const lineWidth = Math.max(2, mark.width * width);
    context.save();
    context.strokeStyle = resolveColor(mark.color);
    context.fillStyle = resolveColor(mark.color);
    context.lineWidth = lineWidth;
    context.lineCap = "round";
    context.lineJoin = "round";
    if (mark.kind === "pen" || mark.kind === "highlighter") {
      if (mark.kind === "highlighter") { context.globalAlpha = 0.35; context.lineWidth = lineWidth * 4; context.lineCap = "square"; }
      context.beginPath();
      mark.points.forEach((p, i) => { const q = px(p); if (i) context.lineTo(q.x, q.y); else context.moveTo(q.x, q.y); });
      context.stroke();
    } else if (mark.kind === "arrow") {
      const a = px(mark.from), b = px(mark.to);
      context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      const [l, r] = arrowHead(a, b, lineWidth * 4);
      context.beginPath(); context.moveTo(b.x, b.y); context.lineTo(l.x, l.y); context.lineTo(r.x, r.y); context.closePath(); context.fill();
    } else if (mark.kind === "rect" || mark.kind === "ellipse" || mark.kind === "blur") {
      const box = boxOf(mark.from, mark.to);
      const x = box.x * width, y = box.y * height, w = box.width * width, h = box.height * height;
      if (mark.kind === "rect") context.strokeRect(x, y, w, h);
      else if (mark.kind === "ellipse") { context.beginPath(); context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); context.stroke(); }
      else if (source && w >= 1 && h >= 1) {
        // Pixela: reduz o trecho e amplia sem suavizar.
        const block = Math.max(6, Math.round(width / 80));
        const small = document.createElement("canvas");
        small.width = Math.max(1, Math.round(w / block)); small.height = Math.max(1, Math.round(h / block));
        small.getContext("2d")?.drawImage(source, x, y, w, h, 0, 0, small.width, small.height);
        context.imageSmoothingEnabled = false;
        context.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
      }
    } else if (mark.kind === "text") {
      const size = Math.max(14, mark.width * width * 7);
      const at = px(mark.at);
      context.font = `600 ${size}px system-ui, sans-serif`;
      context.textBaseline = "top";
      context.lineWidth = Math.max(2, size / 6);
      context.strokeStyle = resolveColor(mark.color === "white" ? "gray-950" : "white");
      context.strokeText(mark.text, at.x, at.y);
      context.fillText(mark.text, at.x, at.y);
    } else if (mark.kind === "step") {
      const radius = Math.max(14, width / 60);
      const at = px(mark.at);
      context.beginPath(); context.arc(at.x, at.y, radius, 0, Math.PI * 2); context.fill();
      context.fillStyle = resolveColor(mark.color === "white" || mark.color === "yellow-400" ? "gray-950" : "white");
      context.font = `bold ${radius * 1.1}px system-ui, sans-serif`;
      context.textAlign = "center"; context.textBaseline = "middle";
      context.fillText(String(mark.n), at.x, at.y);
    }
    context.restore();
  }
}
