import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowsLeftRight,
  BookOpenText,
  Brain,
  Camera,
  CaretDown,
  CaretRight,
  Check,
  CheckCircle,
  CircleNotch,
  ClipboardText,
  Clock,
  CloudArrowUp,
  Copy,
  DownloadSimple,
  Ear,
  Eye,
  FileImage,
  FolderSimple,
  Gear,
  House,
  Lightbulb,
  List,
  MagnifyingGlass,
  Microphone,
  NotePencil,
  PaperPlaneRight,
  Play,
  Plus,
  Power,
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
  getSession,
  pushCardToCloud,
  resetPassword,
  saveCloudSettings,
  saveProviderSecurely,
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
  formatFullDate,
  formatTime,
  hasChineseText,
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
  const [collections, setCollections] = useState<OioCollection[]>([]);
  const [categories, setCategories] = useState<OioCategory[]>([]);
  const [settings, setSettings] = useState<UserSettings>(defaultSettings);
  const [practiceDates, setPracticeDates] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  const reload = useCallback(async () => {
    const [nextCards, nextCollections, nextCategories, storedSettings, practiceRecords] = await Promise.all([
      db.cards.toArray(),
      db.collections.toArray(),
      db.categories.toArray(),
      db.settings.get("settings"),
      db.practice.toArray(),
    ]);
    setCards(nextCards.filter((card) => !card.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
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
    await reload();
    void pushCardToCloud(next).catch(() => undefined);
    return next;
  }, [reload]);

  const deleteCard = useCallback(async (id: string) => {
    await db.cards.delete(id);
    await reload();
    void deleteCardOnCloud(id).catch(() => undefined);
  }, [reload]);

  const saveSettings = useCallback(async (next: UserSettings) => {
    await db.settings.put(next);
    await queueSync("settings", "settings", "upsert");
    setSettings(next);
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

  return { cards, collections, categories, settings, practiceDates, ready, reload, saveCard, deleteCard, saveSettings, recordAiUsage, addCollection };
}

export function App() {
  const data = useOioData();
  const [view, setView] = useState<AppView>({ name: "home" });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeCollection, setActiveCollection] = useState("life");
  const [toast, setToast] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

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

  // 实时订阅 Supabase 数据库变更与 WebSocket 广播（跨设备秒级同步）
  useEffect(() => {
    if (!cloudConfigured || !sessionEmail) return;
    const unsubscribe = subscribeToCloudChanges(() => {
      void data.reload();
    });
    return () => {
      unsubscribe();
    };
  }, [data.reload, sessionEmail]);

  // 后台超高频对齐（切回前台、聚焦及 2.5 秒心跳，确保两端绝对一致）
  useEffect(() => {
    if (!cloudConfigured || !sessionEmail || !online) return;

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
  }, [data.reload, online, sessionEmail]);

  const filteredCards = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.cards.filter((card) => card.collectionId === activeCollection && (!needle || `${card.title} ${card.body} ${cardPreview(card)}`.toLowerCase().includes(needle)));
  }, [activeCollection, data.cards, query]);

  const openReview = useCallback((kind: "today" | "yesterday" | "random") => {
    const date = new Date();
    if (kind === "yesterday") date.setDate(date.getDate() - 1);
    const pool = kind === "random" ? data.cards : data.cards.filter((card) => isSameLocalDay(card.createdAt, date));
    const card = pool[Math.floor(Math.random() * pool.length)];
    if (!card) return notify(kind === "yesterday" ? "昨天还没有卡片" : "暂时没有可回顾的卡片");
    setView({ name: "detail", cardId: card.id, practice: "reveal" });
  }, [data.cards, notify]);

  const createContentCard = useCallback(async (content: string) => {
    const trimmed = content.trim();
    const now = new Date().toISOString();
    const card: OioCard = {
      id: makeId("card"),
      collectionId: activeCollection,
      categoryId: "uncategorized",
      title: trimmed.slice(0, 24),
      body: trimmed,
      tasks: [],
      attachments: [],
      ai: { ...emptyAI, status: "ready", organizedSource: trimmed, rewrittenSentences: [trimmed] },
      createdAt: now,
      updatedAt: now,
      syncState: "pending",
    };
    await data.saveCard(card);
    return card;
  }, [activeCollection, data]);

  const recordPractice = useCallback(async (cardId: string, mode: PracticeMode, correct: boolean) => {
    await db.practice.put({ id: makeId("practice"), cardId, mode, correct, createdAt: new Date().toISOString() });
    await data.reload();
  }, [data]);

  if (!data.ready) return <LoadingScreen />;

  const activeCard = view.name === "detail" || view.name === "editor" && view.cardId
    ? data.cards.find((card) => card.id === view.cardId)
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
          onSettings={() => setSettingsOpen(true)}
        />
        <main className="home-main">
          <ReviewStrip onReview={openReview} />
          <section className="card-list" aria-label="卡片列表">
            {filteredCards.length ? filteredCards.map((card) => (
              <CardRow
                key={card.id}
                card={card}
                menuOpen={openMenuId === card.id}
                onToggleMenu={() => setOpenMenuId((current) => (current === card.id ? null : card.id))}
                onCloseMenu={() => setOpenMenuId(null)}
                onOpen={() => { setOpenMenuId(null); setView({ name: "detail", cardId: card.id }); }}
                onEdit={() => { setOpenMenuId(null); setView({ name: "editor", cardId: card.id }); }}
                onDelete={() => { setOpenMenuId(null); void data.deleteCard(card.id).then(() => notify("卡片已删除")); }}
              />
            )) : <EmptyState onAdd={() => setView({ name: "editor" })} />}
          </section>
        </main>
        <button className="floating-add" aria-label="新增卡片" onClick={() => setView({ name: "editor" })}><Plus size={24} /></button>
      </div>

      {drawerOpen ? (
        <SideDrawer
          cards={data.cards}
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
            const saved = await data.saveCard(card);
            setView({ name: "detail", cardId: saved.id });
            if (saved.tasks.length && data.settings.provider.enabled) {
              try {
                await data.saveCard({ ...saved, ai: { ...saved.ai, status: "processing" } });
                const ai = await processCardWithAI(saved);
                let finalCard: OioCard = { ...saved, ai, updatedAt: new Date().toISOString() };
                // 智能归档：AI 建议的专题文件夹不存在则自动创建
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
                await data.saveCard(finalCard);
                await data.recordAiUsage(ai);
                notify(folder && folder !== "生活集" ? `AI 处理完成，已归入「${folder}」` : "AI 处理完成");
              } catch (error) { notify(error instanceof Error ? error.message : "AI 暂不可用"); }
            } else notify("卡片已保存在本地");
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
          onUpdateCard={async (next) => { await data.saveCard(next); }}
          onRegenerate={async () => {
            try {
              await data.saveCard({ ...activeCard, ai: { ...activeCard.ai, status: "processing" } });
              const ai = await processCardWithAI({ ...activeCard, ai: { ...activeCard.ai, contentHash: undefined } });
              await data.saveCard({ ...activeCard, ai, updatedAt: new Date().toISOString() });
              await data.recordAiUsage(ai);
              notify("已重新生成");
            } catch (error) { notify(error instanceof Error ? error.message : "AI 暂不可用"); }
          }}
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
  onQuery: (value: string) => void; onMenu: () => void; onSearch: () => void; onSettings: () => void;
}) {
  return <header className="home-header">
    <button className="icon-button" onClick={props.onMenu} aria-label="打开侧栏"><List size={22} /></button>
    <button className="collection-switcher" onClick={props.onToggleSwitcher} aria-label="切换集合">{props.collection}<CaretDown size={13} /></button>
    <div className="header-actions">
      <span className={`network-dot ${props.online ? "online" : "offline"}`} title={props.online ? "在线" : "离线"} />
      <button className="icon-button accent" onClick={props.onSettings} aria-label="AI 与设置"><Brain size={21} /></button>
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

function ReviewStrip({ onReview }: { onReview: (kind: "today" | "yesterday" | "random") => void }) {
  return <nav className="review-strip" aria-label="快速回顾">
    <button onClick={() => onReview("today")}><House size={16} />回顾今天</button>
    <button onClick={() => onReview("yesterday")}><BookOpenText size={16} />回顾昨天</button>
    <button onClick={() => onReview("random")}><Shuffle size={16} />记忆盲盒</button>
  </nav>;
}

function CardRow({ card, menuOpen, onToggleMenu, onCloseMenu, onOpen, onEdit, onDelete }: { card: OioCard; menuOpen: boolean; onToggleMenu: () => void; onCloseMenu: () => void; onOpen: () => void; onEdit: () => void; onDelete: () => void }) {
  return <article className="card-row" onClick={onOpen}>
    <div className="card-row-copy"><h2>{card.title || card.body.slice(0, 22)}</h2><p>{cardPreview(card)}</p><span>{formatCardStamp(card.createdAt)} {card.syncState === "pending" ? "· 待同步" : ""}</span></div>
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
  </article>;
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
  cards: OioCard[]; collections: OioCollection[]; activeCollection: string; settings: UserSettings; sessionEmail: string | null; practiceDates: string[];
  onSelectCollection: (id: string) => void; onAddCollection: () => void; onSettings: () => void;
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

function CardEditor(props: { card?: OioCard; collections: OioCollection[]; categories: OioCategory[]; onCancel: () => void; onSave: (card: OioCard) => Promise<void> }) {
  const [title, setTitle] = useState(props.card?.title ?? "");
  const [body, setBody] = useState(props.card?.body ?? "");
  const [collectionId, setCollectionId] = useState(props.card?.collectionId ?? props.collections[0]?.id ?? "life");
  const [categoryId] = useState(props.card?.categoryId ?? "uncategorized");
  // 改写为按需选择：新建默认不勾选，由用户针对某一篇笔记手动开启
  const [tasks, setTasks] = useState<AITask[]>(props.card?.tasks ?? []);
  const [attachments, setAttachments] = useState(props.card?.attachments ?? []);
  const [recording, setRecording] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const toggleTask = (task: AITask) => setTasks((current) => current.includes(task) ? current.filter((item) => item !== task) : [...current, task]);
  const submit = async () => {
    if (!body.trim()) return;
    const now = new Date().toISOString();
    await props.onSave({
      id: props.card?.id ?? makeId("card"), collectionId, categoryId, title: title.trim(), body: body.trim(), tasks, attachments,
      ai: props.card && props.card.body === body.trim() ? props.card.ai : emptyAI,
      createdAt: props.card?.createdAt ?? now, updatedAt: now, syncState: "pending",
    });
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const next = await Promise.all(Array.from(files).slice(0, 4).map(compressImage));
    setAttachments((current) => [...current, ...next].slice(0, 4));
  };

  const startDictation = () => {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) return window.alert("当前浏览器暂不支持网页听写，请使用系统键盘上的麦克风。");
    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => setBody((current) => `${current}${current ? " " : ""}${event.results[0][0].transcript}`);
    recognition.onend = () => setRecording(false);
    recognition.onerror = () => setRecording(false);
    setRecording(true);
    recognition.start();
  };

  return <div className="full-screen editor-screen">
    <header className="screen-header"><button className="icon-button" onClick={props.onCancel}><X size={28} /></button><h1>{props.card ? "编辑卡片" : "新增卡片"}</h1><span /></header>
    <div className="editor-meta"><label><FolderSimple size={18} /><select value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>{props.collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select></label><span>{props.categories.find((category) => category.id === categoryId)?.name ?? "未分类"}<CaretRight size={16} /></span></div>
    <div className="editor-body"><input className="title-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="标题（可选）" /><textarea autoFocus value={body} onChange={(event) => setBody(event.target.value.slice(0, 5000))} placeholder="记录此刻想说的事……" />
      {attachments.length ? <div className="attachment-grid">{attachments.map((attachment) => <figure key={attachment.id}><img src={attachment.dataUrl} alt={attachment.name} /><button onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}><X size={15} /></button></figure>)}</div> : null}
    </div>
    <div className="task-options">
      <TaskToggle checked={tasks.includes("organize")} label="原始输入整理" onClick={() => toggleTask("organize")} />
      <TaskToggle checked={tasks.includes("reply")} label="目标语言回复" onClick={() => toggleTask("reply")} />
      <TaskToggle checked={tasks.includes("rewrite")} label="目标语言改写" onClick={() => toggleTask("rewrite")} />
    </div>
    <footer className="editor-footer"><div className="media-actions"><button onClick={() => fileRef.current?.click()} aria-label="选择图片"><FileImage size={21} /></button><button onClick={() => cameraRef.current?.click()} aria-label="拍照"><Camera size={21} /></button><button className={recording ? "recording" : ""} onClick={startDictation} aria-label="语音输入"><Microphone size={21} /></button><input ref={fileRef} hidden type="file" accept="image/*" multiple onChange={(event) => void handleFiles(event.target.files)} /><input ref={cameraRef} hidden type="file" accept="image/*" capture="environment" onChange={(event) => void handleFiles(event.target.files)} /></div><span>{body.length}/5000</span><button className="primary-button" disabled={!body.trim()} onClick={() => void submit()}>完成</button></footer>
  </div>;
}

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
  const [collapsed, setCollapsed] = useState({ rewrite: false, reply: false });
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

  return <div className="full-screen detail-screen">
    <header className="detail-header"><button className="icon-button" onClick={props.onBack} aria-label="返回"><ArrowLeft size={22} /></button><div><button className="icon-button accent" onClick={() => void props.onRegenerate()} title="重新生成 AI 内容" aria-label="重新生成 AI 内容"><Lightbulb size={20} /></button><button className="icon-button" onClick={props.onEdit} aria-label="编辑卡片"><NotePencil size={21} /></button></div></header>
    <article className="detail-card">
      <div className="detail-title"><h1>{props.card.title || "未命名卡片"}</h1><span>{formatFullDate(props.card.createdAt)} · {formatTime(props.card.createdAt)}</span></div>
      <DetailSection title={practice ? PRACTICE_TITLES[practice] : "目标语言改写"} collapsed={collapsed.rewrite} onToggle={() => setCollapsed((value) => ({ ...value, rewrite: !value.rewrite }))}>
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
      {practice ? null : (
        <DetailSection title="回复" collapsed={collapsed.reply} onToggle={() => setCollapsed((value) => ({ ...value, reply: !value.reply }))}>
          <div className="sentence-row"><p>{props.card.ai.reply || "连接 AI 后，这里会给出自然的目标语言回复。"}</p>{props.card.ai.reply ? <button onClick={() => speak(props.card.ai.reply)} aria-label="朗读回复"><Play size={18} weight="fill" /></button> : null}</div>
          {props.card.ai.reply ? <button className="section-copy" onClick={() => void copy(props.card.ai.reply)}><Copy size={17} />复制回复</button> : null}
        </DetailSection>
      )}
    </article>

    {practice ? null : (related.length ? <section className="related-section">
      <h3>相关记录</h3>
      {related.map((item) => <button key={item.id} className="related-item" onClick={() => props.onOpenCard(item.id)}>
        <strong>{item.title || item.body.slice(0, 20)}</strong>
        <span>{cardPreview(item)}</span>
      </button>)}
    </section> : null)}

    <nav className="practice-nav">
      <button className={practice === "reveal" ? "active" : ""} onClick={() => togglePractice("reveal")}><ArrowsLeftRight size={21} /><span>互译</span></button>
      <button className={practice === "listen" ? "active" : ""} onClick={() => togglePractice("listen")}><Ear size={21} /><span>听</span></button>
      <button className={practice === "cloze" ? "active" : ""} onClick={() => togglePractice("cloze")}><BookOpenText size={21} /><span>填</span></button>
      <button className={practice === "choice" ? "active" : ""} onClick={() => togglePractice("choice")}><Check size={21} /><span>选</span></button>
      <button onClick={() => speak(sentences.join(" "))}><Play size={21} weight="fill" /><span>播放</span></button>
    </nav>
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
      await props.onSave({
        ...draft,
        provider: {
          ...draft.provider,
          hasStoredKey: draft.provider.hasStoredKey || Boolean(draft.provider.apiKey),
        },
      });
      const session = await getSession();
      if (session && draft.provider.apiKey) {
        try { await saveProviderSecurely(draft.provider); } catch { /* 云端加密存储未就绪时保持本地保存即可 */ }
      }
      if (session) await saveCloudSettings(draft);
      props.onClose();
    } finally { setBusy(false); }
  };
  return <div className="overlay settings-overlay" onMouseDown={props.onClose}><section className="settings-panel" onMouseDown={(event) => event.stopPropagation()}>
    <header><button className="icon-button" onClick={props.onClose}><CaretDown size={26} /></button><h1>我的 OIO</h1><button className="text-button" onClick={() => void save()}>{busy ? "保存中" : "保存"}</button></header>
    <div className="settings-scroll">
      <div className="profile-row settings-profile"><img src={`${import.meta.env.BASE_URL}oio-icon-192.png`} alt="OIO 个人图标" /><div><input value={draft.displayName} onChange={(event) => setDraft((value) => ({ ...value, displayName: event.target.value }))} /><span className={props.sessionEmail ? "session-on" : undefined}>{props.sessionEmail ? `已登录 · ${props.sessionEmail}` : cloudConfigured ? "未登录，数据仅保存在本机" : "本地模式"}</span></div><span className="mode-badge">{props.sessionEmail ? "已连接云端" : "个人版"}</span></div>
      <SettingsGroup title="用量"><div className="usage-title"><span>本月 Token 用量</span><strong>{total.toLocaleString()}</strong></div><div className="usage-bar"><i style={{ width: `${Math.min(total / 2000, 100)}%` }} /></div><p>输入 {draft.monthlyInputTokens.toLocaleString()} · 输出 {draft.monthlyOutputTokens.toLocaleString()}，由 AI 处理自动累计，每月 1 日 00:00 刷新</p></SettingsGroup>
      <SettingsGroup title="AI 模型设置">
        <div className="form-grid"><label>服务商<input value={draft.provider.providerName} onChange={(event) => updateProvider({ providerName: event.target.value })} /></label><label>Base URL<input list="oio-provider-urls" value={draft.provider.baseUrl} onChange={(event) => updateProvider({ baseUrl: event.target.value })} /><datalist id="oio-provider-urls"><option value="https://api.deepseek.com/v1">DeepSeek</option><option value="https://api.openai.com/v1">OpenAI</option><option value="https://api.moonshot.cn/v1">Kimi</option><option value="https://open.bigmodel.cn/api/paas/v4">智谱 GLM</option><option value="https://dashscope.aliyuncs.com/compatible-mode/v1">通义千问</option></datalist></label><label>模型名<input value={draft.provider.model} onChange={(event) => updateProvider({ model: event.target.value })} placeholder="例如 deepseek-chat、gpt-4o-mini" /></label><label>API Key<input type="password" value={draft.provider.apiKey ?? ""} onChange={(event) => updateProvider({ apiKey: event.target.value })} placeholder={draft.provider.apiKey ? "已保存在本机，留空不修改" : "粘贴你的 API Key"} /></label></div>
        <label className="switch-row"><span><strong>启用真实 AI</strong><small>打开后新建卡片会自动改写、回复和纠错</small></span><input type="checkbox" checked={draft.provider.enabled} onChange={(event) => updateProvider({ enabled: event.target.checked })} /></label>
        <p className="settings-note">AI 请求由浏览器直接发给你填写的服务商；API Key 只保存在这台设备的浏览器里，不会上传。</p>
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

