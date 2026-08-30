import { corsHeaders, json } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { decryptSecret } from "../_shared/crypto.ts";

type Correction = { original: string; suggestion: string; reason: string };

function stripFence(value: string) {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function normalizeResult(value: Record<string, unknown>) {
  const corrections = Array.isArray(value.corrections)
    ? value.corrections.slice(0, 3).map((item) => {
        const row = item as Partial<Correction>;
        return {
          original: String(row.original || ""),
          suggestion: String(row.suggestion || ""),
          reason: String(row.reason || ""),
        };
      }).filter((item) => item.original && item.suggestion)
    : [];
  return {
    organizedOriginal: String(value.organizedOriginal || ""),
    // 产品定位：一段输入只对应一句改写，多余的直接丢弃
    targetSentences: Array.isArray(value.targetSentences) ? value.targetSentences.map(String).slice(0, 1) : [],
    targetReply: String(value.targetReply || ""),
    corrections,
    practiceKeywords: Array.isArray(value.practiceKeywords) ? value.practiceKeywords.map(String).slice(0, 4) : [],
    keywordMeta: Array.isArray(value.keywordMeta) ? value.keywordMeta.slice(0, 4).map((item) => {
      const row = item as Partial<{ phrase: unknown; distractors: unknown; explanation: unknown }>;
      return {
        phrase: String(row.phrase || "").trim(),
        distractors: Array.isArray(row.distractors) ? row.distractors.map(String).slice(0, 3) : [],
        explanation: String(row.explanation || ""),
      };
    }).filter((item) => item.phrase) : [],
    chineseMeaning: String(value.chineseMeaning || ""),
    relatedTags: Array.isArray(value.relatedTags) ? value.relatedTags.map(String).slice(0, 4) : [],
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { admin, user } = await requireUser(request);
    const input = await request.json();
    const cardId = String(input.cardId || "");
    const title = String(input.title || "");
    const content = String(input.content || "").trim();
    const tasks = Array.isArray(input.tasks) ? input.tasks.map(String) : [];
    if (!cardId || !content) return json({ error: "卡片内容不能为空" }, 400);

    const { data: config, error: configError } = await admin
      .from("ai_provider_configs")
      .select("provider,base_url,model,encrypted_api_key,enabled")
      .eq("user_id", user.id)
      .single();
    if (configError || !config?.enabled || !config.encrypted_api_key) {
      return json({ error: "请先在设置中配置并启用 AI 服务" }, 400);
    }

    const apiKey = await decryptSecret(config.encrypted_api_key);
    const prompt = `你是 OIO 英语表达教练。用户可能输入中文、英文或混合内容。根据启用任务生成简洁结果。\n启用任务：${tasks.join(", ")}\n标题：${title}\n内容：${content}\n\n只返回 JSON：{\"organizedOriginal\":\"整理后的原文\",\"targetSentences\":[\"一句自然目标语言\"],\"targetReply\":\"简短自然回复\",\"practiceKeywords\":[\"核心短语\"],\"keywordMeta\":[{\"phrase\":\"与 practiceKeywords 对应的短语\",\"distractors\":[\"干扰项1\",\"干扰项2\"],\"explanation\":\"中文解析：为什么这个表达更地道\"}],\"chineseMeaning\":\"简练中文意思\",\"relatedTags\":[\"场景标签\"],\"suggestedFolder\":\"建议归档的专题文件夹名(2~6个字)\"}。targetSentences 只含 1 个元素。practiceKeywords 提取 2~4 个动词短语、固定搭配或核心名词短语（不要单个普通单词，每个不超过 4 个单词）。keywordMeta 为每个短语生成 2 个高迷惑性干扰项和一句中文解析。chineseMeaning 一句简练中文概括。回复保持 1-2 句。`;
    const response = await fetch(`${config.base_url.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.35,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Return valid JSON only. Be concise, friendly, and pedagogically accurate." },
          { role: "user", content: prompt },
        ],
      }),
    });
    const providerBody = await response.json();
    if (!response.ok) {
      throw new Error(providerBody?.error?.message || `AI 服务返回 ${response.status}`);
    }
    const raw = providerBody?.choices?.[0]?.message?.content;
    if (typeof raw !== "string") throw new Error("AI 返回内容为空");
    const result = normalizeResult(JSON.parse(stripFence(raw)));
    const usage = {
      inputTokens: Number(providerBody?.usage?.prompt_tokens || 0),
      outputTokens: Number(providerBody?.usage?.completion_tokens || 0),
      totalTokens: Number(providerBody?.usage?.total_tokens || 0),
    };

    await admin.from("ai_usage").insert({
      user_id: user.id,
      card_id: cardId,
      provider: config.provider,
      model: config.model,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
    });
    return json({ ...result, usage, status: "ready", error: null });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "生成失败" }, 400);
  }
});
