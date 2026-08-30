import { describe, expect, it } from "vitest";
import { clozeSentence, deriveAutoTitle, estimateCost, hashCardContent, isSameLocalDay, normalizeWord, splitClozeSegments, toggleWordInList } from "../src/utils";

const blanksOf = (sentence: string, words: string[]) =>
  splitClozeSegments(sentence, words).filter((segment) => segment.type === "blank").map((segment) => segment.value);

describe("OIO local learning helpers", () => {
  it("creates a cloze from an AI keyword", () => {
    expect(clozeSentence("I had a delicious bowl of noodles.", ["delicious"])).toEqual({
      prompt: "I had a _____ bowl of noodles.",
      answer: "delicious",
    });
  });

  it("falls back to a long word when no keyword matches", () => {
    expect(clozeSentence("Breakfast was wonderful today.", []).answer).toBe("Breakfast");
  });

  it("only estimates money when both prices are provided", () => {
    expect(estimateCost(1_000_000, 500_000, 1, 2)).toBe(2);
    expect(estimateCost(1_000, 500)).toBeNull();
  });

  it("compares local calendar days", () => {
    const date = new Date(2026, 7, 29, 12, 0, 0);
    expect(isSameLocalDay(new Date(2026, 7, 29, 1, 0, 0).toISOString(), date)).toBe(true);
    expect(isSameLocalDay(new Date(2026, 7, 28, 23, 0, 0).toISOString(), date)).toBe(false);
  });

  it("hashes equivalent task order identically", async () => {
    const first = await hashCardContent({ body: " hello ", tasks: ["rewrite", "reply"] });
    const second = await hashCardContent({ body: "hello", tasks: ["reply", "rewrite"] });
    expect(first).toBe(second);
  });

  it("splits a sentence into blank segments for chosen words", () => {
    const segments = splitClozeSegments("I'm doing great today because I got a solid night's sleep.", ["because", "sleep"]);
    const blanks = segments.filter((segment) => segment.type === "blank").map((segment) => segment.value);
    expect(blanks).toEqual(["because", "sleep"]);
  });

  it("supports multi-word phrase blanks", () => {
    expect(blanksOf("The rain has finally stopped today.", ["finally stopped"])).toEqual(["finally stopped"]);
  });

  it("matches phrases across punctuation-glued tokens", () => {
    expect(blanksOf("The rain finally stopped—what a relief!", ["finally stopped"])).toEqual(["finally stopped"]);
  });

  it("does not blank inside another word", () => {
    expect(blanksOf("The category includes cats.", ["cat"])).toEqual([]);
  });

  it("matches blanks ignoring case and punctuation", () => {
    expect(blanksOf("Night's sleep matters.", ["night's", "sleep"])).toEqual(["Night's", "sleep"]);
  });

  it("normalizes words for comparison", () => {
    expect(normalizeWord("Sleep.")).toBe("sleep");
    expect(normalizeWord("  Night's ")).toBe("night's");
  });

  it("toggles a word in the blank list", () => {
    const added = toggleWordInList(["because"], "Solid");
    expect(added).toEqual(["because", "solid"]);
    const removed = toggleWordInList(added, "SOLID");
    expect(removed).toEqual(["because"]);
  });

  it("filters out system settings rows from user cards list correctly", () => {
    const userId = "user-1234-abcd";
    const settingsId = `settings_${userId}`;
    const rawRows = [
      { id: "card_1", user_id: userId, title: "English Note" },
      { id: settingsId, user_id: userId, title: "__SYSTEM_USER_SETTINGS__" },
      { id: "card_2", user_id: userId, title: "Coffee time" },
    ];
    const userCards = rawRows.filter(
      (r) => r.title !== "__SYSTEM_USER_SETTINGS__" && !String(r.id).startsWith("settings_") && r.id !== "system:settings"
    );
    expect(userCards.length).toBe(2);
    expect(userCards.map((c) => c.id)).toEqual(["card_1", "card_2"]);
  });

  it("derives auto title from AI title, meaning, or body fallback", () => {
    expect(deriveAutoTitle("Hello world", "欢迎彼得到家做晚饭", "欢迎彼得")).toBe("欢迎彼得到家做晚饭");
    expect(deriveAutoTitle("Hello world", "", "朋友聚餐")).toBe("朋友聚餐");
    expect(deriveAutoTitle("今天下了一场暴雨，下班路上一片泥泞。")).toBe("今天下了一场暴雨");
    expect(deriveAutoTitle("Hey, Peter. Welcome to my home.")).toBe("朋友聚会与拜访");
    expect(deriveAutoTitle("Hello, it's sunny and hot today but it's warm inside.")).toBe("晴朗好天气与日常");
  });
});
