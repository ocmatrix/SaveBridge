import { describe, expect, it } from "vitest";
import { zh } from "../../src/i18n/zh";
import { en } from "../../src/i18n/en";
import { t, pickInitialLang } from "../../src/i18n";

describe("i18n dictionaries", () => {
  it("zh and en have exactly the same keys", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });
  it("no empty strings", () => {
    for (const d of [zh, en]) for (const [k, v] of Object.entries(d)) expect(v.trim(), k).not.toBe("");
  });
  it("placeholders match between languages", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const k of Object.keys(zh) as (keyof typeof zh)[]) expect(ph(en[k]), k).toEqual(ph(zh[k]));
  });
  it("never exposes internal risk states", () => {
    for (const d of [zh, en]) for (const [k, v] of Object.entries(d)) expect(v, k).not.toMatch(/\b(REVIEW|HELD|PENDING|WAITING)\b/);
  });
  it("interpolates params", () => {
    expect(t("zh", "amount.belowMin", { min: "10" })).toContain("10");
  });
  it("required wording (DESIGN §8.1)", () => {
    expect(zh["wl.closed"]).toBe("跨链未开通，请联系客服");
    expect(zh["order.processing"]).toBe("处理中");
  });
  it("picks zh for Chinese browsers, en otherwise", () => {
    expect(pickInitialLang(["zh-CN"])).toBe("zh");
    expect(pickInitialLang(["en-US"])).toBe("en");
    expect(pickInitialLang([])).toBe("zh");
  });
});
