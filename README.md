# OIO

OIO（Output → Input → Output）是一款个人英语表达训练 PWA。它把生活记录整理成自然英文，再通过回复、纠错、朗读和练习形成闭环。当前版本可直接离线使用；Supabase 与 AI 都是可选增强，不配置也不会影响本地记录。

## 已完成

- 桌面与手机响应式首页、集合侧栏、搜索、今日/昨日/随机回顾
- 新增与编辑卡片、分类、图片压缩附件、免费语音输入回退
- 自然改写（一段输入对应一句改写）与 AI 回复的结果页面
- 系统免费朗读、听力、原文切换、挖空、选择和连续播放
- IndexedDB 离线缓存、同步队列、软删除、完整 JSON 导出
- 邮箱注册、登录、验证、重置、退出的 Supabase 接口
- OpenAI-compatible 服务商配置与本地密钥保存
- Token 统计、内容哈希缓存、PWA 安装和离线资源缓存

## 本地运行

```bash
npm install
npm run dev -- --host 0.0.0.0 --port 4173 --strictPort
```

浏览器打开 `http://localhost:4173`。生产检查运行：

```bash
npm run check
```

## 后续接入 Supabase

1. 创建 Supabase 免费项目。
2. 复制 `.env.example` 为 `.env.local`，填写项目 URL 和 Publishable Key。
3. 关联项目并执行数据库迁移：

```bash
npx supabase login
npx supabase link --project-ref 你的项目编号
npx supabase db push
```

4. 为 Edge Function 设置至少 24 位随机加密密钥并部署：

```bash
npx supabase secrets set AI_CONFIG_ENCRYPTION_KEY="请换成足够长的随机字符串"
npx supabase functions deploy save-provider
npx supabase functions deploy process-card
```

5. 在 Supabase Auth 中设置站点地址和允许跳转地址。数据库迁移已包含全部 RLS 与 Storage 策略，每个账户只能访问自己的数据。

## 后续接入 AI

登录后进入“我的”，填写服务商名称、Base URL、模型和 API Key。支持 OpenAI、DeepSeek 及其他提供 `/chat/completions` 的 OpenAI-compatible 服务。API Key 只通过 `save-provider` 发送到服务端并以 AES-GCM 加密保存；浏览器本地不会保存提交后的明文。

ChatGPT Plus 会员与 OpenAI API 账单相互独立，Plus 不能直接抵扣 API 调用费用。个人使用时可选价格较低的兼容服务，或继续保持纯离线模式。

## 目录

- `src/`：PWA 界面、本地数据库、同步和 AI 客户端
- `supabase/migrations/`：表结构、RLS、Storage 策略
- `supabase/functions/`：API Key 加密保存与卡片 AI 处理
- `tests/`：本地能力和部署 Worker 测试
- `design-qa.md`：视觉验收记录（完成浏览器验收后生成）

## 隐私与成本

- 未配置 Supabase 时，数据仅保存在当前浏览器的 IndexedDB。
- 未配置或未启用 AI 时，不会发送卡片内容，也不会产生 API 成本。
- 系统朗读、浏览器语音识别、搜索、练习、统计和回顾均在本地完成。
- 删除采用软删除；导出的 JSON 可随时带走全部数据。
