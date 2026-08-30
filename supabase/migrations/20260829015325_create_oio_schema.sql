create extension if not exists pgcrypto;

create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'OIO 用户',
  interface_language text not null default 'zh-CN',
  target_language text not null default 'English',
  proficiency text not null default 'intermediate',
  active_collection_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.collections (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text not null default '#dbeedd',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.categories (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  collection_id text references public.collections(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.cards (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  collection_id text references public.collections(id) on delete set null,
  category_id text references public.categories(id) on delete set null,
  title text not null default '',
  body text not null default '',
  tasks jsonb not null default '[]'::jsonb,
  ai_result jsonb,
  content_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.card_attachments (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id text not null references public.cards(id) on delete cascade,
  kind text not null check (kind in ('image', 'audio')),
  storage_path text,
  local_url text,
  mime_type text,
  byte_size integer,
  width integer,
  height integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.practice_records (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id text not null references public.cards(id) on delete cascade,
  mode text not null,
  correct boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id text references public.cards(id) on delete set null,
  provider text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  total_tokens integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.ai_provider_configs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null default 'OpenAI-compatible',
  base_url text not null,
  model text not null,
  encrypted_api_key text,
  input_price_per_million numeric,
  output_price_per_million numeric,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index cards_user_updated_idx on public.cards(user_id, updated_at desc);
create index collections_user_updated_idx on public.collections(user_id, updated_at desc);
create index categories_user_updated_idx on public.categories(user_id, updated_at desc);
create index attachments_user_card_idx on public.card_attachments(user_id, card_id);
create index practice_user_created_idx on public.practice_records(user_id, created_at desc);
create index ai_usage_user_created_idx on public.ai_usage(user_id, created_at desc);

alter table public.user_settings enable row level security;
alter table public.collections enable row level security;
alter table public.categories enable row level security;
alter table public.cards enable row level security;
alter table public.card_attachments enable row level security;
alter table public.practice_records enable row level security;
alter table public.ai_usage enable row level security;
alter table public.ai_provider_configs enable row level security;

grant select, insert, update, delete on public.user_settings to authenticated;
grant select, insert, update, delete on public.collections to authenticated;
grant select, insert, update, delete on public.categories to authenticated;
grant select, insert, update, delete on public.cards to authenticated;
grant select, insert, update, delete on public.card_attachments to authenticated;
grant select, insert, update, delete on public.practice_records to authenticated;
grant select, insert, update, delete on public.ai_usage to authenticated;
grant select, insert, update, delete on public.ai_provider_configs to authenticated;

create policy "users own settings" on public.user_settings
  for all to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "users own collections" on public.collections
  for all to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "users own categories" on public.categories
  for all to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "users own cards" on public.cards
  for all to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "users own attachments" on public.card_attachments
  for all to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "users own practice" on public.practice_records
  for all to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "users read own usage" on public.ai_usage
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "users own provider config" on public.ai_provider_configs
  for select to authenticated using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('card-images', 'card-images', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "users read own card images" on storage.objects
  for select to authenticated
  using (bucket_id = 'card-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "users upload own card images" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'card-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "users update own card images" on storage.objects
  for update to authenticated
  using (bucket_id = 'card-images' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'card-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "users delete own card images" on storage.objects
  for delete to authenticated
  using (bucket_id = 'card-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
