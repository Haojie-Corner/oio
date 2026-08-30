import { getLocalFallbackSettings, getSession, getSupabase } from "./cloud";
import { db } from "./db";
import { hashCardContent } from "./utils";
import type { AIProviderConfig, CardAIResult, ChatMessage, KeywordMeta, OioCard } from "./types";

const ASSISTANT_SYSTEM_PROMPT = `你是 OIO 随身英语搭子与表达助手。
核心原则：像真人朋友一样自然、简练、口语化地聊天交流，坚决杜绝机械模板、小标题堆砌和八股文长篇大论！

回复准则：
1. 像朋友一样正常轻松聊天：回复要简明精炼（通常 1~3 句话即可），不要一下子答一大堆。
2. 闲聊/打招呼/日常吐槽：用地道自然的口语接话，可以中英结合自然回应，轻松随和。
3. 询问英文怎么说/输入句子求改写：直接给出 1 句最地道纯正的母语者表达，必要时补 1 句简短点睛解析即可。
4. 严禁使用 "**英文表达：**"、"**讲解：**"、"**更地道的替代说法：**" 这类死板僵硬的模板小标题。讲人话、简短、真实。`;

export interface AssistantReply {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** AI 助手对话：与改写/整理共用同一个服务商配置（同一个 API Key） */
export async function askAssistant(history: ChatMessage[]): Promise<AssistantReply> {
  const provider = ((await db.settings.get("settings")) || getLocalFallbackSettings())?.provider;
  if (!provider?.enabled || !provider.baseUrl || !provider.model || !provider.apiKey) {
    throw new Error("请先在设置里填写模型名和 API Key，并打开「启用真实 AI」。");
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60_000);
  let response: Response;
  try {
    response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.6,
        messages: [{ role: "system", content: ASSISTANT_SYSTEM_PROMPT }, ...history],
      }),
    });
  } catch {
    throw new Error(controller.signal.aborted ? "连接 AI 超时，请稍后再试。" : "无法连接 AI 服务：请检查网络。");
  } finally {
    window.clearTimeout(timeout);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(friendlyAiError(response.status, body?.error?.message));
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("AI 返回内容为空");
  return {
    content: content.trim(),
    usage: {
      inputTokens: Number(body?.usage?.prompt_tokens || 0),
      outputTokens: Number(body?.usage?.completion_tokens || 0),
    },
  };
}

type ProviderPayload = {
  suggestedTitle: string;
  organizedOriginal: string;
  targetSentences: string[];
  targetReply: string;
  corrections: { original: string; suggestion: string; reason: string }[];
  practiceKeywords: string[];
  keywordMeta: KeywordMeta[];
  chineseMeaning: string;
  relatedTags: string[];
  suggestedFolder: string;
  inputTokens: number;
  outputTokens: number;
};

function buildPrompt(tasks: string[], title: string, content: string) {
  return `你是 OIO 语言自然生长导师 & 语境转译专家。用户会输入中文、英文或中英混合的生活碎片，可能带着抱怨、欣喜、疲惫等真实情绪。根据启用任务生成结果。\n启用任务：${tasks.join(", ")}\n标题：${title}\n内容：${content}\n\n要求：\n1. 深度理解场景与情绪，输出母语者在真实生活中会说的地道英文（保留第一人称，语调与用户情绪一致），坚决杜绝生硬直译和中式英语。\n2. targetSentences 只包含 1 个元素：无论输入长短，改写成一句自然地道的目标语言。\n3. suggestedTitle 提炼一个生动、精炼的中文主题标题（4~10个字，如“欢迎彼得到家做晚饭”、“暴雨后的通勤感悟”）。\n4. practiceKeywords 提取 2~4 个最值得学习的动词短语、固定搭配或核心名词短语（不要单个普通单词，每个不超过 4 个单词）。\n5. keywordMeta 为每个挖空短语生成 2 个高迷惑性但当前语境下不匹配的干扰项，以及一句中文解析（说明为什么这个表达比普通说法更地道）。\n6. chineseMeaning 用一句简练中文概括整段意思。\n7. relatedTags 给出 2~4 个描述这段生活场景的中文标签。\n\n只返回 JSON：{"suggestedTitle":"精炼中文主题标题(4~10字)","organizedOriginal":"整理后的原文","targetSentences":["一句自然目标语言"],"targetReply":"简短自然回复","practiceKeywords":["核心短语"],"keywordMeta":[{"phrase":"与 practiceKeywords 对应的短语","distractors":["干扰项1","干扰项2"],"explanation":"中文解析：为什么这个表达更地道"}],"chineseMeaning":"简练中文意思","relatedTags":["场景标签"],"suggestedFolder":"建议归档的专题文件夹名(2~6个字,如 车主日常)"}`;
}

function stripFence(value: string) {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function parseKeywordMeta(value: unknown): KeywordMeta[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4).map((item) => {
    const row = item as Partial<{ phrase: unknown; distractors: unknown; explanation: unknown }>;
    return {
      phrase: String(row.phrase || "").trim(),
      distractors: Array.isArray(row.distractors) ? row.distractors.map(String).slice(0, 3) : [],
      explanation: String(row.explanation || ""),
    };
  }).filter((item) => item.phrase);
}

