import { corsHeaders, json } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { encryptSecret } from "../_shared/crypto.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { admin, user } = await requireUser(request);
    const input = await request.json();
    const baseUrl = String(input.baseUrl || "").trim().replace(/\/$/, "");
    const model = String(input.model || "").trim();
    if (!baseUrl || !model) return json({ error: "请填写 Base URL 和模型名" }, 400);
    new URL(baseUrl);

    const { data: existing } = await admin
      .from("ai_provider_configs")
      .select("encrypted_api_key")
      .eq("user_id", user.id)
      .maybeSingle();
    const apiKey = String(input.apiKey || "").trim();
    const encryptedApiKey = apiKey
      ? await encryptSecret(apiKey)
      : existing?.encrypted_api_key ?? null;

    const { error } = await admin.from("ai_provider_configs").upsert({
      user_id: user.id,
      provider: String(input.provider || "OpenAI-compatible"),
      base_url: baseUrl,
      model,
      encrypted_api_key: encryptedApiKey,
      input_price_per_million: input.inputPricePerMillion ?? null,
      output_price_per_million: input.outputPricePerMillion ?? null,
      enabled: Boolean(input.enabled && encryptedApiKey),
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    return json({ ok: true, hasApiKey: Boolean(encryptedApiKey) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "保存失败" }, 400);
  }
});
