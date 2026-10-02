import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import es from "@/i18n/locales/es.json";
import en from "@/i18n/locales/en.json";
import ptBR from "@/i18n/locales/pt-BR.json";
import { resolveLocale } from "./locale";

i18n.use(initReactI18next).init({
  resources: {
    es: { translation: es },
    en: { translation: en },
    "pt-BR": { translation: ptBR },
  },
  lng: resolveLocale(localStorage.getItem("language"), navigator.language),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
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

export default i18n;
