/**
 * Heurística para localizar os campos de usuário e senha em um formulário de login.
 * Pura sobre `Document`, testável sem navegador real.
 */

export interface LoginFields {
  username: HTMLInputElement | null;
  password: HTMLInputElement;
}

const TEXT_LIKE_TYPES = new Set(["", "text", "email", "tel", "url"]);

function isUsableInput(input: HTMLInputElement): boolean {
  if (input.disabled || input.readOnly) return false;
  if (input.type === "hidden") return false;
  if (input.hasAttribute("hidden")) return false;
  return true;
}

function hasAutocompleteToken(input: HTMLInputElement, tokens: readonly string[]): boolean {
  const raw = input.getAttribute("autocomplete");
  if (!raw) return false;
  const parts = raw.toLowerCase().split(/\s+/).filter(Boolean);
  return parts.some((part) => tokens.includes(part));
}

function findUsernameIn(candidates: HTMLInputElement[], password: HTMLInputElement): HTMLInputElement | null {
  const usable = candidates.filter((el) => el !== password && isUsableInput(el) && TEXT_LIKE_TYPES.has((el.type || "").toLowerCase()));
  const byAutocomplete = usable.find((el) => hasAutocompleteToken(el, ["username", "email"]));
  if (byAutocomplete) return byAutocomplete;

  const byEmailType = usable.find((el) => el.type.toLowerCase() === "email");
  if (byEmailType) return byEmailType;

  // Último campo de texto utilizável antes do `input[type=password]` na ordem do DOM.
  let beforePassword: HTMLInputElement | null = null;
  for (const el of usable) {
    const rel = el.compareDocumentPosition(password);
    if ((rel & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
      beforePassword = el;
    }
  }
  return beforePassword;
}

/**
 * Encontra o campo de senha (`input[type=password]`) e o campo de usuário associado.
 * Prioriza `autocomplete=username|email`, depois `type=email`, e por fim o `input` de texto
 * imediatamente anterior ao campo de senha.
 */
export function findLoginFields(doc: Document): LoginFields | null {
  const passwords = Array.from(doc.querySelectorAll<HTMLInputElement>("input[type=password]"))
    .filter(isUsableInput);
  const password = passwords[0];
  if (!password) return null;

  const form = password.form;
  if (form) {
    const inForm = Array.from(form.querySelectorAll<HTMLInputElement>("input"));
    const userInForm = findUsernameIn(inForm, password);
    if (userInForm) return { username: userInForm, password };
  }

  const allInputs = Array.from(doc.querySelectorAll<HTMLInputElement>("input"));
  return { username: findUsernameIn(allInputs, password), password };
}
