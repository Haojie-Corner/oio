export type AITask = "organize" | "reply" | "rewrite";

export interface Correction {
  original: string;
  corrected: string;
  reason: string;
}

/** 挖空短语的练习元数据：AI 生成的干扰项与地道用法解析 */
export interface KeywordMeta {
  phrase: string;
  distractors: string[];
  explanation: string;
}

export interface CardAIResult {
  organizedSource: string;
  rewrittenSentences: string[];
  reply: string;
  corrections: Correction[];
  practiceKeywords: string[];
  keywordMeta?: KeywordMeta[];
  chineseMeaning?: string;
  relatedTags?: string[];
  suggestedFolder?: string;
  inputTokens: number;
  outputTokens: number;
  status: "idle" | "processing" | "ready" | "error";
  error?: string;
  contentHash?: string;
}

export interface CardAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

export interface OioCard {
  id: string;
  userId?: string;
  collectionId: string;
  categoryId: string;
  title: string;
  body: string;
  tasks: AITask[];
  attachments: CardAttachment[];
  ai: CardAIResult;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  syncState: "local" | "pending" | "synced" | "error";
  isDemo?: boolean;
}

export const emptyAI: CardAIResult = {
  organizedSource: "",
  rewrittenSentences: [],
  reply: "",
  corrections: [],
  practiceKeywords: [],
  inputTokens: 0,
  outputTokens: 0,
  status: "idle",
};

export interface OioCollection {
  id: string;
  name: string;
  createdAt: string;
}

export interface OioCategory {
  id: string;
  collectionId: string;
  name: string;
}

export interface AIProviderConfig {
  providerName: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  hasStoredKey: boolean;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  enabled: boolean;
}

export interface UserSettings {
  id: "settings";
  displayName: string;
  email: string;
  interfaceLanguage: "zh-CN" | "zh-TW" | "en" | "ja";
  targetLanguage: "English" | "Japanese";
  level: "beginner" | "intermediate" | "advanced";
  provider: AIProviderConfig;
  monthlyInputTokens: number;
  monthlyOutputTokens: number;
  lastTokenReset: string;
  lastSyncedAt?: string;
}

export type AppView =
  | { name: "home" }
  | { name: "editor"; cardId?: string }
  | { name: "detail"; cardId: string; practice?: PracticeMode }
  | { name: "recall"; cards: OioCard[]; index: number }
  | { name: "trash" }
  | { name: "settings" }
  | { name: "auth" }
  | { name: "assistant" }
  | { name: "importer" }
  | { name: "review" };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type PracticeMode = "listen" | "reveal" | "cloze" | "choice";

export interface PracticeRecord {
  id: string;
  cardId: string;
  mode: PracticeMode;
  correct: boolean;
  createdAt: string;
}
