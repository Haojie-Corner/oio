import { createClient, type RealtimeChannel, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { db } from "./db";
import { emptyAI } from "./types";
import type { CardAttachment, OioCard, OioCategory, OioCollection, UserSettings } from "./types";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

let client: SupabaseClient | null = null;
let activeChannel: RealtimeChannel | null = null;

export const cloudConfigured = Boolean(supabaseUrl && supabaseKey);

export function getSupabase() {
  if (!cloudConfigured) return null;
  client ??= createClient(supabaseUrl!, supabaseKey!, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

export async function getSession(): Promise<Session | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function signUp(email: string, password: string) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("尚未配置 Supabase。请先填写环境变量。");
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.href.split("#")[0] },
  });
  if (error) throw error;
  return data;
}

export async function signIn(email: string, password: string) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("尚未配置 Supabase。请先填写环境变量。");
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function resetPassword(email: string) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("尚未配置 Supabase。");
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.href.split("#")[0] });
  if (error) throw error;
}

export async function signOut() {
  const supabase = getSupabase();
  if (activeChannel) {
    void supabase?.removeChannel(activeChannel);
    activeChannel = null;
  }
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export function toCloudCard(card: OioCard, userId: string) {
  return {
    id: card.id,
    user_id: userId,
    collection_id: card.collectionId || "life",
    category_id: card.categoryId || "uncategorized",
    title: card.title || "",
    body: card.body || "",
    tasks: card.tasks || [],
    ai_result: card.ai || emptyAI,
    created_at: card.createdAt || new Date().toISOString(),
    updated_at: card.updatedAt || new Date().toISOString(),
    deleted_at: null,
  };
}

export function fromCloudCard(row: Record<string, unknown>, attachments: CardAttachment[] = []): OioCard {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    collectionId: String(row.collection_id || "life"),
    categoryId: String(row.category_id || "uncategorized"),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    tasks: (row.tasks ?? []) as OioCard["tasks"],
    attachments,
    ai: (row.ai_result ?? { ...emptyAI, status: "ready" }) as OioCard["ai"],
    createdAt: String(row.created_at || new Date().toISOString()),
    updatedAt: String(row.updated_at || new Date().toISOString()),
    deletedAt: undefined,
    syncState: "synced",
    isDemo: false,
  };
}

/** 广播实时变更通知给其他在线设备（手机/电脑秒级互通） */
export async function broadcastMutation(action: string, id?: string) {
  if (!activeChannel) return;
  try {
    await activeChannel.send({
      type: "broadcast",
      event: "mutation",
      payload: { action, id, ts: Date.now() },
    });
  } catch (err) {
    console.error("广播同步失败:", err);
  }
}

/** 实时向云端保存/更新卡片，并通知所有端刷新 */
export async function pushCardToCloud(card: OioCard) {
  const supabase = getSupabase();
  const session = await getSession();
  if (!supabase || !session) return;
  const userId = session.user.id;
  const row = toCloudCard(card, userId);
  const { error } = await supabase.from("cards").upsert([row]);
  if (error) {
    console.error("pushCardToCloud 失败:", error);
    return;
  }
  for (const attachment of card.attachments) {
    if (!attachment.dataUrl.startsWith("data:")) continue;
    try {
      const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "-");
      const path = `${userId}/${card.id}/${attachment.id}-${safeName}`;
      const blob = await (await fetch(attachment.dataUrl)).blob();
      await supabase.storage.from("card-images").upload(path, blob, {
        contentType: attachment.mimeType,
        upsert: true,
      });
      await supabase.from("card_attachments").upsert({
        id: attachment.id,
        user_id: userId,
        card_id: card.id,
        kind: "image",
        storage_path: path,
        mime_type: attachment.mimeType,
        byte_size: attachment.size,
        updated_at: card.updatedAt,
      });
    } catch (attErr) {
      console.error("图片上传失败:", attErr);
    }
  }
  await db.cards.update(card.id, { syncState: "synced" });
  await broadcastMutation("save", card.id);
}

/** 实时向云端彻底删除卡片，并通知所有端同步清除 */
export async function deleteCardOnCloud(id: string) {
  const supabase = getSupabase();
  const session = await getSession();
  if (!supabase || !session) return;
  const userId = session.user.id;
  await Promise.all([
    supabase.from("cards").delete().eq("id", id).eq("user_id", userId),
    supabase.from("card_attachments").delete().eq("card_id", id).eq("user_id", userId),
  ]);
  await db.cards.delete(id);
  await broadcastMutation("delete", id);
}

/** 订阅 Supabase WebSocket 广播与变更通道 */
export function subscribeToCloudChanges(onUpdate: () => void) {
  const supabase = getSupabase();
  if (!supabase) return () => {};

  void (async () => {
    const session = await getSession();
    if (!session) return;
    const userId = session.user.id;

    if (activeChannel) {
      void supabase.removeChannel(activeChannel);
    }

    const channel = supabase.channel(`oio-sync-${userId}`, {
      config: { broadcast: { self: false } },
    });

    channel
      .on("broadcast", { event: "mutation" }, async () => {
        await syncCloudData();
        onUpdate();
      })
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "cards", filter: `user_id=eq.${userId}` },
        async () => {
          await syncCloudData();
          onUpdate();
        }
      )
      .subscribe();

    activeChannel = channel;
  })();

  return () => {
    if (activeChannel) {
      void supabase.removeChannel(activeChannel);
      activeChannel = null;
    }
  };
}

