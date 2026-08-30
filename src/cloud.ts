import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { db } from "./db";
import { emptyAI } from "./types";
import type { CardAttachment, OioCard, OioCategory, OioCollection, UserSettings } from "./types";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

let client: SupabaseClient | null = null;

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
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export function toCloudCard(card: OioCard, userId: string) {
  return {
    id: card.id,
    user_id: userId,
    collection_id: card.collectionId,
    category_id: card.categoryId,
    title: card.title,
    body: card.body,
    tasks: card.tasks,
    ai_result: card.ai,
    created_at: card.createdAt,
    updated_at: card.updatedAt,
    deleted_at: card.deletedAt ?? null,
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
    deletedAt: row.deleted_at ? String(row.deleted_at) : undefined,
    syncState: "synced",
    isDemo: false,
  };
}

/** 实时向云端单卡推送（即时同步，无需等待手动触发） */
export async function pushCardToCloud(card: OioCard) {
  const supabase = getSupabase();
  const session = await getSession();
  if (!supabase || !session) return;
  const userId = session.user.id;
  const row = toCloudCard(card, userId);
  const { error } = await supabase.from("cards").upsert([row]);
  if (error) {
    console.error("pushCardToCloud failed:", error);
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
      console.error("Attachment upload error:", attErr);
    }
  }
  await db.cards.update(card.id, { syncState: "synced" });
}

/** 实时向云端标记删除卡片（毫秒级同步，防止多端复活） */
export async function deleteCardOnCloud(id: string, deletedAt?: string) {
  const supabase = getSupabase();
  const session = await getSession();
  if (!supabase || !session) return;
  const now = deletedAt ?? new Date().toISOString();
  const { error } = await supabase
    .from("cards")
    .update({ deleted_at: now, updated_at: now })
    .eq("id", id)
    .eq("user_id", session.user.id);
  if (error) {
    console.error("deleteCardOnCloud failed:", error);
  }
}

/** 订阅 Supabase Realtime 数据库变更（实现跨设备秒级自动响应） */
export function subscribeToCloudChanges(onUpdate: () => void) {
  const supabase = getSupabase();
  if (!supabase) return () => {};

  const channel = supabase
    .channel("oio-realtime-channel")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "cards" },
      async (payload) => {
        if (payload.eventType === "DELETE" && payload.old && (payload.old as { id?: string }).id) {
          const oldId = (payload.old as { id: string }).id;
          await db.cards.delete(oldId);
          onUpdate();
        } else if (payload.new && typeof payload.new === "object") {
          const row = payload.new as Record<string, unknown>;
          const cloudCard = fromCloudCard(row);
          if (row.deleted_at) {
            const local = await db.cards.get(cloudCard.id);
            if (local) {
              await db.cards.put({ ...local, deletedAt: String(row.deleted_at), updatedAt: cloudCard.updatedAt, syncState: "synced" });
            } else {
              await db.cards.put(cloudCard);
            }
          } else {
            await db.cards.put(cloudCard);
          }
          onUpdate();
        }
      }
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "collections" },
      () => { onUpdate(); }
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "categories" },
      () => { onUpdate(); }
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}

export interface SyncResult {
  merged: OioCard[];
  activeCount: number;
}

