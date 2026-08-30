import Dexie, { type EntityTable } from "dexie";
import { defaultSettings, demoCards, demoCategories, demoCollections } from "./demo";
import { makeId } from "./utils";
import type { OioCard, OioCategory, OioCollection, PracticeRecord, UserSettings } from "./types";

export interface SyncQueueItem {
  id: string;
  entity: "card" | "settings";
  entityId: string;
  action: "upsert" | "delete";
  createdAt: string;
  attempts: number;
}

class OioDatabase extends Dexie {
  cards!: EntityTable<OioCard, "id">;
  collections!: EntityTable<OioCollection, "id">;
  categories!: EntityTable<OioCategory, "id">;
  settings!: EntityTable<UserSettings, "id">;
  practice!: EntityTable<PracticeRecord, "id">;
  syncQueue!: EntityTable<SyncQueueItem, "id">;

  constructor() {
    super("oio-local-v1");
    this.version(1).stores({
      cards: "id, collectionId, categoryId, createdAt, updatedAt, deletedAt, syncState",
      collections: "id, createdAt",
      categories: "id, collectionId",
      settings: "id",
      practice: "id, cardId, mode, createdAt",
      syncQueue: "id, entity, entityId, createdAt",
    });
  }
}

export const db = new OioDatabase();

export async function seedDatabase() {
  const count = await db.cards.count();
  if (count === 0) {
    // 演示卡片用随机 id，并标记 isDemo: true（避免登录后误上传到云端）
    const seededCards = demoCards.map((card) => ({ ...card, id: makeId("card"), isDemo: true }));
    await db.transaction("rw", db.cards, db.collections, db.categories, db.settings, async () => {
      await db.cards.bulkPut(seededCards);
      await db.collections.bulkPut(demoCollections);
      await db.categories.bulkPut(demoCategories);
      await db.settings.put(defaultSettings);
    });
  }
  if (!(await db.settings.get("settings"))) await db.settings.put(defaultSettings);
}

export async function queueSync(entity: SyncQueueItem["entity"], entityId: string, action: SyncQueueItem["action"]) {
  const id = `${entity}:${entityId}`;
  await db.syncQueue.put({ id, entity, entityId, action, createdAt: new Date().toISOString(), attempts: 0 });
}

export async function exportAllData() {
  const [cards, collections, categories, settings, practice] = await Promise.all([
    db.cards.toArray(),
    db.collections.toArray(),
    db.categories.toArray(),
    db.settings.toArray(),
    db.practice.toArray(),
  ]);
  return { version: 1, exportedAt: new Date().toISOString(), cards, collections, categories, settings, practice };
}
