import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { resolveLocale } from "./locale";

/**
 * Cada idioma é um chunk próprio: antes os três JSON (~190 KB cada) iam estáticos no entry e eram 35%
 * do que a janela parseava antes de pintar. Agora só o idioma ativo vem antes do primeiro pintado
 * (`i18nReady`, que o `main.tsx` espera) e o `en` de reserva chega depois, sem bloquear.
 */
const LOADERS: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  es: () => import("@/i18n/locales/es.json"),
  en: () => import("@/i18n/locales/en.json"),
  "pt-BR": () => import("@/i18n/locales/pt-BR.json"),
};

const loaded = new Map<string, Promise<void>>();

/** Carrega o pacote de um idioma (uma vez). Idioma desconhecido resolve sem fazer nada. */
export function loadLocale(lng: string): Promise<void> {
  const load = LOADERS[lng];
  if (!load) return Promise.resolve();
  let pending = loaded.get(lng);
  if (!pending) {
    pending = load()
      .then((bundle) => {
        i18n.addResourceBundle(lng, "translation", bundle.default, true, true);
      })
      .catch((error: unknown) => {
        loaded.delete(lng);
        console.error(`[i18n] não foi possível carregar o idioma ${lng}`, error);
      });
    loaded.set(lng, pending);
  }
  return pending;
}

/** Troca o idioma depois de ter o pacote dele (sem isso a tela mostraria as chaves por um instante). */
export function setLanguage(lng: string): Promise<unknown> {
  return loadLocale(lng).then(() => i18n.changeLanguage(lng));
}

const initial = resolveLocale(localStorage.getItem("language"), navigator.language);

i18n.use(initReactI18next).init({
  resources: {},
  partialBundledLanguages: true,
  lng: initial,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

/** O idioma ativo carregado: o primeiro pintado espera isto. O `en` de reserva vem em seguida. */
export const i18nReady: Promise<void> = loadLocale(initial).then(() => {
  if (initial !== "en") void loadLocale("en");
});

// El backend arma algunos textos solo (los avisos del sistema, ver `notifier.rs`) y no ve
// el `localStorage`: se le deja el idioma en la base, al arrancar y cada vez que cambia.
// Sin Tauri (los tests) `invoke` falla, y no pasa nada.
const shareLanguage = (lng: string) => {
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("db_set_setting", { key: "ui.language", value: lng }))
    .catch(() => {});
};
shareLanguage(i18n.language);
i18n.on("languageChanged", shareLanguage);

// O `<html lang>` acompanha a interface (corretor ortográfico dos campos, leitores de tela e a página que o Jev lê).
const markDocument = (lng: string) => {
  if (typeof document !== "undefined") document.documentElement.lang = lng;
};
markDocument(i18n.language);
i18n.on("languageChanged", markDocument);

export default i18n;
