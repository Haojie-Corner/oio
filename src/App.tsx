import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowsLeftRight,
  BookOpenText,
  Brain,
  Camera,
  CaretDown,
  CaretRight,
  CaretUp,
  Check,
  CheckCircle,
  CheckSquare,
  CircleNotch,
  ClipboardText,
  Clock,
  CloudArrowUp,
  Copy,
  DotsThree,
  DownloadSimple,
  Ear,
  Eye,
  FileImage,
  FolderSimple,
  Gear,
  House,
  Lightbulb,
  List,
  ListChecks,
  MagnifyingGlass,
  Microphone,
  NotePencil,
  PaperPlaneRight,
  Play,
  Plus,
  Power,
  Robot,
  Shuffle,
  SignIn,
  SignOut,
  Sparkle,
  SpeakerHigh,
  Trash,
  User,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { askAssistant, processCardWithAI } from "./ai";
import {
  cloudConfigured,
  deleteCardOnCloud,
  emptyTrashOnCloud,
  getLocalFallbackSettings,
  getSession,
  getSupabase,
  purgeCardOnCloud,
  pushCardToCloud,
  resetPassword,
  restoreCardOnCloud,
  saveCloudSettings,
  saveProviderSecurely,
  setLocalFallbackSettings,
  signIn,
  signOut,
  signUp,
  subscribeToCloudChanges,
  syncCloudData,
} from "./cloud";
import { db, exportAllData, queueSync } from "./db";
import { defaultSettings } from "./demo";
import { emptyAI } from "./types";
import type {
  AITask,
  AppView,
  ChatMessage,
  KeywordMeta,
  OioCard,
  OioCategory,
  OioCollection,
  PracticeMode,
  UserSettings,
} from "./types";
import {
  cardPreview,
  clozeSentence,
  computeStreak,
  dayKeyOf,
  deriveAutoTitle,
  formatFullDate,
  formatTime,
  hasChineseText,
  isAutoOrGenericTitle,
  isSameLocalDay,
  makeId,
  normalizeWord,
  recallPromptOf,
  relatedCards,
  speak,
  splitClozeSegments,
  toggleWordInList,
} from "./utils";

