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

export default i18n;
