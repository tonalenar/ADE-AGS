/**
 * Detecção heurística de captcha e bloqueio de cliques no iframe do desafio.
 *
 * Puro (sem React, Zustand nem Tauri): roda tanto no frontend da app (`agentBridge.ts`)
 * quanto dentro da página (`page/runtime.ts`).
 *
 * Regra inegociável: a ADE NUNCA resolve captcha sozinha e o agente NUNCA pode clicar
 * dentro do widget do desafio. Só detecta, pausa e entrega para a pessoa.
 */

export type CaptchaKind =
  | "recaptcha"
  | "hcaptcha"
  | "turnstile"
  | "cloudflare"
  | "aws-waf"
  | "generic";

export interface CaptchaIframeRect {
  src: string;
  title?: string;
  name?: string;
  id?: string;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

export interface DocumentSnapshot {
  url?: string;
  title?: string;
  text?: string;
  html?: string;
  iframes?: CaptchaIframeRect[];
  hasChallengeForm?: boolean;
  hasRecaptchaWidget?: boolean;
  hasHcaptchaWidget?: boolean;
  hasTurnstileWidget?: boolean;
  /** Resposta preenchida pelo widget após a pessoa concluir um captcha em linha. */
  solvedToken?: boolean;
  /** Ação reportada pelo proxy (`preview/proxy.rs::waf_challenge_action`, ex.: "challenge", "captcha"). */
  wafChallengeAction?: string | null;
}

const RECAPTCHA_URL_RE = /(?:^|\/\/|\.)(?:google\.com\/recaptcha|recaptcha\.net\/recaptcha|gstatic\.com\/recaptcha)/i;
const HCAPTCHA_URL_RE = /(?:^|\/\/|\.)hcaptcha\.com(?:\/|$)/i;
const TURNSTILE_URL_RE = /(?:^|\/\/|\.)challenges\.cloudflare\.com(?:\/|$)/i;
const AWS_WAF_URL_RE = /(?:^|\/\/|\.)(?:captcha|token)\.awswaf\.com(?:\/|$)/i;
const OTHER_CAPTCHA_URL_RE = /(?:^|\/\/|\.)(?:arkoselabs\.com|funcaptcha\.com|geetest\.com|captcha-delivery\.com)(?:\/|$)/i;

const CLOUDFLARE_TITLE_RE = /^(?:just a moment|um momento|un momento|attention required!?\s*\|\s*cloudflare)/i;
const GENERIC_HUMAN_CHECK_RE = /\b(?:verify (?:that )?you are (?:a )?human|verifique (?:que|se) voc[êe] [ée] humano|confirm you are human|confirme que voc[êe] [ée] humano|prove you are human|checking your browser before accessing|complete the security check|please verify you are a human)\b/i;

const CAPTCHA_SELECTOR_RE = /(?:recaptcha|hcaptcha|h-captcha|g-recaptcha|cf-turnstile|turnstile|challenges\.cloudflare\.com|challenge-form|awswaf|captcha-frame|captcha_frame)/i;

const CAPTCHA_CONTAINER_SELECTOR = [
  ".g-recaptcha",
  ".h-captcha",
  ".cf-turnstile",
  "#challenge-form",
  "[data-hcaptcha-widget-id]",
  "[data-turnstile-widget-id]",
  "[id*='awswaf-captcha' i]",
  "[class*='awswaf-captcha' i]",
].join(",");

/** `true` se a URL pertence a um provedor conhecido de widget/desafio de captcha. */
export function isCaptchaIframeUrl(src: string): boolean {
  if (!src) return false;
  return (
    RECAPTCHA_URL_RE.test(src) ||
    HCAPTCHA_URL_RE.test(src) ||
    TURNSTILE_URL_RE.test(src) ||
    AWS_WAF_URL_RE.test(src) ||
    OTHER_CAPTCHA_URL_RE.test(src)
  );
}

/** `true` se o texto/seletor aponta diretamente para um iframe ou widget de captcha. */
export function isCaptchaSelector(target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) return false;
  return CAPTCHA_SELECTOR_RE.test(trimmed);
}