export async function syncCloudData(onProgress?: (message: string) => void): Promise<SyncResult> {
  const supabase = getSupabase();
  const session = await getSession();
  if (!supabase || !session) throw new Error("请先登录后再同步。");
  const userId = session.user.id;
  const [localCards, localCollections, localCategories] = await Promise.all([
    db.cards.toArray(), db.collections.toArray(), db.categories.toArray(),
  ]);
  onProgress?.("正在上传集合和卡片…");
  const { data: remoteVersions, error: versionError } = await supabase.from("cards").select("id,updated_at,deleted_at");
  if (versionError) throw versionError;
  const remoteMap = new Map((remoteVersions ?? []).map((row) => [row.id, row]));
  
  // 过滤出真正需要上传的卡片（排除未修改的初始 Demo 卡片）
  const cardsToUpload = localCards.filter((card) => {
    if (card.isDemo && !card.deletedAt) return false;
    const remote = remoteMap.get(card.id);
    if (!remote) return true;
    return new Date(card.updatedAt).getTime() >= new Date(remote.updated_at).getTime();
  });

  if (localCollections.length) {
    const { error } = await supabase.from("collections").upsert(localCollections.map((collection) => ({
      id: collection.id,
      user_id: userId,
      name: collection.name,
      updated_at: collection.createdAt,
    })), { ignoreDuplicates: true });
    if (error) throw error;
  }
  if (localCategories.length) {
    const { error } = await supabase.from("categories").upsert(localCategories.map((category) => ({
      id: category.id,
      user_id: userId,
      collection_id: category.collectionId,
      name: category.name,
    })), { ignoreDuplicates: true });
    if (error) throw error;
  }

  if (cardsToUpload.length) {
    const rows = cardsToUpload.map((card) => toCloudCard(card, userId));
    const { error } = await supabase.from("cards").upsert(rows);
    if (error) {
      for (const card of cardsToUpload) {
        const { error: cardError } = await supabase.from("cards").upsert([toCloudCard(card, userId)]);
        if (cardError) {
          const detail = [cardError.message, cardError.details, cardError.hint].filter(Boolean).join(" | ");
          throw new Error(`卡片「${card.title || card.body.slice(0, 12)}」上传失败：${detail}`);
        }
      }
      throw error;
    }
  }

  for (const card of cardsToUpload) {
    for (const attachment of card.attachments) {
      if (!attachment.dataUrl.startsWith("data:")) continue;
      const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "-");
      const path = `${userId}/${card.id}/${attachment.id}-${safeName}`;
      const blob = await (await fetch(attachment.dataUrl)).blob();
      const { error: uploadError } = await supabase.storage.from("card-images").upload(path, blob, {
        contentType: attachment.mimeType,
        upsert: true,
      });
      if (uploadError) throw uploadError;
      const { error: attachmentError } = await supabase.from("card_attachments").upsert({
        id: attachment.id,
        user_id: userId,
        card_id: card.id,
        kind: "image",
        storage_path: path,
        mime_type: attachment.mimeType,
        byte_size: attachment.size,
        updated_at: card.updatedAt,
      });
      if (attachmentError) throw attachmentError;
    }
  }

  onProgress?.("正在合并云端数据…");
  const [cardsResult, collectionsResult, categoriesResult, attachmentsResult] = await Promise.all([
    supabase.from("cards").select("*").order("updated_at", { ascending: false }),
    supabase.from("collections").select("*").is("deleted_at", null),
    supabase.from("categories").select("*").is("deleted_at", null),
    supabase.from("card_attachments").select("*").is("deleted_at", null),
  ]);
  if (cardsResult.error) throw cardsResult.error;
  if (collectionsResult.error) throw collectionsResult.error;
  if (categoriesResult.error) throw categoriesResult.error;
  if (attachmentsResult.error) throw attachmentsResult.error;

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

  const localMap = new Map(localCards.map((card) => [card.id, card]));
  const merged = (cardsResult.data ?? []).map((row) => {
    const cloudCard = fromCloudCard(row, attachmentMap.get(row.id) ?? []);
    const local = localMap.get(cloudCard.id);
    return local && new Date(local.updatedAt) > new Date(cloudCard.updatedAt) ? local : cloudCard;
  });
  
  for (const local of localCards) {
    if (!merged.some((card) => card.id === local.id)) {
      if (!local.isDemo || local.deletedAt) {
        merged.push(local);
      }
    }
  }

  // 清理多端本地初始 demo 卡片（如果云端已有用户记录或已拉取）
  const demoIdsToRemove = localCards.filter((c) => c.isDemo && !merged.some((m) => m.id === c.id)).map((c) => c.id);

  const cloudCollections: OioCollection[] = (collectionsResult.data ?? []).map((row) => ({
    id: row.id, name: row.name, createdAt: row.created_at,
  }));
  const cloudCategories: OioCategory[] = (categoriesResult.data ?? []).map((row) => ({
    id: row.id, collectionId: row.collection_id, name: row.name,
  }));
  
  await db.transaction("rw", db.cards, db.collections, db.categories, async () => {
    await db.cards.bulkPut(merged.map((card) => ({ ...card, syncState: "synced" as const })));
    if (demoIdsToRemove.length) {
      await db.cards.bulkDelete(demoIdsToRemove);
    }
    if (cloudCollections.length) await db.collections.bulkPut(cloudCollections);
    if (cloudCategories.length) await db.categories.bulkPut(cloudCategories);
  });
  await db.syncQueue.clear();

  const activeCount = merged.filter((card) => !card.deletedAt).length;
  return { merged, activeCount };
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