function AssistantScreen(props: {
  aiReady: boolean; onBack: () => void; onOpenSettings: () => void;
  onSaveCard: (content: string) => Promise<unknown>;
  onUsage: (usage: { inputTokens: number; outputTokens: number }) => void;
  notify: (message: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [messages, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const history: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(history);
    setInput("");
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
  };

  return <div className="full-screen assistant-screen">
    <header className="screen-header"><button className="icon-button" onClick={props.onBack} aria-label="返回"><ArrowLeft size={22} /></button><h1>AI 助手</h1><span /></header>
    <div className="assistant-body" ref={listRef}>
      {!props.aiReady ? <div className="assistant-notice">
        <Brain size={34} />
        <p>AI 助手与你其他 AI 功能共用同一个 API 配置。请先在设置里填写模型名和 API Key，并打开「启用真实 AI」。</p>
        <button className="primary-button" onClick={props.onOpenSettings}>去设置</button>
      </div> : messages.length === 0 && !busy ? <div className="assistant-notice">
        <Brain size={34} />
        <p>输入中文、英文或中英混合，我会帮你整理成自然、地道的英文，并讲解关键表达。生成的内容可以一键存为卡片，继续挖空练习。</p>
      </div> : messages.map((message, index) => (
        <div key={index} className={`chat-message ${message.role}`}>
          <div className="chat-bubble">{message.content}</div>
          {message.role === "assistant" ? <button className="text-button" onClick={() => void props.onSaveCard(message.content).then(() => props.notify("已保存为卡片"))}><Plus size={14} />存为卡片</button> : null}
        </div>
      ))}
      {busy ? <div className="chat-message assistant"><div className="chat-bubble"><CircleNotch className="spin" size={15} /> 正在思考…</div></div> : null}
    </div>
    <footer className="assistant-input">
      <textarea
        value={input}
        rows={1}
        placeholder="输入中文、英文或中英混合…"
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
      />
      <button className="primary-button" disabled={busy || !input.trim()} onClick={() => void send()} aria-label="发送"><PaperPlaneRight size={18} /></button>
    </footer>
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

function ReviewScreen(props: { cards: OioCard[]; onBack: () => void; onPractice?: (cardId: string, mode: PracticeMode, correct: boolean) => void }) {
  const shuffle = (cards: OioCard[]) => [...cards].sort(() => Math.random() - 0.5);
  const [pool, setPool] = useState(() => shuffle(props.cards));
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [stats, setStats] = useState({ known: 0, unknown: 0 });

  const restart = () => { setPool(shuffle(props.cards)); setIndex(0); setRevealed(false); setStats({ known: 0, unknown: 0 }); };
  const answer = (known: boolean) => {
    props.onPractice?.(pool[index].id, "reveal", known);
    setStats((current) => ({ known: current.known + (known ? 1 : 0), unknown: current.unknown + (known ? 0 : 1) }));
    setIndex((current) => current + 1);
    setRevealed(false);
  };

  if (!pool.length) return <div className="full-screen review-screen">
    <header className="screen-header"><button className="icon-button" onClick={props.onBack} aria-label="返回"><ArrowLeft size={22} /></button><h1>回忆</h1><span /></header>
    <div className="assistant-notice"><Sparkle size={34} /><p>还没有可回忆的卡片，先去记录一句今天想说的话吧。</p></div>
  </div>;

  if (index >= pool.length) return <div className="full-screen review-screen">
    <header className="screen-header"><button className="icon-button" onClick={props.onBack} aria-label="返回"><ArrowLeft size={22} /></button><h1>回忆完成</h1><span /></header>
    <div className="review-summary">
      <CheckCircle size={40} weight="fill" />
      <h2>本轮回忆了 {pool.length} 张卡片</h2>
      <p>想起来了 {stats.known} 张 · 再看看 {stats.unknown} 张</p>
      <button className="primary-button" onClick={restart}>再来一轮</button>
      <button className="text-button" onClick={props.onBack}>回到首页</button>
    </div>
  </div>;

  const card = pool[index];
  const sentences = card.ai.rewrittenSentences.length ? card.ai.rewrittenSentences : [card.body];
  const recall = recallPromptOf(card);
  return <div className="full-screen review-screen">
    <header className="screen-header"><button className="icon-button" onClick={props.onBack} aria-label="返回"><ArrowLeft size={22} /></button><h1>回忆</h1><span className="review-progress">{index + 1}/{pool.length}</span></header>
    <div className="review-card">
      <p className="review-prompt">{recall.kind === "chinese" ? "还记得这句要怎么表达吗？" : "看提示，回忆完整表达"}</p>
      <h2>{recall.prompt}</h2>
      {recall.kind === "hint" ? <p className="practice-hint">这张卡的原文是英文，凭提示先自己说一遍。</p> : null}
      {revealed ? <>
        <div className="review-answer">{sentences.join(" ")}</div>
        <button className="text-button" onClick={() => speak(sentences.join(" "))}><SpeakerHigh size={15} />朗读</button>
      </> : <button className="primary-button" onClick={() => setRevealed(true)}><Eye size={16} />揭晓答案</button>}
    </div>
    {revealed ? <div className="review-actions">
      <button onClick={() => answer(false)}><WarningCircle size={17} />再看看</button>
      <button className="primary-button" onClick={() => answer(true)}><Check size={16} />想起来了</button>
    </div> : null}
  </div>;
}