type SpeechRecognitionConstructor = new () => {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: (event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void;
  onend: () => void;
  onerror: () => void;
};

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

function useOioData() {
  const [cards, setCards] = useState<OioCard[]>([]);
  const [trashCards, setTrashCards] = useState<OioCard[]>([]);
  const [collections, setCollections] = useState<OioCollection[]>([]);
  const [categories, setCategories] = useState<OioCategory[]>([]);
  const [settings, setSettings] = useState<UserSettings>(defaultSettings);
  const [practiceDates, setPracticeDates] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  const reload = useCallback(async () => {
    let storedSettings = await db.settings.get("settings");
    if (!storedSettings) {
      const fallback = getLocalFallbackSettings();
      if (fallback) {
        storedSettings = fallback;
        await db.settings.put(fallback);
      }
    } else {
      setLocalFallbackSettings(storedSettings);
    }
    const [nextCards, nextCollections, nextCategories, practiceRecords] = await Promise.all([
      db.cards.toArray(),
      db.collections.toArray(),
      db.categories.toArray(),
      db.practice.toArray(),
    ]);
    setCards(nextCards.filter((card) => !card.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    setTrashCards(nextCards.filter((card) => !!card.deletedAt).sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? "")));
    setCollections(nextCollections);
    setCategories(nextCategories);
    if (storedSettings) setSettings(storedSettings);
    setPracticeDates(practiceRecords.map((record) => record.createdAt.slice(0, 10)));
    setReady(true);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveCard = useCallback(async (card: OioCard) => {
    const next = { ...card, isDemo: false, updatedAt: new Date().toISOString(), syncState: "synced" as const };
    await db.cards.put(next);
    setCards((prev) => {
      const idx = prev.findIndex((c) => c.id === next.id);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = next;
        return copy;
      }
      return [next, ...prev];
    });
    await reload();
    void pushCardToCloud(next).catch(() => undefined);
    return next;
  }, [reload]);

  const deleteCard = useCallback(async (id: string) => {
    const card = await db.cards.get(id);
    if (!card) return;
    const now = new Date().toISOString();
    const next = { ...card, deletedAt: now, updatedAt: now, syncState: "synced" as const };
    await db.cards.put(next);
    await reload();
    void deleteCardOnCloud(id, now).catch(() => undefined);
  }, [reload]);

  const restoreCard = useCallback(async (id: string) => {
    const card = await db.cards.get(id);
    if (!card) return;
    const now = new Date().toISOString();
    const next = { ...card, deletedAt: undefined, updatedAt: now, syncState: "synced" as const };
    await db.cards.put(next);
    await reload();
    void restoreCardOnCloud(id).catch(() => undefined);
  }, [reload]);

  const purgeCard = useCallback(async (id: string) => {
    await db.cards.delete(id);
    await reload();
    void purgeCardOnCloud(id).catch(() => undefined);
  }, [reload]);

  const emptyTrash = useCallback(async () => {
    const all = await db.cards.toArray();
    const trashIds = all.filter((c) => !!c.deletedAt).map((c) => c.id);
    if (trashIds.length) {
      await db.cards.bulkDelete(trashIds);
      await reload();
      void emptyTrashOnCloud().catch(() => undefined);
    }
  }, [reload]);

  const saveSettings = useCallback(async (next: UserSettings) => {
    await db.settings.put(next);
    setLocalFallbackSettings(next);
    await queueSync("settings", "settings", "upsert");
    setSettings(next);
    void saveCloudSettings(next).catch(() => undefined);
  }, []);

  const recordAiUsage = useCallback(async (usage: { inputTokens: number; outputTokens: number }) => {
    if (!usage.inputTokens && !usage.outputTokens) return;
    const current = await db.settings.get("settings");
    if (!current) return;
    const now = new Date();
    const reset = new Date(current.lastTokenReset);
    const sameMonth = reset.getFullYear() === now.getFullYear() && reset.getMonth() === now.getMonth();
    await saveSettings({
      ...current,
      monthlyInputTokens: (sameMonth ? current.monthlyInputTokens : 0) + usage.inputTokens,
      monthlyOutputTokens: (sameMonth ? current.monthlyOutputTokens : 0) + usage.outputTokens,
      lastTokenReset: sameMonth ? current.lastTokenReset : now.toISOString(),
    });
  }, [saveSettings]);

  const addCollection = useCallback(async (name: string) => {
    const collection = { id: makeId("collection"), name, createdAt: new Date().toISOString() };
    await db.collections.put(collection);
    await reload();
  }, [reload]);

  return { cards, trashCards, collections, categories, settings, practiceDates, ready, reload, saveCard, deleteCard, restoreCard, purgeCard, emptyTrash, saveSettings, recordAiUsage, addCollection };
}

export function App() {
  const data = useOioData();
  const [view, setView] = useState<AppView>({ name: "home" });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [blindBoxOpen, setBlindBoxOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeCollection, setActiveCollection] = useState("life");
  const [toast, setToast] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [transientCard, setTransientCard] = useState<OioCard | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [batchProgressText, setBatchProgressText] = useState("");

  const refreshSession = useCallback(async () => {
    if (!cloudConfigured) { setSessionEmail(null); return; }
    const session = await getSession();
    setSessionEmail(session?.user?.email ?? null);
  }, []);

  useEffect(() => { void refreshSession(); }, [refreshSession, online]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // 实时订阅 Supabase 数据库变更与 WebSocket 广播（跨设备秒级同步，用户编辑时暂停避免打字卡顿）
  useEffect(() => {
    if (!cloudConfigured || !sessionEmail || view.name !== "home") return;
    const unsubscribe = subscribeToCloudChanges(() => {
      void data.reload();
    });
    return () => {
      unsubscribe();
    };
  }, [data.reload, sessionEmail, view.name]);

  // 后台超高频对齐（切回前台、聚焦及 2.5 秒心跳，确保两端绝对一致；在用户编辑/打字/设置时坚决暂停，避免打字延迟卡顿）
  useEffect(() => {
    if (!cloudConfigured || !sessionEmail || !online || settingsOpen || view.name !== "home") return;

    const runSilentSync = async () => {
      try {
        await syncCloudData();
        await data.reload();
      } catch {
        // 静默同步无需打扰用户
      }
    };

    void runSilentSync();

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === "visible") {
        void runSilentSync();
      }
    };

    window.addEventListener("focus", handleVisibilityOrFocus);
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);
    const timer = window.setInterval(handleVisibilityOrFocus, 2500);

    return () => {
      window.removeEventListener("focus", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
      window.clearInterval(timer);
    };
  }, [data.reload, online, sessionEmail, settingsOpen, view.name]);

  const filteredCards = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.cards.filter((card) => card.collectionId === activeCollection && (!needle || `${card.title} ${card.body} ${cardPreview(card)}`.toLowerCase().includes(needle)));
  }, [activeCollection, data.cards, query]);

  // 回顾近期（近 1 个月内的最多 10 张卡片，若无则智能回退到最新 10 张）
  const openRecent = useCallback(() => {
    const oneMonthAgo = Date.now() - 30 * 86400 * 1000;
    let recent = data.cards
      .filter((c) => new Date(c.createdAt).getTime() >= oneMonthAgo)
      .slice(0, 10);
    if (!recent.length && data.cards.length) {
      recent = data.cards.slice(0, 10);
    }
    if (!recent.length) return notify("卡片库暂无卡片，先记录一张吧");
    setView({ name: "recall", cards: recent, index: 0 });
  }, [data.cards, notify]);

  const createContentCard = useCallback(async (content: string) => {
    const trimmed = content.trim();
    const now = new Date().toISOString();
    const tempTitle = deriveAutoTitle(trimmed);
    const card: OioCard = {
      id: makeId("card"),
      collectionId: activeCollection,
      categoryId: "uncategorized",
      title: tempTitle,
      body: trimmed,
      tasks: ["rewrite", "reply"],
      attachments: [],
      ai: { ...emptyAI, status: "ready", organizedSource: trimmed, rewrittenSentences: [trimmed] },
      createdAt: now,
      updatedAt: now,
      syncState: "pending",
    };
    const saved = await data.saveCard(card);
    if (data.settings.provider.enabled) {
      void (async () => {
        try {
          const ai = await processCardWithAI({ ...saved, title: "", ai: { ...saved.ai, status: "idle" } });
          const aiChineseTitle = (ai.suggestedTitle?.trim() && hasChineseText(ai.suggestedTitle))
            ? ai.suggestedTitle.trim()
            : (ai.chineseMeaning?.trim() && hasChineseText(ai.chineseMeaning)
              ? ai.chineseMeaning.trim().slice(0, 16)
              : tempTitle);
          await data.saveCard({ ...saved, title: aiChineseTitle, ai, updatedAt: new Date().toISOString() });
          await data.recordAiUsage(ai);
        } catch (e) {
          console.warn("createContentCard AI process error:", e);
        }
      })();
    }
    return saved;
  }, [activeCollection, data]);

  const recordPractice = useCallback(async (cardId: string, mode: PracticeMode, correct: boolean) => {
    await db.practice.put({ id: makeId("practice"), cardId, mode, correct, createdAt: new Date().toISOString() });
    await data.reload();
  }, [data]);

  const runBatchAi = useCallback(async (actionType: "rewrite" | "reply" | "organize" | "all") => {
    if (selectedCardIds.size === 0) {
      notify("请先勾选需要处理的卡片");
      return;
    }
    if (batchProcessing) return;

    const rawProvider = (await db.settings.get("settings"))?.provider || getLocalFallbackSettings()?.provider || data.settings?.provider;
    const hasApiKey = Boolean(rawProvider?.apiKey?.trim());
    const canUseAi = hasApiKey || Boolean(rawProvider?.enabled) || (Boolean(getSupabase()) && Boolean(await getSession()));
    if (!canUseAi) {
      notify("请先在设置中填写 API Key 或开启真实 AI");
      return;
    }

    setBatchProcessing(true);
    const targetCards = data.cards.filter((c) => selectedCardIds.has(c.id));
    const total = targetCards.length;
    let completedCount = 0;
    setBatchProgressText(`1/${total}`);

    const labelMap: Record<string, string> = {
      rewrite: "目标语言改写",
      reply: "目标语言回复",
      organize: "原始输入整理",
      all: "完整 AI 处理",
    };

    notify(`开始批量${labelMap[actionType]}（共 ${total} 条）...`);

    for (const card of targetCards) {
      const nextTasks = actionType === "all"
        ? (["organize", "rewrite", "reply"] as AITask[])
        : Array.from(new Set([...(card.tasks || []), actionType])) as AITask[];
      await data.saveCard({ ...card, tasks: nextTasks, ai: { ...card.ai, status: "processing" } });
    }

    const concurrency = 2;
    const queue = [...targetCards];

    const worker = async () => {
      while (queue.length > 0) {
        const card = queue.shift();
        if (!card) break;
        try {
          const nextTasks = actionType === "all"
            ? (["organize", "rewrite", "reply"] as AITask[])
            : Array.from(new Set([...(card.tasks || []), actionType])) as AITask[];
          const hasCustomTitle = Boolean(card.title?.trim() && !isAutoOrGenericTitle(card.title));
          const cardToProcess: OioCard = {
            ...card,
            tasks: nextTasks,
            title: hasCustomTitle ? card.title : "",
            ai: { ...card.ai, status: "processing", contentHash: undefined },
          };
          const aiResult = await processCardWithAI(cardToProcess);
          let finalCard: OioCard = {
            ...card,
            tasks: nextTasks,
            ai: aiResult,
            updatedAt: new Date().toISOString(),
          };
          const aiChineseTitle = (aiResult.suggestedTitle?.trim() && hasChineseText(aiResult.suggestedTitle))
            ? aiResult.suggestedTitle.trim()
            : (aiResult.chineseMeaning?.trim() && hasChineseText(aiResult.chineseMeaning)
              ? aiResult.chineseMeaning.trim().slice(0, 16)
              : deriveAutoTitle(finalCard.body));
          finalCard.title = hasCustomTitle ? card.title : aiChineseTitle;
          await data.saveCard(finalCard);
          await data.recordAiUsage(aiResult);
        } catch (err) {
          console.warn(`Card ${card.id} batch AI failed`, err);
        } finally {
          completedCount++;
          setBatchProgressText(`${Math.min(completedCount + 1, total)}/${total}`);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
    setBatchProcessing(false);
    setBatchProgressText("");
    notify(`🎉 已完成 ${total} 条卡片的批量${labelMap[actionType]}！`);
  }, [batchProcessing, data, notify, selectedCardIds]);

  if (!data.ready) return <LoadingScreen />;

  const activeCard = (view.name === "detail" || view.name === "editor") && view.cardId
    ? (data.cards.find((card) => card.id === view.cardId) || (transientCard?.id === view.cardId ? transientCard : undefined) || data.trashCards.find((card) => card.id === view.cardId))
    : undefined;

  return (
    <div className="app-shell">
      <div className="app-content">
        <HomeHeader
          collection={data.collections.find((item) => item.id === activeCollection)?.name ?? "生活集"}
          collections={data.collections}
          activeCollection={activeCollection}
          switcherOpen={switcherOpen}
          onSelectCollection={(id) => { setActiveCollection(id); setSwitcherOpen(false); }}
          onToggleSwitcher={() => setSwitcherOpen((open) => !open)}
          online={online}
          searchOpen={searchOpen}
          query={query}
          onQuery={setQuery}
          onMenu={() => setDrawerOpen(true)}
          onSearch={() => setSearchOpen((open) => !open)}
        />
        <main className="home-main">
          <ReviewStrip
            onRecent={openRecent}
            onBlindBox={() => setBlindBoxOpen(true)}
            onGame={() => setView({ name: "review" })}
          />

          <div className={`card-list-header ${batchMode ? "in-batch-header" : ""}`}>
            {batchMode ? (
              <div className="batch-header-box">
                <div className="batch-header-top">
                  <button
                    type="button"
                    className="batch-action-btn select-all"
                    onClick={() => {
                      if (selectedCardIds.size === filteredCards.length) {
                        setSelectedCardIds(new Set());
                      } else {
                        setSelectedCardIds(new Set(filteredCards.map((c) => c.id)));
                      }
                    }}
                  >
                    <CheckSquare size={16} weight="bold" />
                    <span>{selectedCardIds.size === filteredCards.length ? "取消全选" : "全选"}</span>
                    <span className="batch-count">({selectedCardIds.size}/{filteredCards.length})</span>
                  </button>

                  {batchProcessing ? (
                    <div className="batch-processing-tag">
                      <CircleNotch size={14} className="spin" />
                      <span>{batchProgressText ? `处理中 (${batchProgressText})` : "处理中..."}</span>
                    </div>
                  ) : null}

                  <button
                    type="button"
                    className="batch-action-btn cancel"
                    onClick={() => {
                      setBatchMode(false);
                      setSelectedCardIds(new Set());
                    }}
                  >
                    完成
                  </button>
                </div>

                <div className="batch-actions-row">
                  <span className="batch-actions-label">批量操作：</span>
                  <button
                    type="button"
                    disabled={batchProcessing}
                    className="batch-action-pill"
                    onClick={() => void runBatchAi("rewrite")}
                    title="为选中卡片生成母语级地道英文改写与练习"
                  >
                    <NotePencil size={15} />
                    <span>目标语言改写</span>
                  </button>
                  <button
                    type="button"
                    disabled={batchProcessing}
                    className="batch-action-pill"
                    onClick={() => void runBatchAi("reply")}
                    title="为选中卡片生成母语级自然接话与回复"
                  >
                    <PaperPlaneRight size={15} />
                    <span>目标语言回复</span>
                  </button>
                  <button
                    type="button"
                    disabled={batchProcessing}
                    className="batch-action-pill"
                    onClick={() => void runBatchAi("organize")}
                    title="为选中卡片整理标点语法并深度提炼中文主题"
                  >
                    <ClipboardText size={15} />
                    <span>语言整理</span>
                  </button>
                  <button
                    type="button"
                    disabled={batchProcessing}
                    className="batch-action-pill accent"
                    onClick={() => void runBatchAi("all")}
                    title="一键同时完成改写、回复、整理与主题提炼"
                  >
                    <Sparkle size={15} weight="fill" />
                    <span>完整 AI 处理</span>
                  </button>
                </div>
              </div>
            ) : (
              <>
                <span className="card-list-count">共 {filteredCards.length} 条记录</span>
                {filteredCards.length > 0 ? (
                  <button
                    type="button"
                    className="batch-select-trigger"
                    onClick={() => {
                      setBatchMode(true);
                      setSelectedCardIds(new Set());
                    }}
                  >
                    <ListChecks size={16} weight="bold" />
                    <span>批量选择</span>
                  </button>
                ) : null}
              </>
            )}
          </div>

          <section className="card-list" aria-label="卡片列表">
            {filteredCards.length ? filteredCards.map((card) => (
              <CardRow
                key={card.id}
                card={card}
                batchMode={batchMode}
                selected={selectedCardIds.has(card.id)}
                onToggleSelect={() => {
                  setSelectedCardIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(card.id)) next.delete(card.id);
                    else next.add(card.id);
                    return next;
                  });
                }}
                menuOpen={openMenuId === card.id}
                onToggleMenu={() => setOpenMenuId((current) => (current === card.id ? null : card.id))}
                onCloseMenu={() => setOpenMenuId(null)}
                onOpen={() => { setOpenMenuId(null); setView({ name: "detail", cardId: card.id }); }}
                onEdit={() => { setOpenMenuId(null); setView({ name: "editor", cardId: card.id }); }}
                onDelete={() => { setOpenMenuId(null); void data.deleteCard(card.id).then(() => notify("卡片已移入回收站")); }}
              />
            )) : <EmptyState onAdd={() => setView({ name: "editor" })} />}
          </section>
        </main>
        
        {/* 批量操作悬浮条 */}
        {batchMode && selectedCardIds.size > 0 ? (
          <div className="batch-floating-bar">
            <div className="batch-floating-info">
              <span>已选 <strong>{selectedCardIds.size}</strong> 项</span>
            </div>
            <div className="batch-floating-btns">
              <button
                type="button"
                disabled={batchProcessing}
                className="batch-floating-ai-btn"
                onClick={() => void runBatchAi("all")}
              >
                <Sparkle size={16} weight="fill" />
                <span>批量 AI 处理</span>
              </button>
              <button
                type="button"
                disabled={batchProcessing}
                className="batch-delete-btn"
                onClick={async () => {
                  const count = selectedCardIds.size;
                  if (window.confirm(`确定要将选中的 ${count} 条记录移入回收站吗？`)) {
                    for (const id of selectedCardIds) {
                      await data.deleteCard(id);
                    }
                    notify(`已将 ${count} 条记录移入回收站`);
                    setSelectedCardIds(new Set());
                    setBatchMode(false);
                  }
                }}
              >
                <Trash size={18} />
                <span>删除</span>
              </button>
            </div>
          </div>
        ) : null}

        {/* 底部输入条（非批量模式下显示） */}
        {!batchMode ? (
          <div className="bottom-quick-bar">
            <div className="bottom-quick-bar-left" onClick={() => setView({ name: "editor" })}>
              <NotePencil size={20} color="#777" />
              <span className="bottom-quick-bar-text">记录点什么...</span>
            </div>
            <button
              className="bottom-quick-bar-icon"
              title="AI 助手"
              onClick={(e) => {
                e.stopPropagation();
                setView({ name: "assistant" });
              }}
              aria-label="打开 AI 助手"
            >
              <Robot size={22} weight="fill" />
            </button>
          </div>
        ) : null}
      </div>

      {blindBoxOpen ? (
        <BlindBoxModal
          cards={data.cards}
          onClose={() => setBlindBoxOpen(false)}
          onStart={(selected) => {
            setBlindBoxOpen(false);
            setView({ name: "recall", cards: selected, index: 0 });
          }}
          notify={notify}
        />
      ) : null}

      {drawerOpen ? (
        <SideDrawer
          cards={data.cards}
          trashCount={data.trashCards.length}
          collections={data.collections}
          activeCollection={activeCollection}
          settings={data.settings}
          sessionEmail={sessionEmail}
          practiceDates={data.practiceDates}
          onSelectCollection={(id) => { setActiveCollection(id); setDrawerOpen(false); }}
          onAddCollection={() => {
            const name = window.prompt("新集合名称");
            if (name?.trim()) void data.addCollection(name.trim());
          }}
          onTrash={() => { setDrawerOpen(false); setView({ name: "trash" }); }}
          onSettings={() => { setDrawerOpen(false); setSettingsOpen(true); }}
          onAssistant={() => { setDrawerOpen(false); setView({ name: "assistant" }); }}
          onReview={() => { setDrawerOpen(false); setView({ name: "review" }); }}
          onImport={() => { setDrawerOpen(false); setView({ name: "importer" }); }}
          onClose={() => setDrawerOpen(false)}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsPanel
          settings={data.settings}
          cardCount={data.cards.length}
          sessionEmail={sessionEmail}
          onClose={() => setSettingsOpen(false)}
          onSave={async (next) => {
            await data.saveSettings(next);
            notify("设置已保存在本地");
          }}
          onAuth={() => setView({ name: "auth" })}
          onSync={async () => {
            try {
              const { activeCount } = await syncCloudData(notify);
              const session = await getSession();
              await data.saveSettings({
                ...data.settings,
                email: session?.user?.email ?? data.settings.email,
                lastSyncedAt: new Date().toISOString(),
              });
              await data.reload();
              void refreshSession();
              notify(`同步完成，云端共 ${activeCount} 张有效卡片`);
            } catch (error) {
              const detail = error instanceof Error ? error.message
                : typeof error === "object" && error ? String((error as { message?: string }).message ?? JSON.stringify(error)) : String(error);
              notify(`同步失败：${detail.slice(0, 120)}`);
            }
          }}
          onExport={() => void downloadExport().then(() => notify("完整数据已导出"))}
          onSignOut={async () => { await signOut(); void refreshSession(); notify("已退出云端账号，本地数据仍保留"); }}
        />
      ) : null}

      {view.name === "editor" ? (
        <CardEditor
          card={activeCard}
          collections={data.collections}
          categories={data.categories}
          onCancel={() => setView({ name: "home" })}
          onSave={async (card) => {
            try {
              const userExplicitTitle = card.title?.trim() && !isAutoOrGenericTitle(card.title) ? card.title.trim() : "";
              const tempTitle = userExplicitTitle || deriveAutoTitle(card.body);
              const saved = await data.saveCard({ ...card, title: userExplicitTitle || tempTitle });
              setTransientCard(saved);
              setView({ name: "detail", cardId: saved.id });

              const rawProvider = (await db.settings.get("settings"))?.provider || getLocalFallbackSettings()?.provider || data.settings?.provider;
              const hasApiKey = Boolean(rawProvider?.apiKey?.trim());
              const canUseAi = hasApiKey || Boolean(rawProvider?.enabled) || (Boolean(getSupabase()) && Boolean(await getSession()));

              if (canUseAi) {
                try {
                  const cardProcessing: OioCard = { ...saved, ai: { ...saved.ai, status: "processing" } };
                  await data.saveCard(cardProcessing);
                  setTransientCard(cardProcessing);
                  const cardToProcess: OioCard = { ...saved, title: userExplicitTitle, tasks: saved.tasks };
                  const ai = await processCardWithAI(cardToProcess);
                  let finalCard: OioCard = { ...saved, ai, updatedAt: new Date().toISOString() };
                  const aiChineseTitle = (ai.suggestedTitle?.trim() && hasChineseText(ai.suggestedTitle))
                    ? ai.suggestedTitle.trim()
                    : (ai.chineseMeaning?.trim() && hasChineseText(ai.chineseMeaning)
                      ? ai.chineseMeaning.trim().slice(0, 16)
                      : tempTitle);
                  finalCard.title = userExplicitTitle || aiChineseTitle;
                  const folder = ai.suggestedFolder?.trim();
                  if (folder && folder !== "生活集") {
                    const existing = data.collections.find((item) => item.name === folder);
                    if (existing) {
                      finalCard = { ...finalCard, collectionId: existing.id };
                    } else {
                      const collectionId = makeId("collection");
                      await db.collections.put({ id: collectionId, name: folder, createdAt: new Date().toISOString() });
                      finalCard = { ...finalCard, collectionId };
                    }
                    setActiveCollection(finalCard.collectionId);
                  }
                  const updatedSaved = await data.saveCard(finalCard);
                  setTransientCard(updatedSaved);
                  await data.recordAiUsage(ai);
                  notify(folder && folder !== "生活集" ? `AI 分析完成，已归入「${folder}」` : "AI 已完成整理与主题提炼");
                } catch (error) {
                  console.warn("AI error:", error);
                  notify(error instanceof Error ? error.message : "AI 整理失败，请点右上角💡重试");
                }
              } else {
                notify("卡片已保存在本地（填入 API Key 即可开启 AI 自动整理）");
              }
            } catch (err) {
              console.error("Save card error:", err);
              notify("保存失败，请重试");
            }
          }}
        />
      ) : null}

      {view.name === "detail" && activeCard ? (
        <CardDetail
          card={activeCard}
          allCards={data.cards}
          initialPractice={view.practice}
          onBack={() => setView({ name: "home" })}
          onEdit={() => setView({ name: "editor", cardId: activeCard.id })}
          onOpenCard={(id) => setView({ name: "detail", cardId: id })}
          onPractice={(cardId: string, mode: PracticeMode, correct: boolean) => void recordPractice(cardId, mode, correct)}
          onUpdateCard={async (next) => {
            const res = await data.saveCard(next);
            setTransientCard(res);
          }}
          onRegenerate={async () => {
            try {
              const hasCustomTitle = Boolean(activeCard.title?.trim() && !isAutoOrGenericTitle(activeCard.title));
              const processingCard: OioCard = { ...activeCard, ai: { ...activeCard.ai, status: "processing" } };
              await data.saveCard(processingCard);
              setTransientCard(processingCard);
              const ai = await processCardWithAI({ ...activeCard, title: hasCustomTitle ? activeCard.title : "", tasks: activeCard.tasks, ai: { ...activeCard.ai, contentHash: undefined } });
              let finalCard: OioCard = { ...activeCard, ai, updatedAt: new Date().toISOString() };
              const aiChineseTitle = (ai.suggestedTitle?.trim() && hasChineseText(ai.suggestedTitle))
                ? ai.suggestedTitle.trim()
                : (ai.chineseMeaning?.trim() && hasChineseText(ai.chineseMeaning)
                  ? ai.chineseMeaning.trim().slice(0, 16)
                  : deriveAutoTitle(finalCard.body));
              finalCard.title = hasCustomTitle ? activeCard.title : aiChineseTitle;
              const res = await data.saveCard(finalCard);
              setTransientCard(res);
              await data.recordAiUsage(ai);
              notify("已完成主题提炼与地道改写");
            } catch (error) {
              notify(error instanceof Error ? error.message : "AI 暂不可用");
              const reverted: OioCard = { ...activeCard, ai: { ...activeCard.ai, status: "idle" } };
              await data.saveCard(reverted);
              setTransientCard(reverted);
            }
          }}
          notify={notify}
        />
      ) : null}

      {view.name === "recall" ? (
        <RecallScreen
          cards={view.cards}
          initialIndex={view.index}
          onBack={() => setView({ name: "home" })}
          onEdit={(id) => setView({ name: "editor", cardId: id })}
          notify={notify}
        />
      ) : null}

      {view.name === "trash" ? (
        <TrashScreen
          cards={data.trashCards}
          onBack={() => setView({ name: "home" })}
          onRestore={async (id) => { await data.restoreCard(id); }}
          onPurge={async (id) => { await data.purgeCard(id); }}
          onEmptyTrash={async () => { await data.emptyTrash(); }}
          notify={notify}
        />
      ) : null}

      {view.name === "auth" ? <AuthPanel onClose={() => setView({ name: "home" })} notify={notify} onAuthed={refreshSession} /> : null}

      {view.name === "assistant" ? (
        <AssistantScreen
          aiReady={data.settings.provider.enabled && Boolean(data.settings.provider.apiKey) && Boolean(data.settings.provider.model)}
          onBack={() => setView({ name: "home" })}
          onOpenSettings={() => setSettingsOpen(true)}
          onSaveCard={async (content) => {
            const card = await createContentCard(content);
            notify("已保存为卡片");
            return card;
          }}
          onUsage={(usage) => void data.recordAiUsage(usage)}
          notify={notify}
        />
      ) : null}

      {view.name === "importer" ? (
        <ImporterScreen
          defaultCollection={data.collections.find((item) => item.id === activeCollection)?.name ?? "生活集"}
          onBack={() => setView({ name: "home" })}
          onSave={async (text) => {
            const card = await createContentCard(text);
            notify("语料已导入，点击单词可设为挖空");
            setView({ name: "detail", cardId: card.id });
          }}
        />
      ) : null}

      {view.name === "review" ? <ReviewScreen cards={data.cards} onBack={() => setView({ name: "home" })} onPractice={(cardId, mode, correct) => void recordPractice(cardId, mode, correct)} /> : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}

function LoadingScreen() {
  return <div className="loading-screen"><img src={`${import.meta.env.BASE_URL}oio-icon-192.png`} alt="OIO" /><CircleNotch className="spin" size={24} /><span>正在准备你的表达库…</span></div>;
}

function HomeHeader(props: {
  collection: string; collections: OioCollection[]; activeCollection: string; switcherOpen: boolean;
  onSelectCollection: (id: string) => void; onToggleSwitcher: () => void;
  online: boolean; searchOpen: boolean; query: string;
  onQuery: (value: string) => void; onMenu: () => void; onSearch: () => void;
}) {
  return <header className="home-header">
    <button className="icon-button" onClick={props.onMenu} aria-label="打开侧栏"><List size={22} /></button>
    <button className="collection-switcher" onClick={props.onToggleSwitcher} aria-label="切换集合">{props.collection}<CaretDown size={13} /></button>
    <div className="header-actions">
      <span className={`network-dot ${props.online ? "online" : "offline"}`} title={props.online ? "在线" : "离线"} />
      <button className="icon-button" onClick={props.onSearch} aria-label="搜索"><MagnifyingGlass size={22} /></button>
    </div>
    {props.switcherOpen ? <>
      <div className="menu-backdrop" onClick={props.onToggleSwitcher} />
      <div className="collection-menu" role="menu">
        {props.collections.map((collection) => (
          <button key={collection.id} className={collection.id === props.activeCollection ? "active" : ""} role="menuitem" onClick={() => props.onSelectCollection(collection.id)}>
            {collection.id === props.activeCollection ? <Check size={15} /> : <FolderSimple size={15} />}{collection.name}
          </button>
        ))}
      </div>
    </> : null}
    {props.searchOpen ? <div className="search-box"><MagnifyingGlass size={18} /><input autoFocus value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="搜索标题、原文或英文表达" /><button onClick={() => props.onQuery("")} aria-label="清空搜索"><X size={16} /></button></div> : null}
  </header>;
}

function ReviewStrip({
  onRecent,
  onBlindBox,
  onGame,
}: {
  onRecent: () => void;
  onBlindBox: () => void;
  onGame: () => void;
}) {
  return <nav className="review-strip" aria-label="快速回顾">
    <button onClick={onRecent}>回顾近期</button>
    <button onClick={onBlindBox}>记忆盲盒</button>
    <button onClick={onGame}>记忆游戏</button>
  </nav>;
}

type TimeRange = "week" | "month" | "quarter" | "year" | "all";

function BlindBoxModal(props: {
  cards: OioCard[];
  onClose: () => void;
  onStart: (selectedCards: OioCard[]) => void;
  notify: (msg: string) => void;
}) {
  const [range, setRange] = useState<TimeRange>("quarter");
  const [count, setCount] = useState(5);

  const handleStart = () => {
    const now = Date.now();
    const rangeMs: Record<TimeRange, number> = {
      week: 7 * 86400 * 1000,
      month: 30 * 86400 * 1000,
      quarter: 90 * 86400 * 1000,
      year: 365 * 86400 * 1000,
      all: Infinity,
    };
    const maxAge = rangeMs[range];
    let filtered = props.cards.filter((card) => {
      const cardTime = new Date(card.createdAt).getTime();
      return now - cardTime <= maxAge;
    });

    if (!filtered.length && props.cards.length) {
      filtered = props.cards;
      props.notify("所选时间段暂无卡片，已自动为你从全部卡片中抽取");
    } else if (!filtered.length) {
      props.notify("卡片库暂无卡片，先记录一张吧");
      return;
    }

    const shuffled = [...filtered].sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, count);
    props.onStart(selected);
  };

  return (
    <div className="modal-overlay" onClick={props.onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>记忆盲盒</h2>
          <button className="modal-close" onClick={props.onClose} aria-label="关闭"><X size={18} /></button>
        </header>

        <label style={{ fontSize: "14px", color: "#666", fontWeight: 600 }}>时间范围</label>
        <div className="segmented-pills">
          <button className={range === "week" ? "active" : ""} onClick={() => setRange("week")}>本周</button>
          <button className={range === "month" ? "active" : ""} onClick={() => setRange("month")}>本月</button>
          <button className={range === "quarter" ? "active" : ""} onClick={() => setRange("quarter")}>本季度</button>
          <button className={range === "year" ? "active" : ""} onClick={() => setRange("year")}>本年</button>
          <button className={range === "all" ? "active" : ""} onClick={() => setRange("all")}>全部</button>
        </div>

        <div className="slider-wrap">
          <div className="slider-header">
            <span>卡片数量</span>
            <strong>{count}</strong>
          </div>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="slider-input"
          />
          <div className="slider-ticks">
            <span>1</span>
            <span>10</span>
          </div>
        </div>

        <footer className="modal-footer">
          <button className="primary-button" onClick={handleStart}>开始回忆</button>
        </footer>
      </div>
    </div>
  );
}

function RecallScreen(props: {
  cards: OioCard[];
  initialIndex?: number;
  onBack: () => void;
  onEdit: (cardId: string) => void;
  notify: (msg: string) => void;
}) {
  const [index, setIndex] = useState(props.initialIndex ?? 0);
  const [collapsed, setCollapsed] = useState({ record: false, rewrite: false });
  const [practiceMode, setPracticeMode] = useState<PracticeMode | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const touchStartX = useRef<number | null>(null);

  const card = props.cards[index];
  const total = props.cards.length;

  const handleNext = () => {
    if (index < total - 1) {
      setIndex((i) => i + 1);
      setPracticeMode(undefined);
    }
  };

  const handlePrev = () => {
    if (index > 0) {
      setIndex((i) => i - 1);
      setPracticeMode(undefined);
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const diff = e.changedTouches[0].clientX - touchStartX.current;
    if (diff < -50) handleNext();
    if (diff > 50) handlePrev();
    touchStartX.current = null;
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") handlePrev();
      else if (e.key === "ArrowRight") handleNext();
      else if (e.key === "Escape") props.onBack();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [index, total, props.onBack]);

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    props.notify("已复制");
  };

  if (!card) return null;

  const sentences = card.ai.rewrittenSentences.length ? card.ai.rewrittenSentences : (card.body ? [card.body] : []);
  const blanks = card.ai.practiceKeywords || [];
  const cloze = clozeSentence(sentences.join(" "), blanks);
  const recall = recallPromptOf(card);
  const helper = hasChineseText(card.body) ? card.body : (card.ai.chineseMeaning?.trim() || "");

  return (
    <div className="recall-screen" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      <header className="recall-header">
        <button className="icon-button" onClick={props.onBack} aria-label="返回">
          <ArrowLeft size={22} />
        </button>
        <span className="recall-progress">{index + 1} / {total}</span>
        <div style={{ justifySelf: "end", position: "relative" }}>
          <button className="icon-button" onClick={() => setMenuOpen((o) => !o)} aria-label="更多">
            <DotsThree size={24} weight="bold" />
          </button>
          {menuOpen ? (
            <>
              <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="row-menu" style={{ right: 0, top: 42 }}>
                <button onClick={() => { setMenuOpen(false); props.onEdit(card.id); }}>
                  <NotePencil size={16} />编辑卡片
                </button>
                <button onClick={() => { setMenuOpen(false); void copy(`${card.title}\n${card.body}\n${sentences.join("\n")}`); }}>
                  <Copy size={16} />复制全部
                </button>
              </div>
            </>
          ) : null}
        </div>
      </header>

      {index > 0 ? (
        <button className="floating-flip-nav left" onClick={handlePrev} aria-label="上一张">
          <ArrowLeft size={18} />
        </button>
      ) : null}

      {index < total - 1 ? (
        <button className="floating-flip-nav right" onClick={handleNext} aria-label="下一张">
          <ArrowRight size={18} />
        </button>
      ) : null}

      <main className="recall-main">
        <article className="recall-card">
          <div className="recall-card-header">
            <h1>{card.title || "未命名卡片"}</h1>
            <span>{formatFullDate(card.createdAt)} · {formatTime(card.createdAt)}</span>
          </div>

          <section className="recall-section">
            <div className="recall-section-head" onClick={() => setCollapsed((c) => ({ ...c, record: !c.record }))}>
              <span>我的记录</span>
              {collapsed.record ? <CaretDown size={14} /> : <CaretUp size={14} />}
            </div>
            {!collapsed.record ? (
              <div style={{ display: "flex", flexDirection: "column" }}>
                <p className="recall-body-text">{card.body || "（无文字记录）"}</p>
                <button className="recall-copy-btn" onClick={() => void copy(card.body)}>
                  <Copy size={15} />复制
                </button>
              </div>
            ) : null}
          </section>

          {sentences.length ? (
            <section className="recall-section">
              <div className="recall-section-head" onClick={() => setCollapsed((c) => ({ ...c, rewrite: !c.rewrite }))}>
                <span>目标语言改写</span>
                {collapsed.rewrite ? <CaretDown size={14} /> : <CaretUp size={14} />}
              </div>
              {!collapsed.rewrite ? (
                <>
                  {practiceMode ? (
                    <PracticeArea
                      key={practiceMode}
                      mode={practiceMode}
                      sentence={sentences.join(" ")}
                      blanks={blanks}
                      keywordMeta={card.ai.keywordMeta ?? []}
                      recall={recall}
                      helper={helper}
                      legacy={cloze}
                      onPractice={(_mode, _correct) => {}}
                      notify={props.notify}
                    />
                  ) : (
                    <>
                      {sentences.map((sentence) => (
                        <div className="sentence-row" key={sentence}>
                          <p style={{ margin: "6px 0", fontSize: "16.5px", lineHeight: 1.6 }}>{sentence}</p>
                          <button onClick={() => speak(sentence)} aria-label="朗读本句">
                            <Play size={18} weight="fill" />
                          </button>
                        </div>
                      ))}
                      {card.ai.keywordMeta?.length ? (
                        <details className="practice-helper" style={{ marginTop: 8 }}>
                          <summary>表达解析（为什么这样说更地道）</summary>
                          {card.ai.keywordMeta.map((meta) => (
                            <p key={meta.phrase}><strong>{meta.phrase}</strong> — {meta.explanation}</p>
                          ))}
                        </details>
                      ) : null}
                    </>
                  )}
                </>
              ) : null}
            </section>
          ) : null}
        </article>
      </main>

      <footer className="recall-bottom-bar">
        <button className="recall-finish-btn" onClick={props.onBack}>
          结束回忆 <Check size={18} weight="bold" />
        </button>
        <div className="recall-tool-strip">
          <button title="切换改写显示" onClick={() => setCollapsed((c) => ({ ...c, rewrite: !c.rewrite }))}>
            <ArrowsLeftRight size={20} />
          </button>
          <button title="听力朗读" onClick={() => { if (sentences.length) speak(sentences.join(" ")); }}>
            <Ear size={20} />
          </button>
          <button title="查看原文" onClick={() => setCollapsed((c) => ({ ...c, record: !c.record }))}>
            <Eye size={20} />
          </button>
          <button
            className={practiceMode === "cloze" ? "active" : ""}
            title="挖空练习"
            onClick={() => setPracticeMode((m) => (m === "cloze" ? undefined : "cloze"))}
          >
            <span style={{ fontWeight: 700, fontSize: "14px" }}>填</span>
          </button>
          <button
            className={practiceMode === "choice" ? "active" : ""}
            title="选择题"
            onClick={() => setPracticeMode((m) => (m === "choice" ? undefined : "choice"))}
          >
            <span style={{ fontWeight: 700, fontSize: "14px" }}>选</span>
          </button>
          <button title="朗读全部" onClick={() => { if (sentences.length) speak(sentences.join(" ")); }}>
            <Play size={20} weight="fill" />
          </button>
        </div>
      </footer>
    </div>
  );
}

function TrashScreen(props: {
  cards: OioCard[];
  onBack: () => void;
  onRestore: (id: string) => Promise<void>;
  onPurge: (id: string) => Promise<void>;
  onEmptyTrash: () => Promise<void>;
  notify: (msg: string) => void;
}) {
  return (
    <div className="full-screen trash-screen">
      <header className="screen-header">
        <button className="icon-button" onClick={props.onBack} aria-label="返回">
          <ArrowLeft size={22} />
        </button>
        <h1>回收站 ({props.cards.length})</h1>
        {props.cards.length ? (
          <button
            className="text-button"
            style={{ justifySelf: "end", color: "var(--danger)", fontWeight: 600 }}
            onClick={() => {
              if (window.confirm("确定要清空回收站吗？清空后所有已删除卡片将无法恢复。")) {
                void props.onEmptyTrash().then(() => props.notify("回收站已清空"));
              }
            }}
          >
            清空
          </button>
        ) : <div />}
      </header>

      <main className="trash-list">
        {props.cards.length ? (
          props.cards.map((card) => (
            <article key={card.id} className="trash-item">
              <div className="trash-item-info">
                <h3>{card.title || card.body.slice(0, 20) || "未命名卡片"}</h3>
                <p>{card.body || cardPreview(card)}</p>
                <span>删除时间：{card.deletedAt ? formatFullDate(card.deletedAt) : "未知"}</span>
              </div>
              <div className="trash-item-actions">
                <button
                  className="trash-restore-btn"
                  onClick={() => {
                    void props.onRestore(card.id).then(() => props.notify("卡片已恢复"));
                  }}
                >
                  恢复
                </button>
                <button
                  className="trash-purge-btn"
                  onClick={() => {
                    if (window.confirm("确定永久删除此卡片吗？")) {
                      void props.onPurge(card.id).then(() => props.notify("已彻底删除"));
                    }
                  }}
                >
                  <Trash size={16} />
                </button>
              </div>
            </article>
          ))
        ) : (
          <div className="empty-state">
            <Trash size={44} style={{ color: "#aaa" }} />
            <h2>回收站为空</h2>
            <p>删除的卡片会暂存在这里，支持随时恢复或彻底清空。</p>
          </div>
        )}
      </main>
    </div>
  );
}

function CardRow({
  card,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onOpen,
  onEdit,
  onDelete,
  batchMode,
  selected,
  onToggleSelect,
}: {
  card: OioCard;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  batchMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const aiTitle = card.ai?.suggestedTitle?.trim();
  const hasValidAiTitle = Boolean(aiTitle && hasChineseText(aiTitle) && !isAutoOrGenericTitle(aiTitle));
  const hasUserCustomTitle = Boolean(card.title?.trim() && !isAutoOrGenericTitle(card.title));
  const rowTitle = hasValidAiTitle
    ? aiTitle!
    : (hasUserCustomTitle
      ? card.title.trim()
      : (aiTitle && hasChineseText(aiTitle)
        ? aiTitle
        : (card.ai?.chineseMeaning?.trim() && hasChineseText(card.ai.chineseMeaning)
          ? card.ai.chineseMeaning.trim().slice(0, 16)
          : card.title?.trim() || deriveAutoTitle(card.body))));

  return (
    <article
      className={`card-row ${batchMode ? "in-batch" : ""} ${selected ? "selected" : ""}`}
      onClick={batchMode ? onToggleSelect : onOpen}
    >
      {batchMode ? (
        <div
          className={`batch-checkbox ${selected ? "checked" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect?.();
          }}
        >
          {selected ? <Check size={14} weight="bold" /> : null}
        </div>
      ) : null}
      <div className="card-row-copy">
        <h2>{rowTitle}</h2>
        <p>{cardPreview(card)}</p>
        <span>{formatCardStamp(card.createdAt)} {card.syncState === "pending" ? "· 待同步" : ""}</span>
      </div>
      {!batchMode ? (
        <div className="row-menu-wrap">
          <button className="more-button" aria-label="卡片菜单" onClick={(event) => { event.stopPropagation(); onToggleMenu(); }}>•••</button>
          {menuOpen ? <>
            <div className="menu-backdrop" onClick={(event) => { event.stopPropagation(); onCloseMenu(); }} />
            <div className="row-menu">
              <button onClick={(event) => { event.stopPropagation(); onCloseMenu(); onEdit(); }}><NotePencil size={16} />编辑</button>
              <button className="danger" onClick={(event) => { event.stopPropagation(); onCloseMenu(); onDelete(); }}><Trash size={16} />删除</button>
            </div>
          </> : null}
        </div>
      ) : null}
    </article>
  );
}

function formatCardStamp(iso: string) {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = formatTime(iso);
  if (isSameLocalDay(iso, now)) return `今天 · ${time}`;
  if (isSameLocalDay(iso, yesterday)) return `昨天 · ${time}`;
  const date = new Date(iso);
  return `${date.getMonth() + 1}月${date.getDate()}日 · ${time}`;
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return <div className="empty-state"><Sparkle size={34} /><h2>从今天想说的一句话开始</h2><p>真实生活，就是最容易记住的英文素材。</p><button className="primary-button" onClick={onAdd}><Plus size={18} />新增第一张卡片</button></div>;
}

function SideDrawer(props: {
  cards: OioCard[]; trashCount: number; collections: OioCollection[]; activeCollection: string; settings: UserSettings; sessionEmail: string | null; practiceDates: string[];
  onSelectCollection: (id: string) => void; onAddCollection: () => void; onTrash: () => void; onSettings: () => void;
  onAssistant: () => void; onReview: () => void; onImport: () => void; onClose: () => void;
}) {
  const activityDays = new Set(props.cards.map((card) => card.createdAt.slice(0, 10))).size;
  const streak = computeStreak([...props.cards.map((card) => card.createdAt.slice(0, 10)), ...props.practiceDates]);
  return <div className="overlay" onMouseDown={props.onClose}><aside className="side-drawer" onMouseDown={(event) => event.stopPropagation()}>
    <div className="profile-row"><img src={`${import.meta.env.BASE_URL}oio-icon-192.png`} alt="个人 OIO 图标" /><div><strong>{props.settings.displayName}</strong><span>{props.sessionEmail ?? "未登录 · 数据在本机"}</span></div><button className="icon-button" onClick={props.onSettings}><Gear size={22} /></button></div>
    <div className="stats">
      <div><strong>🔥 {streak}</strong><span>连续天数</span></div>
      <div><strong>{props.cards.length}</strong><span>生活瞬间</span></div>
      <div><strong>{activityDays}</strong><span>记录天数</span></div>
    </div>
    <ActivityGrid cards={props.cards} practiceDates={props.practiceDates} />
    <button className="drawer-link accent" onClick={props.onAssistant}><Brain size={21} />AI 助手<span>{props.settings.provider.enabled ? "Beta" : "待配置"}</span></button>
    <button className="drawer-link" onClick={props.onTrash}><Trash size={21} />回收站<span>{props.trashCount}</span></button>
    <button className="drawer-link" onClick={props.onReview}><Clock size={21} />回忆</button>
    <button className="drawer-link" onClick={props.onImport}><ClipboardText size={21} />导入语料</button>
    <div className="drawer-section-title">收藏夹</div>
    <div className="drawer-collection-head"><span><CaretDown size={15} />集合</span><button onClick={props.onAddCollection} aria-label="新增集合"><Plus size={20} /></button></div>
    {props.collections.map((collection) => (
      <button key={collection.id} className={`collection-item ${collection.id === props.activeCollection ? "active" : ""}`} onClick={() => props.onSelectCollection(collection.id)}>
        <FolderSimple size={18} />{collection.name}
        <span className="count">{props.cards.filter((card) => card.collectionId === collection.id).length}</span>
      </button>
    ))}
    <div className="drawer-footer"><button onClick={props.onClose}><X size={18} />关闭</button></div>
  </aside></div>;
}

function ActivityGrid({ cards, practiceDates }: { cards: OioCard[]; practiceDates: string[] }) {
  const counts = new Map<string, number>();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  cards.forEach((card) => bump(dayKeyOf(new Date(card.createdAt))));
  practiceDates.forEach((key) => bump(key));
  const today = new Date();
  const cells = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (41 - index));
    const key = dayKeyOf(date);
    const count = counts.get(key) ?? 0;
    return { key, level: count === 0 ? "" : count === 1 ? "active" : "hot" };
  });
  const activeDays = cells.filter((cell) => cell.level).length;
  return <div className="activity-wrap"><div className="activity-grid" aria-label={`最近 42 天有 ${activeDays} 天活跃`}>{cells.map((cell) => <i key={cell.key} className={cell.level} />)}</div></div>;
}

const CardEditor = memo(function CardEditor(props: { card?: OioCard; collections: OioCollection[]; categories: OioCategory[]; onCancel: () => void; onSave: (card: OioCard) => Promise<void> }) {
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const countSpanRef = useRef<HTMLSpanElement>(null);
  const [collectionId, setCollectionId] = useState(props.card?.collectionId ?? props.collections[0]?.id ?? "life");
  const [categoryId] = useState(props.card?.categoryId ?? "uncategorized");
  const [tasks, setTasks] = useState<AITask[]>(props.card ? (props.card.tasks ?? ["organize"]) : ["organize"]);
  const [attachments, setAttachments] = useState(props.card?.attachments ?? []);
  const [recording, setRecording] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [saving, setSaving] = useState(false);
  const recognitionRef = useRef<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const syncBodyStats = () => {
    const val = bodyRef.current?.value ?? "";
    if (countSpanRef.current) {
      countSpanRef.current.textContent = `${val.length}/5000`;
    }
  };

  const toggleTask = (task: AITask) => setTasks((current) => current.includes(task) ? current.filter((item) => item !== task) : [...current, task]);
  
  const submit = async () => {
    if (saving) return;
    const rawBody = bodyRef.current?.value ?? "";
    const trimmed = rawBody.trim();
    if (!trimmed) {
      bodyRef.current?.focus();
      return;
    }
    setSaving(true);
    const now = new Date().toISOString();
    const cleanTitle = (titleRef.current?.value ?? "").trim();
    const cardId = props.card?.id ?? makeId("card");
    try {
      await props.onSave({
        id: cardId,
        collectionId,
        categoryId,
        title: cleanTitle,
        body: trimmed,
        tasks,
        attachments,
        ai: props.card && props.card.body === trimmed ? props.card.ai : emptyAI,
        createdAt: props.card?.createdAt ?? now,
        updatedAt: now,
        syncState: "pending",
      });
    } catch (e) {
      console.error("submit failed", e);
    } finally {
      setSaving(false);
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const next = await Promise.all(Array.from(files).slice(0, 4).map(compressImage));
    setAttachments((current) => [...current, ...next].slice(0, 4));
  };

  const toggleDictation = () => {
    const SpeechRecognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      window.alert("当前浏览器未开放网页语音识别接口。手机端或电脑端推荐直接点击键盘自带的麦克风（如 iPhone 键盘右下角麦克风）进行实时语音输入。");
      return;
    }

    if (recording) {
      try {
        recognitionRef.current?.stop();
      } catch {}
      setRecording(false);
      setInterimText("");
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = "zh-CN";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setRecording(true);
        setInterimText("");
      };

      recognition.onresult = (event: any) => {
        let finalTranscript = "";
        let currentInterim = "";

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += transcript;
          } else {
            currentInterim += transcript;
          }
        }

        if (finalTranscript && bodyRef.current) {
          const prev = bodyRef.current.value;
          bodyRef.current.value = `${prev ? prev + (prev.endsWith("\n") || prev.endsWith(" ") ? "" : " ") : ""}${finalTranscript}`;
          syncBodyStats();
        }
        setInterimText(currentInterim);
      };

      recognition.onerror = (event: any) => {
        console.warn("Speech recognition error:", event.error);
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          window.alert("未获取到麦克风权限。请在浏览器地址栏左侧允许麦克风权限，或直接使用系统键盘上的语音麦克风。");
        }
        setRecording(false);
        setInterimText("");
      };

      recognition.onend = () => {
        setRecording(false);
        setInterimText("");
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      console.error("Failed to start speech recognition:", err);
      setRecording(false);
      window.alert("无法启动语音识别，建议直接点击键盘自带的麦克风输入。");
    }
  };

  return <div className="full-screen editor-screen">
    <header className="screen-header"><button className="icon-button" onClick={props.onCancel}><X size={28} /></button><h1>{props.card ? "编辑卡片" : "新增卡片"}</h1><span /></header>
    <div className="editor-meta"><label><FolderSimple size={18} /><select value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>{props.collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select></label><span>{props.categories.find((category) => category.id === categoryId)?.name ?? "未分类"}<CaretRight size={16} /></span></div>
    <div className="editor-body">
      {recording ? <div className="recording-status-banner"><span className="recording-dot" /> 正在倾听中… {interimText ? `「${interimText}」` : "请说话"}（点击麦克风结束）</div> : null}
      <input ref={titleRef} className="title-input" defaultValue={props.card?.title ?? ""} placeholder="标题（留空自动由 AI 提炼中文主题）" />
      <textarea ref={bodyRef} autoFocus defaultValue={props.card?.body ?? ""} onInput={syncBodyStats} placeholder="记录此刻想说的事……" />
      {attachments.length ? <div className="attachment-grid">{attachments.map((attachment) => <figure key={attachment.id}><img src={attachment.dataUrl} alt={attachment.name} /><button onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}><X size={15} /></button></figure>)}</div> : null}
    </div>
    <div className="task-options">
      <TaskToggle checked={tasks.includes("organize")} label="原始输入整理" onClick={() => toggleTask("organize")} />
      <TaskToggle checked={tasks.includes("reply")} label="目标语言回复" onClick={() => toggleTask("reply")} />
      <TaskToggle checked={tasks.includes("rewrite")} label="目标语言改写" onClick={() => toggleTask("rewrite")} />
    </div>
    <footer className="editor-footer"><div className="media-actions"><button onClick={() => fileRef.current?.click()} aria-label="选择图片"><FileImage size={21} /></button><button onClick={() => cameraRef.current?.click()} aria-label="拍照"><Camera size={21} /></button><button className={recording ? "recording" : ""} onClick={toggleDictation} aria-label={recording ? "停止录音" : "语音输入"}><Microphone size={21} /></button><input ref={fileRef} hidden type="file" accept="image/*" multiple onChange={(event) => void handleFiles(event.target.files)} /><input ref={cameraRef} hidden type="file" accept="image/*" capture="environment" onChange={(event) => void handleFiles(event.target.files)} /></div><span ref={countSpanRef}>{props.card?.body?.length ?? 0}/5000</span><button type="button" className="primary-button" onClick={() => void submit()}>{saving ? "保存中…" : "完成"}</button></footer>
  </div>;
});

function TaskToggle({ checked, label, onClick }: { checked: boolean; label: string; onClick: () => void }) {
  return <button className={checked ? "checked" : ""} onClick={onClick}><span>{checked ? <Check size={12} weight="bold" /> : null}</span>{label}</button>;
}

const PRACTICE_TITLES: Record<PracticeMode, string> = {
  reveal: "互译回忆",
  listen: "听力复述",
  cloze: "挖空练习",
  choice: "选择填空",
};

function CardDetail(props: { card: OioCard; allCards: OioCard[]; initialPractice?: PracticeMode; onBack: () => void; onEdit: () => void; onOpenCard: (id: string) => void; onPractice: (cardId: string, mode: PracticeMode, correct: boolean) => void; onUpdateCard: (next: OioCard) => Promise<void>; onRegenerate: () => Promise<void>; notify: (message: string) => void }) {
  const [practice, setPractice] = useState<PracticeMode | undefined>(props.initialPractice);
  const [collapsed, setCollapsed] = useState({ original: false, rewrite: false, reply: false });

  // 核心：若卡片尚未经过 AI 整理（不论新建还是老卡片），一旦打开详情页自动触发 AI 整理
  const autoTriggeredRef = useRef<string | null>(null);
  useEffect(() => {
    const isUnprocessed = !props.card.ai || props.card.ai.status !== "ready";
    if (isUnprocessed && props.card.ai?.status !== "processing" && autoTriggeredRef.current !== props.card.id && props.card.body.trim()) {
      autoTriggeredRef.current = props.card.id;
      void props.onRegenerate();
    }
  }, [props.card.id, props.card.ai?.status, props.card.body, props.onRegenerate]);

  const isProcessing = props.card.ai?.status === "processing";
  const hasRewriteTask = props.card.tasks.includes("rewrite");
  const hasReplyTask = props.card.tasks.includes("reply");
  const sentences = props.card.ai.rewrittenSentences.length ? props.card.ai.rewrittenSentences : [props.card.body];
  const blanks = props.card.ai.practiceKeywords;
  const cloze = clozeSentence(sentences.join(" "), blanks);
  const recall = recallPromptOf(props.card);
  const related = useMemo(() => relatedCards(props.card, props.allCards), [props.card, props.allCards]);
  const copy = async (text: string) => { await navigator.clipboard.writeText(text); props.notify("已复制"); };

  const toggleBlank = (word: string) => {
    const next = toggleWordInList(blanks, word);
    void props.onUpdateCard({ ...props.card, ai: { ...props.card.ai, practiceKeywords: next }, updatedAt: new Date().toISOString() });
  };
  const removePhrase = (phrase: string) => {
    const next = blanks.filter((item) => normalizeWord(item) !== normalizeWord(phrase));
    void props.onUpdateCard({ ...props.card, ai: { ...props.card.ai, practiceKeywords: next }, updatedAt: new Date().toISOString() });
  };
  const togglePractice = (mode: PracticeMode) => setPractice((current) => (current === mode ? undefined : mode));
  // 练习期间的中文提示：中文原文或 AI 中文释义（英文卡且无释义时不提供，避免泄底）
  const helper = hasChineseText(props.card.body) ? props.card.body : (props.card.ai.chineseMeaning?.trim() || "");
  const aiTitle = props.card.ai?.suggestedTitle?.trim();
  const hasValidAiTitle = Boolean(aiTitle && hasChineseText(aiTitle) && !isAutoOrGenericTitle(aiTitle));
  const hasUserCustomTitle = Boolean(props.card.title?.trim() && !isAutoOrGenericTitle(props.card.title));
  const cardTitle = isProcessing
    ? "正在提炼主题…"
    : (hasValidAiTitle
      ? aiTitle!
      : (hasUserCustomTitle
        ? props.card.title.trim()
        : (aiTitle && hasChineseText(aiTitle)
          ? aiTitle
          : (props.card.ai?.chineseMeaning?.trim() && hasChineseText(props.card.ai.chineseMeaning)
            ? props.card.ai.chineseMeaning.trim().slice(0, 16)
            : props.card.title?.trim() || deriveAutoTitle(props.card.body)))));

  return <div className="full-screen detail-screen">
    <header className="detail-header"><button className="icon-button" onClick={props.onBack} aria-label="返回"><ArrowLeft size={22} /></button><div><button className="icon-button accent" onClick={() => void props.onRegenerate()} title="重新生成 AI 内容" aria-label="重新生成 AI 内容"><Lightbulb size={20} /></button><button className="icon-button" onClick={props.onEdit} aria-label="编辑卡片"><NotePencil size={21} /></button></div></header>
    <article className="detail-card">
      <div className="detail-title"><h1>{cardTitle}</h1><span>{formatFullDate(props.card.createdAt)} · {formatTime(props.card.createdAt)} {isProcessing ? "· 🤖 AI 正在整理中…" : ""}</span></div>
      {practice ? null : (
        <DetailSection title="我的记录" collapsed={collapsed.original} onToggle={() => setCollapsed((value) => ({ ...value, original: !value.original }))}>
          <div className="sentence-row">
            <p className="card-source-text">{props.card.body}</p>
            {hasChineseText(props.card.body) ? null : <button onClick={() => speak(props.card.body)} aria-label="朗读原文"><Play size={18} weight="fill" /></button>}
          </div>
          <button className="section-copy" onClick={() => void copy(props.card.body)}><Copy size={17} />复制原文</button>
        </DetailSection>
      )}
      {hasRewriteTask ? (
        <DetailSection title={practice ? PRACTICE_TITLES[practice] : (props.card.ai.rewrittenSentences.length ? "目标语言改写" : "改写与练习")} collapsed={collapsed.rewrite} onToggle={() => setCollapsed((value) => ({ ...value, rewrite: !value.rewrite }))}>
          {practice ? (
            <PracticeArea key={practice} mode={practice} sentence={sentences.join(" ")} blanks={blanks} keywordMeta={props.card.ai.keywordMeta ?? []} recall={recall} helper={helper} legacy={cloze} onPractice={(mode, correct) => props.onPractice(props.card.id, mode, correct)} notify={props.notify} />
          ) : (
            <>
          {sentences.map((sentence) => <div className="sentence-row" key={sentence}><SentenceTokens sentence={sentence} blanks={blanks} onToggleWord={toggleBlank} onRemovePhrase={removePhrase} /><button onClick={() => speak(sentence)} aria-label="朗读本句"><Play size={18} weight="fill" /></button></div>)}
          <p className="blank-hint">点击句子里的单词设为挖空词，再从底部选择练习方式。</p>
          {props.card.ai.keywordMeta?.length ? (
            <details className="practice-helper">
              <summary>表达解析（为什么这样说更地道）</summary>
              {props.card.ai.keywordMeta.map((meta) => <p key={meta.phrase}><strong>{meta.phrase}</strong> — {meta.explanation}</p>)}
            </details>
          ) : null}
          <button className="section-copy" onClick={() => void copy(sentences.join(" "))}><Copy size={17} />复制全部</button>
            </>
          )}
        </DetailSection>
      ) : null}
      {practice ? null : (hasReplyTask ? (
        <DetailSection title="回复" collapsed={collapsed.reply} onToggle={() => setCollapsed((value) => ({ ...value, reply: !value.reply }))}>
          <div className="sentence-row"><p>{isProcessing ? "正在生成地道回复…" : (props.card.ai.reply || "连接 AI 后，这里会给出自然的目标语言回复。")}</p>{props.card.ai.reply ? <button onClick={() => speak(props.card.ai.reply)} aria-label="朗读回复"><Play size={18} weight="fill" /></button> : null}</div>
          {props.card.ai.reply ? <button className="section-copy" onClick={() => void copy(props.card.ai.reply)}><Copy size={17} />复制回复</button> : null}
        </DetailSection>
      ) : null)}
    </article>

    {practice ? null : (related.length ? <section className="related-section">
      <h3>相关记录</h3>
      {related.map((item) => <button key={item.id} className="related-item" onClick={() => props.onOpenCard(item.id)}>
        <strong>{item.title || item.body.slice(0, 20)}</strong>
        <span>{cardPreview(item)}</span>
      </button>)}
    </section> : null)}

    {hasRewriteTask ? (
      <nav className="practice-nav">
        <button className={practice === "reveal" ? "active" : ""} onClick={() => togglePractice("reveal")}><ArrowsLeftRight size={21} /><span>互译</span></button>
        <button className={practice === "listen" ? "active" : ""} onClick={() => togglePractice("listen")}><Ear size={21} /><span>听</span></button>
        <button className={practice === "cloze" ? "active" : ""} onClick={() => togglePractice("cloze")}><BookOpenText size={21} /><span>填</span></button>
        <button className={practice === "choice" ? "active" : ""} onClick={() => togglePractice("choice")}><Check size={21} /><span>选</span></button>
        <button onClick={() => speak(sentences.join(" "))}><Play size={21} weight="fill" /><span>播放</span></button>
      </nav>
    ) : null}
  </div>;
}

function PracticeArea({ mode, sentence, blanks, keywordMeta, recall, helper, legacy, onPractice, notify }: {
  mode: PracticeMode; sentence: string; blanks: string[]; keywordMeta: KeywordMeta[];
  recall: { prompt: string; kind: "chinese" | "hint" };
  helper: string; legacy: { prompt: string; answer: string };
  onPractice: (mode: PracticeMode, correct: boolean) => void;
  notify: (message: string) => void;
}) {
  const [showAnswer, setShowAnswer] = useState(false);
  const [legacyAnswer, setLegacyAnswer] = useState("");

  if (mode === "reveal") {
    return <div className="practice-area">
      <Eye size={28} />
      <h3 className="practice-title">{recall.kind === "chinese" ? "看中文，说英文" : "看提示，说英文"}</h3>
      <p className="practice-prompt">{recall.prompt}</p>
      {recall.kind === "hint" ? <p className="practice-hint">这张卡的原文是英文，凭提示先自己说一遍，再对照。</p> : null}
      <button className="primary-button" onClick={() => { setShowAnswer((value) => !value); if (!showAnswer) onPractice("reveal", true); }}>{showAnswer ? "隐藏答案" : "显示答案"}</button>
      {showAnswer ? <div className="practice-answer-full">{sentence}</div> : null}
    </div>;
  }
  if (mode === "listen") {
    return <div className="practice-area">
      <Ear size={28} />
      <h3 className="practice-title">先听，再试着复述</h3>
      <button className="primary-button" onClick={() => speak(sentence)}><SpeakerHigh size={18} />播放英文</button>
      <button className="text-button" onClick={() => setShowAnswer((value) => !value)}>{showAnswer ? "隐藏原句" : "查看原句"}</button>
      {showAnswer ? <div className="practice-answer-full">{sentence}</div> : null}
    </div>;
  }
  if (mode === "cloze") {
    if (!blanks.length) {
      return <div className="practice-area">
        <BookOpenText size={28} />
        <h3 className="practice-title">填回缺失的表达</h3>
        <p className="practice-prompt">{legacy.prompt}</p>
        <input className="cloze-input" value={legacyAnswer} onChange={(event) => setLegacyAnswer(event.target.value)} placeholder="输入缺失内容" />
        <button className="primary-button" onClick={() => { setShowAnswer(true); onPractice("cloze", legacyAnswer.trim().toLowerCase() === legacy.answer.toLowerCase()); }}>检查答案</button>
        {showAnswer ? <strong className={legacyAnswer.trim().toLowerCase() === legacy.answer.toLowerCase() ? "correct-answer" : "practice-answer"}>答案：{legacy.answer || "暂无可挖空词"}</strong> : null}
      </div>;
    }
    return <div className="practice-area">
      <BookOpenText size={28} />
      <h3 className="practice-title">填回挖空的表达</h3>
      <ClozeFillInline sentence={sentence} words={blanks} onPractice={onPractice} />
      <PracticeHelper helper={helper} />
    </div>;
  }
  if (!blanks.length) {
    return <div className="practice-area">
      <Check size={28} />
      <h3 className="practice-title">选出缺失的表达</h3>
      <ChoiceFillInline sentence={sentence} words={legacy.answer ? [legacy.answer] : []} keywordMeta={[]} notify={notify} onPractice={onPractice} />
    </div>;
  }
  return <div className="practice-area">
    <Check size={28} />
    <h3 className="practice-title">选出空缺处的表达</h3>
    <ChoiceFillInline sentence={sentence} words={blanks} keywordMeta={keywordMeta} notify={notify} onPractice={onPractice} />
    <PracticeHelper helper={helper} />
  </div>;
}

function PracticeHelper({ helper }: { helper: string }) {
  if (!helper) return null;
  return <details className="practice-helper">
    <summary>查看中文提示</summary>
    <p>{helper}</p>
  </details>;
}

function SentenceTokens({ sentence, blanks, onToggleWord, onRemovePhrase }: { sentence: string; blanks: string[]; onToggleWord: (word: string) => void; onRemovePhrase: (phrase: string) => void }) {
  const segments = useMemo(() => splitClozeSegments(sentence, blanks), [sentence, blanks]);
  return <p className="sentence-tokens">
    {segments.map((segment, segmentIndex) => segment.type === "text"
      ? segment.value.split(/\s+/).filter(Boolean).map((token, wordIndex) => (
          <span key={`${segmentIndex}-${wordIndex}`}><button className="word-token" title="点击设为挖空" onClick={() => onToggleWord(token)}>{token}</button>{" "}</span>
        ))
      : <span key={`b-${segmentIndex}`}><button className="word-token active" title="点击取消挖空" onClick={() => onRemovePhrase(segment.value)}>{segment.value}</button>{" "}</span>)}
  </p>;
}

function ClozeFillInline({ sentence, words, onPractice }: { sentence: string; words: string[]; onPractice?: (mode: PracticeMode, correct: boolean) => void }) {
  const segments = useMemo(() => splitClozeSegments(sentence, words), [sentence, words]);
  const withIndex = useMemo(() => {
    let blankIndex = -1;
    return segments.map((segment) => segment.type === "blank" ? { ...segment, blankIndex: (blankIndex += 1) } : { ...segment, blankIndex: -1 });
  }, [segments]);
  const blankCount = withIndex.filter((segment) => segment.type === "blank").length;
  const [inputs, setInputs] = useState<string[]>(() => (blankCount ? new Array(blankCount).fill("") : []));
  const [checked, setChecked] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [score, setScore] = useState<{ correct: number; total: number } | null>(null);

  if (!blankCount) {
    return <p className="practice-hint">这张卡还没有挖空词：点底部「选」退出练习后，在句子里点击单词或短语即可设置。</p>;
  }

  const check = () => {
    let correct = 0;
    withIndex.forEach((segment) => {
      if (segment.type === "blank" && normalizeWord(inputs[segment.blankIndex] ?? "") === normalizeWord(segment.value)) correct += 1;
    });
    setScore({ correct, total: blankCount });
    setChecked(true);
    onPractice?.("cloze", correct === blankCount);
  };
  const reset = () => { setInputs(new Array(blankCount).fill("")); setChecked(false); setRevealed(false); setScore(null); };

  return <>
    <p className="cloze-sentence">
      {withIndex.map((segment, index) => segment.type === "text"
        ? <span key={index}>{segment.value}</span>
        : <span key={index} className={`cloze-blank-wrap ${checked ? (normalizeWord(inputs[segment.blankIndex]) === normalizeWord(segment.value) ? "ok" : "bad") : ""}`}>
            <input
              className="cloze-blank"
              style={{ width: `${Math.max(segment.value.length, 4)}ch` }}
              value={revealed ? segment.value : inputs[segment.blankIndex] ?? ""}
              disabled={checked || revealed}
              onChange={(event) => setInputs((current) => { const next = [...current]; next[segment.blankIndex] = event.target.value; return next; })}
              onKeyDown={(event) => { if (event.key === "Enter" && !checked) check(); }}
            />
          </span>)}
    </p>
    {checked && score ? <strong className={score.correct === score.total ? "correct-answer" : "practice-answer"}>对了 {score.correct} / {score.total} 个空</strong> : null}
    {!checked && !revealed ? <button className="primary-button" onClick={check}>检查答案</button> : null}
    {!revealed ? <button className="text-button" onClick={() => setRevealed(true)}>显示答案</button> : null}
    {checked || revealed ? <button className="text-button" onClick={reset}>再练一次</button> : null}
  </>;
}

function DetailSection({ title, collapsed, onToggle, children }: { title: string; collapsed: boolean; onToggle: () => void; children: React.ReactNode }) {
  return <section className="detail-section"><button className="section-heading" onClick={onToggle}><span>{title}</span><CaretDown className={collapsed ? "collapsed" : ""} size={18} /></button>{collapsed ? null : <div className="section-content">{children}</div>}</section>;
}

function ChoiceFillInline({ sentence, words, keywordMeta, notify, onPractice }: { sentence: string; words: string[]; keywordMeta: KeywordMeta[]; notify: (message: string) => void; onPractice?: (mode: PracticeMode, correct: boolean) => void }) {
  const segments = useMemo(() => splitClozeSegments(sentence, words), [sentence, words]);
  const blankSegs = useMemo(() => segments.map((segment, segIndex) => ({ ...segment, segIndex })).filter((segment) => segment.type === "blank"), [segments]);
  const [step, setStep] = useState(0);
  const [solved, setSolved] = useState<Set<number>>(() => new Set());
  const [wrongPick, setWrongPick] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);
  const done = step >= blankSegs.length;
  const current = done ? null : blankSegs[step];

  const options = useMemo(() => {
    if (!current) return [];
    const meta = keywordMeta.find((item) => normalizeWord(item.phrase) === normalizeWord(current.value));
    const aiDistractors = meta?.distractors ?? [];
    const pool = [...new Set([...aiDistractors, ...words, "really", "interesting", "beautiful", "comfortable", "wonderful", "yesterday"])]
      .filter((word) => normalizeWord(word) !== normalizeWord(current.value) && normalizeWord(word));
    return [current.value, ...pool.sort(() => Math.random() - 0.5).slice(0, 3)].sort(() => Math.random() - 0.5);
  }, [current?.segIndex, current?.value, words, keywordMeta]);

  const pick = (option: string) => {
    if (!current) return;
    if (normalizeWord(option) === normalizeWord(current.value)) {
      setSolved((previous) => new Set(previous).add(current.segIndex));
      setStep((value) => value + 1);
      setWrongPick(null);
      const meta = keywordMeta.find((item) => normalizeWord(item.phrase) === normalizeWord(current.value));
      setExplanation(meta?.explanation || null);
      onPractice?.("choice", true);
      notify("选对了，已填入句子！");
    } else {
      setWrongPick(option);
      notify("不对，再想一想");
    }
  };

  return <>
    <p className="cloze-sentence">
      {segments.map((segment, index) => segment.type === "text"
        ? <span key={index}>{segment.value}</span>
        : solved.has(index)
          ? <span key={index} className="blank-filled">{segment.value}</span>
          : <span key={index} className={`blank-gap ${current && current.segIndex === index ? "active" : ""}`}>……</span>)}
    </p>
    {explanation ? <p className="choice-explanation">💡 {explanation}</p> : null}
    {done ? <strong className="correct-answer">全部选对，这句你已经牢牢记住了！</strong> : <>
      <p className="choice-label">请选择空缺处的最佳表达：</p>
      <div className="choice-grid">
        {options.map((option) => <button key={option} className={wrongPick === option ? "wrong" : ""} onClick={() => pick(option)}>{option}</button>)}
      </div>
    </>}
  </>;
}

function SettingsPanel(props: {
  settings: UserSettings; cardCount: number; sessionEmail: string | null; onClose: () => void; onSave: (settings: UserSettings) => Promise<void>;
  onAuth: () => void; onSync: () => Promise<void>; onExport: () => void; onSignOut: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(props.settings);
  const [busy, setBusy] = useState(false);
  const [pendingCount, setPendingCount] = useState<number | null>(null);

  useEffect(() => { void db.syncQueue.count().then(setPendingCount); }, [props.settings.lastSyncedAt]);
  const total = draft.monthlyInputTokens + draft.monthlyOutputTokens;
  const updateProvider = (patch: Partial<UserSettings["provider"]>) => setDraft((value) => ({ ...value, provider: { ...value.provider, ...patch } }));
  const save = async () => {
    setBusy(true);
    try {
      const updatedSettings: UserSettings = {
        ...draft,
        provider: {
          ...draft.provider,
          hasStoredKey: draft.provider.hasStoredKey || Boolean(draft.provider.apiKey),
        },
      };
      await props.onSave(updatedSettings);
      const session = await getSession();
      if (session) {
        await saveCloudSettings(updatedSettings);
      }
      props.onClose();
    } finally { setBusy(false); }
  };
  return <div className="overlay settings-overlay" onMouseDown={props.onClose}><section className="settings-panel" onMouseDown={(event) => event.stopPropagation()}>
    <header><button className="icon-button" onClick={props.onClose}><CaretDown size={26} /></button><h1>我的 OIO</h1><button className="text-button" onClick={() => void save()}>{busy ? "保存中" : "保存"}</button></header>
    <div className="settings-scroll">
      <div className="profile-row settings-profile"><img src={`${import.meta.env.BASE_URL}oio-icon-192.png`} alt="OIO 个人图标" /><div><input value={draft.displayName} onChange={(event) => setDraft((value) => ({ ...value, displayName: event.target.value }))} /><span className={props.sessionEmail ? "session-on" : undefined}>{props.sessionEmail ? `已登录 · ${props.sessionEmail}` : cloudConfigured ? "未登录，数据仅保存在本机" : "本地模式"}</span></div><span className="mode-badge">{props.sessionEmail ? "已连接云端" : "个人版"}</span></div>
      <SettingsGroup title="用量"><div className="usage-title"><span>本月 Token 用量</span><strong>{total.toLocaleString()}</strong></div><div className="usage-bar"><i style={{ width: `${Math.min(total / 2000, 100)}%` }} /></div><p>输入 {draft.monthlyInputTokens.toLocaleString()} · 输出 {draft.monthlyOutputTokens.toLocaleString()}，由 AI 处理自动累计，每月 1 日 00:00 刷新</p></SettingsGroup>
      <SettingsGroup title="AI 模型设置">
        <div className="provider-preset-pills">
          <button
            type="button"
            className={`preset-pill ${draft.provider.providerName === "DeepSeek" || draft.provider.baseUrl.includes("deepseek") ? "active" : ""}`}
            onClick={() => updateProvider({ providerName: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: draft.provider.model && draft.provider.model !== "gpt-4o-mini" ? draft.provider.model : "deepseek-chat" })}
          >
            DeepSeek (推荐)
          </button>
          <button
            type="button"
            className={`preset-pill ${draft.provider.providerName === "OpenAI" || draft.provider.baseUrl.includes("openai") ? "active" : ""}`}
            onClick={() => updateProvider({ providerName: "OpenAI", baseUrl: "https://api.openai.com/v1", model: draft.provider.model && draft.provider.model !== "deepseek-chat" ? draft.provider.model : "gpt-4o-mini" })}
          >
            OpenAI
          </button>
          <button
            type="button"
            className={`preset-pill ${draft.provider.providerName === "Kimi" || draft.provider.baseUrl.includes("moonshot") ? "active" : ""}`}
            onClick={() => updateProvider({ providerName: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" })}
          >
            Kimi (月之暗面)
          </button>
          <button
            type="button"
            className={`preset-pill ${draft.provider.providerName === "智谱 GLM" || draft.provider.baseUrl.includes("bigmodel") ? "active" : ""}`}
            onClick={() => updateProvider({ providerName: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" })}
          >
            智谱 GLM
          </button>
          <button
            type="button"
            className={`preset-pill ${draft.provider.providerName === "通义千问" || draft.provider.baseUrl.includes("aliyuncs") ? "active" : ""}`}
            onClick={() => updateProvider({ providerName: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" })}
          >
            通义千问
          </button>
        </div>
        <div className="form-grid">
          <label>服务商<input value={draft.provider.providerName} onChange={(event) => updateProvider({ providerName: event.target.value })} /></label>
          <label>Base URL<input list="oio-provider-urls" value={draft.provider.baseUrl} onChange={(event) => updateProvider({ baseUrl: event.target.value })} /><datalist id="oio-provider-urls"><option value="https://api.deepseek.com/v1">DeepSeek</option><option value="https://api.openai.com/v1">OpenAI</option><option value="https://api.moonshot.cn/v1">Kimi</option><option value="https://open.bigmodel.cn/api/paas/v4">智谱 GLM</option><option value="https://dashscope.aliyuncs.com/compatible-mode/v1">通义千问</option></datalist></label>
          <label>模型名<input value={draft.provider.model} onChange={(event) => updateProvider({ model: event.target.value })} placeholder="例如 deepseek-chat、gpt-4o-mini" /></label>
          <label>API Key<input type="password" value={draft.provider.apiKey ?? ""} onChange={(event) => updateProvider({ apiKey: event.target.value })} placeholder={draft.provider.apiKey ? "已保存在本机，留空不修改" : "粘贴你的 API Key"} /></label>
        </div>
        <label className="switch-row"><span><strong>启用真实 AI</strong><small>打开后新建卡片会自动改写、回复和纠错</small></span><input type="checkbox" checked={draft.provider.enabled} onChange={(event) => updateProvider({ enabled: event.target.checked })} /></label>
        <p className="settings-note">AI 设置与 API Key 会在本地持久化双重备份，并自动同步到你的云端账号。电脑端配置后手机端自动生效，网页更新也不会丢失。</p>
      </SettingsGroup>
      <SettingsGroup title="语言"><div className="form-grid"><label>界面语言<select value={draft.interfaceLanguage} onChange={(event) => setDraft((value) => ({ ...value, interfaceLanguage: event.target.value as UserSettings["interfaceLanguage"] }))}><option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option></select></label><label>目标语言<select value={draft.targetLanguage} onChange={(event) => setDraft((value) => ({ ...value, targetLanguage: event.target.value as UserSettings["targetLanguage"] }))}><option>English</option><option>Japanese</option></select></label><label>熟练度<select value={draft.level} onChange={(event) => setDraft((value) => ({ ...value, level: event.target.value as UserSettings["level"] }))}><option value="beginner">入门</option><option value="intermediate">进阶</option><option value="advanced">熟练</option></select></label></div></SettingsGroup>
      <SettingsGroup title="数据与同步">
        <div className="sync-status">
          <span>上次同步:{props.settings.lastSyncedAt ? `${formatFullDate(props.settings.lastSyncedAt)} ${formatTime(props.settings.lastSyncedAt)}` : "从未同步"}</span>
          <span>{pendingCount == null ? "" : pendingCount > 0 ? `${pendingCount} 条修改待同步` : "没有待同步的修改"}</span>
        </div>
        <div className="settings-actions"><button onClick={props.onAuth}><SignIn size={20} />{props.sessionEmail ? "切换账号" : "邮箱登录"}</button><button onClick={() => void props.onSync()}><CloudArrowUp size={20} />立即同步</button><button onClick={props.onExport}><DownloadSimple size={20} />导出完整数据</button><button onClick={() => void props.onSignOut()}><SignOut size={20} />退出云端账号</button></div>
        <p className="settings-note">{props.sessionEmail ? `已登录 ${props.sessionEmail}。每台设备登录同一账号并同步后，卡片即可保持一致。` : cloudConfigured ? `当前共 ${props.cardCount} 张卡片，仅保存在这台设备的浏览器中；登录后即可多设备同步。` : `当前共 ${props.cardCount} 张卡片。云端未配置时，所有内容只保存在这台设备的浏览器中。`}</p>
      </SettingsGroup>
      <SettingsGroup title="关于"><div className="about-box"><img src={`${import.meta.env.BASE_URL}oio-icon-192.png`} alt="OIO" /><div><strong>OIO</strong><span>Output · Input · Output</span><p>把真实生活练成自己真正会说的英文。</p></div></div></SettingsGroup>
    </div>
  </section></div>;
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="settings-group"><h2>{title}</h2>{children}</section>;
}

function AuthPanel({ onClose, notify, onAuthed }: { onClose: () => void; notify: (message: string) => void; onAuthed?: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!cloudConfigured) return notify("先在 .env.local 配置 Supabase 项目后再登录");
    setBusy(true);
    try {
      if (mode === "signin") {
        await signIn(email, password);
        notify("登录成功");
      } else {
        const result = await signUp(email, password);
        notify(result.session ? "注册成功，已自动登录" : "注册成功，请查收确认邮件后登录");
      }
      onAuthed?.();
      onClose();
    } catch (error) { notify(error instanceof Error ? error.message : "认证失败"); }
    finally { setBusy(false); }
  };
  return <div className="overlay auth-overlay"><section className="auth-panel"><button className="auth-close" onClick={onClose}><X size={20} /></button><img src={`${import.meta.env.BASE_URL}oio-icon-192.png`} alt="OIO" /><h1>{mode === "signin" ? "登录并同步" : "创建个人账号"}</h1><p>{cloudConfigured ? "在 iPhone 与 Mac 之间同步你的表达卡片。" : "当前尚未填写 Supabase 环境变量，离线功能不受影响。"}</p><form onSubmit={(event) => void submit(event)}><label>邮箱<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label>密码<input type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /></label><button className="primary-button" disabled={busy}>{busy ? <CircleNotch className="spin" /> : mode === "signin" ? "登录" : "注册"}</button></form><button className="text-button" onClick={() => setMode((value) => value === "signin" ? "signup" : "signin")}>{mode === "signin" ? "没有账号？创建一个" : "已有账号？直接登录"}</button><button className="text-button" disabled={!email || !cloudConfigured} onClick={() => void resetPassword(email).then(() => notify("重置邮件已发送"))}>忘记密码</button></section></div>;
}

async function compressImage(file: File) {
  const image = await createImageBitmap(file);
  const max = 1440;
  const scale = Math.min(1, max / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.78);
  return { id: makeId("image"), name: file.name, mimeType: "image/jpeg", size: Math.round(dataUrl.length * 0.75), dataUrl };
}

async function downloadExport() {
  const payload = await exportAllData();
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `oio-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

const AssistantInputBar = memo(function AssistantInputBar(props: {
  busy: boolean;
  onSend: (text: string) => void;
}) {
  const [input, setInput] = useState("");
  const isComposingRef = useRef(false);

  const doSend = () => {
    const text = input.trim();
    if (!text || props.busy) return;
    props.onSend(text);
    setInput("");
  };

  return (
    <footer className="assistant-input-bar">
      <div className="assistant-input-container">
        <input
          type="text"
          className="assistant-input-field"
          value={input}
          placeholder="输入中文、英文或中英混合…"
          onChange={(event) => setInput(event.target.value)}
          onCompositionStart={() => { isComposingRef.current = true; }}
          onCompositionEnd={() => { isComposingRef.current = false; }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !isComposingRef.current && !event.nativeEvent.isComposing) {
              event.preventDefault();
              doSend();
            }
          }}
        />
        <button
          type="button"
          className={`assistant-send-btn ${input.trim() ? "active" : ""}`}
          disabled={props.busy || !input.trim()}
          onClick={doSend}
          aria-label="发送"
        >
          {props.busy ? <CircleNotch className="spin" size={18} /> : <PaperPlaneRight size={18} weight={input.trim() ? "fill" : "bold"} />}
        </button>
      </div>
    </footer>
  );
});

function AssistantScreen(props: {
  aiReady: boolean; onBack: () => void; onOpenSettings: () => void;
  onSaveCard: (content: string) => Promise<unknown>;
  onUsage: (usage: { inputTokens: number; outputTokens: number }) => void;
  notify: (message: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [messages, busy]);

  const send = useCallback(async (text: string) => {
    const history: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(history);
    setBusy(true);
    try {
      const reply = await askAssistant(history);
      setMessages((current) => [...current, { role: "assistant", content: reply.content }]);
      props.onUsage(reply.usage);
    } catch (error) {
      props.notify(error instanceof Error ? error.message : "AI 暂不可用");
    } finally {
      setBusy(false);
    }
  }, [messages, props]);

  return <div className="full-screen assistant-screen">
    <header className="screen-header"><button className="icon-button" onClick={props.onBack} aria-label="返回"><ArrowLeft size={22} /></button><h1>AI 助手</h1><span /></header>
    <div className="assistant-body" ref={listRef}>
      {!props.aiReady ? <div className="assistant-notice">
        <Brain size={34} />
        <p>AI 助手与你其他 AI 功能共用同一个 API 配置。请先在设置里填写模型名和 API Key，并打开「启用真实 AI」。</p>
        <button className="primary-button" onClick={props.onOpenSettings}>去设置</button>
      </div> : messages.length === 0 && !busy ? <div className="assistant-notice">
        <Brain size={34} />
        <p>随时和我随心聊天、请教地道英文说法或吐槽日常，简短轻松，聊到的好句子一键存为卡片。</p>
      </div> : messages.map((message, index) => (
        <div key={index} className={`chat-message ${message.role}`}>
          <div className="chat-bubble">{message.content}</div>
          {message.role === "assistant" ? <button className="text-button" onClick={() => void props.onSaveCard(message.content).then(() => props.notify("已保存为卡片"))}><Plus size={14} />存为卡片</button> : null}
        </div>
      ))}
      {busy ? <div className="chat-message assistant"><div className="chat-bubble"><CircleNotch className="spin" size={15} /> 正在思考…</div></div> : null}
    </div>
    <AssistantInputBar busy={busy} onSend={send} />
  </div>;
}

function ImporterScreen(props: { defaultCollection: string; onBack: () => void; onSave: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  return <div className="full-screen importer-screen">
    <header className="screen-header"><button className="icon-button" onClick={props.onBack} aria-label="返回"><ArrowLeft size={22} /></button><h1>导入语料</h1><span /></header>
    <div className="importer-body">
      <p className="importer-hint">粘贴一段英文语料（{props.defaultCollection}），导入后点击句子中的单词设为挖空，反复练习主动回忆。</p>
      <textarea
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value.slice(0, 5000))}
        placeholder="Paste any English text here…"
      />
      <div className="importer-footer">
        <span>{text.length}/5000</span>
        <button className="primary-button" disabled={!text.trim()} onClick={() => void props.onSave(text)}>导入并开始练习</button>
      </div>
    </div>
  </div>;
}

interface GameQuestion {
  id: string;
  cardId: string;
  fullSentence: string;
  prefix: string;
  blank: string;
  suffix: string;
  options: string[];
  explanation: string;
  chineseHint: string;
}

function ReviewScreen(props: {
  cards: OioCard[];
  onBack: () => void;
  onPractice?: (cardId: string, mode: PracticeMode, correct: boolean) => void;
}) {
  // 1. 根据科学记忆原理：从用户卡片提取所有挖空词块与语境
  const questions: GameQuestion[] = useMemo(() => {
    const list: GameQuestion[] = [];
    const allKeywords = new Set<string>();

    for (const card of props.cards) {
      for (const kw of card.ai.practiceKeywords || []) {
        if (kw.trim()) allKeywords.add(kw.trim());
      }
    }

    const keywordPool = Array.from(allKeywords);
    // 基础语境干扰词库（确保即使卡片少也有充足候选项）
    const fallbackDistractors = [
      "take it easy", "make sense", "figure out", "catch up", "look forward to",
      "give up", "hang out", "break through", "get used to", "keep in touch",
      "calm down", "step by step", "by the way", "on the other hand", "come across"
    ];

    for (const card of props.cards) {
      const blanks = card.ai.practiceKeywords || [];
      if (!blanks.length) continue;

      const sentences = card.ai.rewrittenSentences.length ? card.ai.rewrittenSentences : (card.body ? [card.body] : []);
      const chineseHint = hasChineseText(card.body) ? card.body : (card.ai.chineseMeaning || card.title || "");

      for (const blank of blanks) {
        if (!blank.trim()) continue;
        // 找到包含该词的句子
        const targetSentence = sentences.find((s) => s.toLowerCase().includes(blank.toLowerCase())) || sentences[0];
        if (!targetSentence) continue;

        const regex = new RegExp(`(${blank.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i");
        const parts = targetSentence.split(regex);
        let prefix = "";
        let matchedBlank = blank;
        let suffix = "";

        if (parts.length >= 3) {
          prefix = parts[0];
          matchedBlank = parts[1];
          suffix = parts.slice(2).join("");
        } else {
          prefix = "";
          matchedBlank = blank;
          suffix = targetSentence.replace(regex, "");
        }

        // 生成 3 个强干扰项（优先从 AI 高质量迷惑项抽取，再从用户其他卡片与语境库抽取）
        const meta = card.ai.keywordMeta?.find((m) => m.phrase.toLowerCase() === blank.toLowerCase());
        const aiDistractors = (meta?.distractors || []).filter((d) => d.toLowerCase() !== blank.toLowerCase() && d.trim());
        const otherKeywords = keywordPool.filter((k) => k.toLowerCase() !== blank.toLowerCase() && !aiDistractors.includes(k));
        const distractors: string[] = [...aiDistractors];
        const shuffledOthers = [...otherKeywords].sort(() => 0.5 - Math.random());
        for (const item of shuffledOthers) {
          if (distractors.length < 3 && !distractors.includes(item)) distractors.push(item);
        }
        const shuffledFallback = [...fallbackDistractors].sort(() => 0.5 - Math.random());
        for (const fb of shuffledFallback) {
          if (distractors.length < 3 && fb.toLowerCase() !== blank.toLowerCase() && !distractors.includes(fb)) {
            distractors.push(fb);
          }
        }

        const options = [...distractors, matchedBlank].sort(() => 0.5 - Math.random());
        const explanation = meta ? `${meta.phrase}：${meta.explanation}` : `地道表达「${matchedBlank}」在语境中的正确搭配。`;

        list.push({
          id: `${card.id}-${blank}`,
          cardId: card.id,
          fullSentence: targetSentence,
          prefix,
          blank: matchedBlank,
          suffix,
          options,
          explanation,
          chineseHint,
        });
      }
    }

    return list.sort(() => 0.5 - Math.random());
  }, [props.cards]);

  const [index, setIndex] = useState(0);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [streak, setStreak] = useState(0);
  const [maxStreak, setMaxStreak] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [finished, setFinished] = useState(false);

  const currentQ = questions[index];
  const total = questions.length;

  // 空状态（对标截图设计 100% 还原）
  if (!total) {
    return (
      <div className="full-screen game-screen">
        <header className="game-header">
          <button className="icon-button" onClick={props.onBack} aria-label="关闭">
            <X size={22} />
          </button>
          <h1>记忆游戏</h1>
          <span />
        </header>

        <div className="game-empty-wrap">
          <div className="game-empty-icon">
            <Sparkle size={36} weight="fill" />
          </div>
          <h2>还没有可以开始的挖空</h2>
          <p>去 Card 里长按想记住的词或短语，选择「挖空」，就能在这里开始记忆游戏。</p>
          <button className="game-empty-btn" onClick={props.onBack}>
            回到 Card <ArrowRight size={16} weight="bold" />
          </button>
        </div>
      </div>
    );
  }

  const handleSelect = (opt: string) => {
    if (selectedOption !== null || !currentQ) return;
    setSelectedOption(opt);
    const isCorrect = opt.toLowerCase() === currentQ.blank.toLowerCase();
    props.onPractice?.(currentQ.cardId, "cloze", isCorrect);

    if (isCorrect) {
      const nextStreak = streak + 1;
      setStreak(nextStreak);
      setMaxStreak((m) => Math.max(m, nextStreak));
      setCorrectCount((c) => c + 1);
    } else {
      setStreak(0);
    }
  };

  const handleNext = () => {
    if (index < total - 1) {
      setIndex((i) => i + 1);
      setSelectedOption(null);
    } else {
      setFinished(true);
    }
  };

  const handleRestart = () => {
    setIndex(0);
    setSelectedOption(null);
    setStreak(0);
    setCorrectCount(0);
    setFinished(false);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (selectedOption === null && currentQ) {
        if (e.key === "1" && currentQ.options[0]) handleSelect(currentQ.options[0]);
        else if (e.key === "2" && currentQ.options[1]) handleSelect(currentQ.options[1]);
        else if (e.key === "3" && currentQ.options[2]) handleSelect(currentQ.options[2]);
        else if (e.key === "4" && currentQ.options[3]) handleSelect(currentQ.options[3]);
      } else if (selectedOption !== null && (e.key === "Enter" || e.key === "ArrowRight" || e.key === " ")) {
        handleNext();
      } else if (e.key === "Escape") {
        props.onBack();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedOption, currentQ, index, total, props.onBack]);

  // 结算页
  if (finished) {
    const accuracy = Math.round((correctCount / total) * 100);
    return (
      <div className="full-screen game-screen">
        <header className="game-header">
          <button className="icon-button" onClick={props.onBack} aria-label="关闭">
            <X size={22} />
          </button>
          <h1>游戏结算</h1>
          <span />
        </header>

        <div className="game-summary-wrap">
          <div className="game-summary-badge">
            {accuracy >= 80 ? "🏆" : accuracy >= 60 ? "🌟" : "💪"}
          </div>
          <h2>本次记忆挑战完成！</h2>
          <p>通过语境提取练习，强化了在大脑中建立长期神经回路的效果。</p>

          <div className="game-summary-stats">
            <div className="game-stat-box">
              <strong>{accuracy}%</strong>
              <span>正确率</span>
            </div>
            <div className="game-stat-box">
              <strong>🔥 {maxStreak}</strong>
              <span>最高连对</span>
            </div>
            <div className="game-stat-box">
              <strong>{total}</strong>
              <span>挑战题数</span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
            <button className="primary-button" style={{ width: "100%", height: 46, borderRadius: 23 }} onClick={handleRestart}>
              再来一局
            </button>
            <button className="text-button" onClick={props.onBack}>
              回到 Card
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isAnswered = selectedOption !== null;
  const isCorrect = selectedOption?.toLowerCase() === currentQ.blank.toLowerCase();

  return (
    <div className="full-screen game-screen">
      <header className="game-header">
        <button className="icon-button" onClick={props.onBack} aria-label="退出">
          <X size={22} />
        </button>
        <h1>记忆游戏</h1>
        {streak > 1 ? (
          <span className="game-streak">🔥 {streak} 连对</span>
        ) : (
          <span style={{ fontSize: "14px", color: "#888", fontWeight: 600, justifySelf: "end" }}>
            {index + 1} / {total}
          </span>
        )}
      </header>

      {/* 顶部科学进度条 */}
      <div className="game-progress-line">
        <div className="game-progress-fill" style={{ width: `${((index + 1) / total) * 100}%` }} />
      </div>

      <main className="game-main">
        <article className="game-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="game-prompt-tag">语境挖空 · 主动提取</span>
            <button
              className="icon-button"
              style={{ width: 32, height: 32, color: "#666" }}
              onClick={() => speak(currentQ.fullSentence)}
              title="朗读句子"
              aria-label="朗读本句"
            >
              <SpeakerHigh size={18} />
            </button>
          </div>

          <div className="game-sentence">
            {currentQ.prefix}
            <span
              className={`game-blank-slot ${
                !isAnswered
                  ? "unfilled"
                  : isCorrect
                  ? "correct"
                  : "wrong"
              }`}
            >
              {isAnswered ? currentQ.blank : " ? "}
            </span>
            {currentQ.suffix}
          </div>

          {currentQ.chineseHint ? (
            <div className="game-meaning">
              💡 语境线索：{currentQ.chineseHint}
            </div>
          ) : null}

          {/* 4 选 1 候选词块 */}
          <div className="game-options-grid">
            {currentQ.options.map((opt) => {
              let cls = "game-option-btn";
              if (isAnswered) {
                if (opt.toLowerCase() === currentQ.blank.toLowerCase()) {
                  cls += isCorrect ? " selected-correct" : " missed-correct";
                } else if (opt === selectedOption && !isCorrect) {
                  cls += " selected-wrong";
                }
              }
              return (
                <button
                  key={opt}
                  className={cls}
                  disabled={isAnswered}
                  onClick={() => handleSelect(opt)}
                >
                  {opt}
                </button>
              );
            })}
          </div>

          {/* 即时科学解析反馈 */}
          {isAnswered ? (
            <div className={`game-feedback-box ${isCorrect ? "" : "wrong"}`}>
              <div className="game-feedback-title">
                {isCorrect ? <CheckCircle size={18} weight="fill" /> : <WarningCircle size={18} weight="fill" />}
                {isCorrect ? "回答正确！声学印记已激活" : `正确答案：${currentQ.blank}`}
              </div>
              <p className="game-feedback-desc">{currentQ.explanation}</p>
            </div>
          ) : null}

          {isAnswered ? (
            <div className="game-action-row">
              <button className="primary-button" onClick={handleNext}>
                {index < total - 1 ? "下一题" : "查看结算"} <ArrowRight size={16} />
              </button>
            </div>
          ) : null}
        </article>
      </main>
    </div>
  );
}