function normalizeResult(value: Record<string, unknown>): ProviderPayload {
  const corrections = Array.isArray(value.corrections)
    ? value.corrections.slice(0, 3).map((item) => {
        const row = item as Partial<{ original: unknown; suggestion: unknown; reason: unknown }>;
        return {
          original: String(row.original || ""),
          suggestion: String(row.suggestion || ""),
          reason: String(row.reason || ""),
        };
      }).filter((item) => item.original && item.suggestion)
    : [];
  return {
    suggestedTitle: String(value.suggestedTitle || ""),
    organizedOriginal: String(value.organizedOriginal || ""),
    // 产品定位：一段输入只对应一句改写，多余的直接丢弃
    targetSentences: Array.isArray(value.targetSentences) ? value.targetSentences.map(String).slice(0, 1) : [],
    targetReply: String(value.targetReply || ""),
    corrections,
    practiceKeywords: Array.isArray(value.practiceKeywords) ? value.practiceKeywords.map(String).slice(0, 4) : [],
    keywordMeta: parseKeywordMeta(value.keywordMeta),
    chineseMeaning: String(value.chineseMeaning || ""),
    relatedTags: Array.isArray(value.relatedTags) ? value.relatedTags.map(String).slice(0, 4) : [],
    suggestedFolder: "",
    inputTokens: 0,
    outputTokens: 0,
  };
}

function friendlyAiError(status: number, message?: string) {
  if (status === 401 || status === 403) return `鉴权失败：请检查 API Key 是否正确、账户是否有额度。${message ? `（${message}）` : ""}`;
  if (status === 404) return `接口不存在：请检查 Base URL（一般以 /v1 结尾）和模型名拼写。${message ? `（${message}）` : ""}`;
  if (status === 429) return "请求太频繁或额度不足，请稍后再试。";
  return message || `AI 服务返回 ${status}`;
}

async function callProviderDirect(provider: AIProviderConfig, card: OioCard, hash: string): Promise<CardAIResult> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60_000);
  let response: Response;
  try {
    response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.35,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Return valid JSON only. Be concise, friendly, and pedagogically accurate." },
          { role: "user", content: buildPrompt(card.tasks, card.title, card.body.trim()) },
        ],
      }),
    });
  } catch {
    throw new Error(controller.signal.aborted
      ? "连接 AI 服务超时：请检查 Base URL 是否可达（国内网络访问 OpenAI 官方地址需要自备网络环境）。"
      : "无法连接 AI 服务：请检查 Base URL 和网络。");
  } finally {
    window.clearTimeout(timeout);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(friendlyAiError(response.status, body?.error?.message));
  const raw = body?.choices?.[0]?.message?.content;
  if (typeof raw !== "string") throw new Error("AI 返回内容为空");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    throw new Error("AI 返回格式异常，请重新生成一次。");
  }
  const result = normalizeResult(parsed);
  return {
    suggestedTitle: result.suggestedTitle,
    organizedSource: result.organizedOriginal || card.body,
    rewrittenSentences: result.targetSentences,
    reply: result.targetReply,
    corrections: result.corrections.map((item) => ({ original: item.original, corrected: item.suggestion, reason: item.reason })),
    practiceKeywords: result.practiceKeywords,
    keywordMeta: result.keywordMeta,
    chineseMeaning: result.chineseMeaning,
    relatedTags: result.relatedTags,
    suggestedFolder: result.suggestedFolder,
    inputTokens: Number(body?.usage?.prompt_tokens || 0),
    outputTokens: Number(body?.usage?.completion_tokens || 0),
    status: "ready",
    contentHash: hash,
  };
}

export async function processCardWithAI(card: OioCard): Promise<CardAIResult> {
  const hash = await hashCardContent(card);
  if (card.ai.status === "ready" && card.ai.contentHash === hash) return card.ai;

  // 本地直连优先：Key 在本机、请求直达服务商，不依赖任何服务端
  const provider = ((await db.settings.get("settings")) || getLocalFallbackSettings())?.provider;
  if (provider?.enabled && provider.baseUrl && provider.model && provider.apiKey) {
    return callProviderDirect(provider, card, hash);
  }

  // 本地配置不全时，已登录用户回退到云端函数
  const supabase = getSupabase();
  if (supabase && (await getSession())) {
    const { data, error } = await supabase.functions.invoke("process-card", {
      body: { cardId: card.id, title: card.title, content: card.body, tasks: card.tasks, contentHash: hash },
    });
    if (error) throw new Error((error as { message?: string }).message || "AI 处理失败");
    return {
      organizedSource: String(data.organizedOriginal ?? card.body),
      rewrittenSentences: Array.isArray(data.targetSentences) ? data.targetSentences.map(String).slice(0, 1) : [],
      reply: String(data.targetReply ?? ""),
      corrections: Array.isArray(data.corrections)
        ? data.corrections.slice(0, 3).map((item: { original?: unknown; suggestion?: unknown; reason?: unknown }) => ({
            original: String(item.original ?? ""),
            corrected: String(item.suggestion ?? ""),
            reason: String(item.reason ?? ""),
          }))
        : [],
      practiceKeywords: Array.isArray(data.practiceKeywords) ? data.practiceKeywords.map(String).slice(0, 4) : [],
      keywordMeta: parseKeywordMeta(data.keywordMeta),
      chineseMeaning: String(data.chineseMeaning ?? ""),
      relatedTags: Array.isArray(data.relatedTags) ? data.relatedTags.map(String).slice(0, 4) : [],
      suggestedFolder: String(data.suggestedFolder ?? ""),
      inputTokens: Number(data.usage?.inputTokens ?? 0),
      outputTokens: Number(data.usage?.outputTokens ?? 0),
      status: "ready",
      contentHash: hash,
    };
  }

  throw new Error("AI 还没配置完整：请在设置里填写模型名和 API Key，并打开「启用真实 AI」。");
}
