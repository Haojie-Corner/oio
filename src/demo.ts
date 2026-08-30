import type { OioCard, OioCategory, OioCollection, UserSettings } from "./types";

const today = new Date();
const atTime = (hour: number, minute: number) => {
  const date = new Date(today);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
};

const makeCard = (
  id: string,
  title: string,
  body: string,
  rewrittenSentence: string,
  hour: number,
  minute: number,
  reply: string,
): OioCard => ({
  id,
  collectionId: "life",
  categoryId: "uncategorized",
  title,
  body,
  tasks: ["organize", "reply", "rewrite"],
  attachments: [],
  ai: {
    organizedSource: body,
    rewrittenSentences: [rewrittenSentence],
    reply,
    corrections: [],
    practiceKeywords: rewrittenSentence.split(/\s+/).filter((word) => word.length > 5).slice(0, 3),
    inputTokens: 42,
    outputTokens: 74,
    status: "ready",
  },
  createdAt: atTime(hour, minute),
  updatedAt: atTime(hour, minute),
  syncState: "local",
});

export const demoCards: OioCard[] = [
  makeCard(
    "sleep",
    "昨晚睡好心情佳",
    "昨晚睡得很好，今天精神特别好。",
    "I'm doing great today because I got a solid night's sleep.",
    9,
    21,
    "That sounds refreshing! A good night's sleep really changes the whole day.",
  ),
  makeCard(
    "mistake",
    "今天犯了个错误",
    "I make a mistake today.",
    "I made a mistake today.",
    9,
    18,
    "It happens to everyone. What matters is what you learned from it.",
  ),
  makeCard(
    "rain",
    "雨天室内暖和用 MacBook Air 工作",
    "It's rain today and it's cold outside, but warm inside. I'm in the living room now and I'm working on my MacBook Air.",
    "It's raining today, and it's cold outside, but it's warm inside. I'm working on my MacBook Air in the living room.",
    9,
    14,
    "That sounds cozy—rain outside and a warm room is a perfect setup for getting things done.",
  ),
  makeCard(
    "noodles",
    "今早吃美味一碗面",
    "I had breakfast this morning and ate a bowl of noodles. And it was delicious.",
    "I had a delicious bowl of noodles for breakfast this morning.",
    9,
    6,
    "Sounds awesome! Noodles for breakfast hit different—glad it was delicious.",
  ),
];

export const demoCollections: OioCollection[] = [
  { id: "life", name: "生活集", createdAt: today.toISOString() },
];

export const demoCategories: OioCategory[] = [
  { id: "uncategorized", collectionId: "life", name: "未分类" },
];

export const defaultSettings: UserSettings = {
  id: "settings",
  displayName: "楠哥",
  email: "",
  interfaceLanguage: "zh-CN",
  targetLanguage: "English",
  level: "intermediate",
  provider: {
    providerName: "OpenAI-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    hasStoredKey: false,
    enabled: false,
  },
  monthlyInputTokens: 168,
  monthlyOutputTokens: 296,
  lastTokenReset: new Date(today.getFullYear(), today.getMonth(), 1).toISOString(),
};