/** Interpreta um alvo de coordenadas no formato do runtime (`@x,y` ou `@x,y#2`). */
export function parsePointTarget(target: string): { x: number; y: number } | null {
  const match = /^@(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:#2)?$/.exec(target.trim());
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** `true` se o ponto `(x, y)` cai dentro da caixa de algum iframe de desafio. */
export function pointHitsCaptchaIframe(x: number, y: number, iframes: readonly CaptchaIframeRect[]): boolean {
  for (const frame of iframes) {
    if (!isCaptchaIframeUrl(frame.src) && !isCaptchaFrameMeta(frame)) continue;
    if (
      typeof frame.left === "number" &&
      typeof frame.top === "number" &&
      typeof frame.right === "number" &&
      typeof frame.bottom === "number" &&
      frame.right > frame.left &&
      frame.bottom > frame.top &&
      x >= frame.left &&
      x <= frame.right &&
      y >= frame.top &&
      y <= frame.bottom
    ) {
      return true;
    }
  }
  return false;
}

function isCaptchaFrameMeta(frame: Pick<CaptchaIframeRect, "src" | "title" | "name" | "id">): boolean {
  const meta = `${frame.title ?? ""} ${frame.name ?? ""} ${frame.id ?? ""}`;
  return /\b(?:recaptcha|hcaptcha|turnstile|cloudflare\s+challenge)\b/i.test(meta);
}

/** `true` se o elemento do DOM é (ou está contido em) um iframe/widget de captcha. */
export function isCaptchaIframeElement(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === "IFRAME") {
    const src = el.getAttribute("src") ?? "";
    const title = el.getAttribute("title") ?? "";
    const name = el.getAttribute("name") ?? "";
    const id = el.getAttribute("id") ?? "";
    if (isCaptchaIframeUrl(src) || isCaptchaFrameMeta({ src, title, name, id })) return true;
  }
  if (typeof el.closest === "function" && el.closest(CAPTCHA_CONTAINER_SELECTOR)) {
    return true;
  }
  return false;
}

/** Extrai o retrato mínimo do documento para `detectCaptcha` e proteção de clique. */
export function snapshotFromDocument(doc: Document, wafChallengeAction?: string | null): DocumentSnapshot {
  const iframes: CaptchaIframeRect[] = Array.from(doc.querySelectorAll("iframe")).map((frame) => {
    const rect = typeof frame.getBoundingClientRect === "function" ? frame.getBoundingClientRect() : null;
    const hasBox = rect && (rect.width > 0 || rect.height > 0);
    return {
      src: frame.getAttribute("src") ?? "",
      title: frame.getAttribute("title") ?? undefined,
      name: frame.getAttribute("name") ?? undefined,
      id: frame.getAttribute("id") ?? undefined,
      ...(hasBox ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : {}),
    };
  });

  const hasChallengeForm = Boolean(
    doc.querySelector("#challenge-form, form[action*='__cf_chl'], #cf-challenge-running, .cf-browser-verification"),
  );
  const hasRecaptchaWidget = Boolean(
    doc.querySelector(".g-recaptcha, #recaptcha, [data-sitekey][class*='recaptcha' i]"),
  );
  const hasHcaptchaWidget = Boolean(
    doc.querySelector(".h-captcha, [data-hcaptcha-widget-id]"),
  );
  const hasTurnstileWidget = Boolean(
    doc.querySelector(".cf-turnstile, [data-turnstile-widget-id], input[name='cf-turnstile-response']"),
  );

  const responseFields = Array.from(
    doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "textarea[name='g-recaptcha-response'], textarea[name='h-captcha-response'], input[name='cf-turnstile-response']",
    ),
  );
  const solvedToken = responseFields.some((field) => (field.value ?? "").trim().length > 0);

  const rawText = doc.body?.textContent ?? doc.documentElement?.textContent ?? "";
  const text = rawText.replace(/\s+/g, " ").trim().slice(0, 4000);

  return {
    url: typeof doc.location?.href === "string" ? doc.location.href : undefined,
    title: doc.title ?? "",
    text,
    iframes,
    hasChallengeForm,
    hasRecaptchaWidget,
    hasHcaptchaWidget,
    hasTurnstileWidget,
    solvedToken,
    wafChallengeAction: wafChallengeAction ?? null,
  };
}

