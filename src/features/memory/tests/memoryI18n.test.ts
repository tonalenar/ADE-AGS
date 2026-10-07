import { describe, expect, it } from "vitest";
import en from "../../../i18n/locales/en.json";
import es from "../../../i18n/locales/es.json";
import pt from "../../../i18n/locales/pt-BR.json";

const keys = (m: Record<string, string>) => Object.keys(m).filter((k) => /^(memory(Inbox|Purge|Dream|Context)|memoryReview|memoryDrafts|memorySearch|workspaceDelete)./.test(k)).sort();
const placeholders = (s: string) => (s.match(/{{\w+}}/g) ?? []).sort().join(",");

describe("i18n da memoria (inbox, purge, sonho)", () => {
  const locales = { en: en as Record<string, string>, es: es as Record<string, string>, pt: pt as Record<string, string> };
  it("os 3 idiomas tem as mesmas chaves", () => {
    expect(keys(locales.es)).toEqual(keys(locales.en));
    expect(keys(locales.pt)).toEqual(keys(locales.en));
  });
  it("mesmos placeholders e nenhum texto vazio", () => {
    for (const k of keys(locales.en)) {
      for (const l of [locales.es, locales.pt]) {
        expect(l[k].trim(), k).not.toBe("");
        expect(placeholders(l[k]), k).toBe(placeholders(locales.en[k]));
      }
    }
  });
  it("as chaves novas existem", () => {
    for (const k of ["memoryPurge.buttonLabel", "memoryDream.group", "memoryInbox.skippedDuplicates", "memoryInbox.highPriority"]) expect(keys(locales.en)).toContain(k);
  });
});