export interface SyncResult {
  merged: OioCard[];
  activeCount: number;
}

/**
 * 核心云端对齐函数：以云端为绝对真实数据源（Single Source of Truth）。
 * 云端没有的卡片（已被其他设备删除）立即从本地彻底清除，坚决杜绝“死灰复燃”。
 */
export async function syncCloudData(onProgress?: (message: string) => void): Promise<SyncResult> {
  const supabase = getSupabase();
  const session = await getSession();
  if (!supabase || !session) throw new Error("请先登录后再同步。");
  const userId = session.user.id;

  onProgress?.("正在连接云端…");

  // 1. 获取云端全量数据
  const [cardsResult, collectionsResult, categoriesResult, attachmentsResult] = await Promise.all([
    supabase.from("cards").select("*").eq("user_id", userId).order("updated_at", { ascending: false }),
    supabase.from("collections").select("*").eq("user_id", userId).is("deleted_at", null),
    supabase.from("categories").select("*").eq("user_id", userId).is("deleted_at", null),
    supabase.from("card_attachments").select("*").eq("user_id", userId).is("deleted_at", null),
  ]);

  if (cardsResult.error) throw cardsResult.error;
  if (collectionsResult.error) throw collectionsResult.error;
  if (categoriesResult.error) throw categoriesResult.error;
  if (attachmentsResult.error) throw attachmentsResult.error;

  const remoteRows = cardsResult.data ?? [];
  const remoteIdSet = new Set(remoteRows.map((r) => String(r.id)));

  // 2. 获取图片签名 URL
  const attachmentMap = new Map<string, CardAttachment[]>();
  for (const row of attachmentsResult.data ?? []) {
    if (!row.storage_path) continue;
    const { data: signed } = await supabase.storage.from("card-images").createSignedUrl(row.storage_path, 60 * 60 * 24 * 7);
    if (!signed?.signedUrl) continue;
    const item: CardAttachment = {
      id: row.id,
      name: row.storage_path.split("/").pop() || "图片",
      mimeType: row.mime_type || "image/jpeg",
      size: row.byte_size || 0,
      dataUrl: signed.signedUrl,
    };
    attachmentMap.set(row.card_id, [...(attachmentMap.get(row.card_id) ?? []), item]);
  }

  // 3. 构建云端卡片列表
  const cloudCards: OioCard[] = remoteRows.map((row) => fromCloudCard(row, attachmentMap.get(row.id) ?? []));

  // 4. 本地数据库强制与云端对齐（清除被删卡片与本地初始 demo）
  const localCards = await db.cards.toArray();
  const staleLocalIds = localCards
    .filter((c) => !remoteIdSet.has(c.id))
    .map((c) => c.id);

  const cloudCollections: OioCollection[] = (collectionsResult.data ?? []).map((row) => ({
    id: row.id, name: row.name, createdAt: row.created_at,
  }));
  const cloudCategories: OioCategory[] = (categoriesResult.data ?? []).map((row) => ({
    id: row.id, collectionId: row.collection_id, name: row.name,
  }));

  await db.transaction("rw", db.cards, db.collections, db.categories, async () => {
    // 清除本地多余/已被其他端删除的卡片
    if (staleLocalIds.length) {
      await db.cards.bulkDelete(staleLocalIds);
    }
    // 写入云端最新卡片
    if (cloudCards.length) {
      await db.cards.bulkPut(cloudCards);
    }
    if (cloudCollections.length) await db.collections.bulkPut(cloudCollections);
    if (cloudCategories.length) await db.categories.bulkPut(cloudCategories);
  });

  await db.syncQueue.clear();

  return { merged: cloudCards, activeCount: cloudCards.length };
}

export async function saveCloudSettings(settings: UserSettings) {
  const supabase = getSupabase();
  const session = await getSession();
  if (!supabase || !session) throw new Error("请先登录后再同步设置。");
  const { error } = await supabase.from("user_settings").upsert({
    user_id: session.user.id,
    display_name: settings.displayName,
    interface_language: settings.interfaceLanguage,
    target_language: settings.targetLanguage,
    proficiency: settings.level,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function saveProviderSecurely(provider: UserSettings["provider"]) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("尚未配置 Supabase。");
  const { data, error } = await supabase.functions.invoke("save-provider", {
    body: {
      provider: provider.providerName,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: provider.apiKey,
      inputPricePerMillion: provider.inputPricePerMillion,
      outputPricePerMillion: provider.outputPricePerMillion,
      enabled: provider.enabled,
    },
  });
  if (error) throw error;
  return data;
}