function extractIframesFromHtml(html: string): CaptchaIframeRect[] {
  const frames: CaptchaIframeRect[] = [];
  const tagRe = /<iframe\b([^>]*)>/gi;
  for (const match of html.matchAll(tagRe)) {
    const attrs = match[1] ?? "";
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
    const title = /\btitle\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    frames.push({ src, title, name, id });
  }
  return frames;
}

function extractTitleFromHtml(html: string): string {
  return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
}

/**
 * Detecta se o documento contém um desafio de captcha/WAF que exige a pessoa.
 *
 * Heurística pura — sem modelo, sem rede, sem interação com a página.
 */
export function detectCaptcha(doc: DocumentSnapshot): CaptchaKind | null {
  if (!doc) return null;

  // 1. AWS WAF reportado pelo proxy (`preview/proxy.rs::waf_challenge_action`) ou presente no HTML.
  if (typeof doc.wafChallengeAction === "string" && doc.wafChallengeAction.trim() !== "") {
    return "aws-waf";
  }

  const html = doc.html ?? "";
  const title = (doc.title ?? (html ? extractTitleFromHtml(html) : "")).trim();
  const iframes = doc.iframes ?? (html ? extractIframesFromHtml(html) : []);
  const hasChallengeForm =
    doc.hasChallengeForm === true ||
    /id\s*=\s*["']challenge-form["']/i.test(html) ||
    /action\s*=\s*["'][^"']*__cf_chl/i.test(html);

  // 2. Página de desafio da Cloudflare ("Just a moment..." / "Um momento…" com #challenge-form).
  if (hasChallengeForm && (CLOUDFLARE_TITLE_RE.test(title) || /cloudflare|__cf_chl/i.test(html) || /checking|verificando|security|segurança/i.test(doc.text ?? ""))) {
    return "cloudflare";
  }
  if (CLOUDFLARE_TITLE_RE.test(title) && hasChallengeForm) {
    return "cloudflare";
  }

  // Se um widget em linha já tem token resolvido pela pessoa e não há interstitial nem WAF, libera.
  if (doc.solvedToken && !hasChallengeForm) {
    return null;
  }

  // 3. Iframes de provedores conhecidos.
  for (const frame of iframes) {
    if (RECAPTCHA_URL_RE.test(frame.src)) return "recaptcha";
    if (HCAPTCHA_URL_RE.test(frame.src)) return "hcaptcha";
    if (TURNSTILE_URL_RE.test(frame.src)) return "turnstile";
    if (AWS_WAF_URL_RE.test(frame.src)) return "aws-waf";
    if (OTHER_CAPTCHA_URL_RE.test(frame.src)) return "generic";
  }

  // 4. Contêineres de widget no DOM/HTML (quando o iframe ainda está carregando).
  if (doc.hasRecaptchaWidget || /class\s*=\s*["'][^"']*\bg-recaptcha\b/i.test(html)) {
    return "recaptcha";
  }
  if (doc.hasHcaptchaWidget || /class\s*=\s*["'][^"']*\bh-captcha\b/i.test(html)) {
    return "hcaptcha";
  }
  if (doc.hasTurnstileWidget || /class\s*=\s*["'][^"']*\bcf-turnstile\b/i.test(html)) {
    return "turnstile";
  }
  if (/awswaf-captcha|captcha\.awswaf\.com/i.test(html)) {
    return "aws-waf";
  }

  // 5. Texto explícito de verificação humana.
  const bodyText = doc.text ?? (html ? html.replace(/<[^>]+>/g, " ") : "");
  if (GENERIC_HUMAN_CHECK_RE.test(bodyText)) {
    return "generic";
  }

  return null;
}
