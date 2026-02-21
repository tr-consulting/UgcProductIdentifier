create extension if not exists "pgcrypto";

create table if not exists product_analyzers (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  video_name text not null,
  video_path text not null,
  thumbnail_path text,
  report_html text,
  created_at timestamptz not null default now()
);

create table if not exists analyzer_frames (
  id uuid primary key default gen_random_uuid(),
  analyzer_id uuid not null references product_analyzers(id) on delete cascade,
  timestamp_seconds numeric not null,
  bbox jsonb not null,
  image_path text not null,
  created_at timestamptz not null default now()
);

create table if not exists detected_products (
  id uuid primary key default gen_random_uuid(),
  analyzer_frame_id uuid not null references analyzer_frames(id) on delete cascade,
  name text not null,
  description text,
  buy_url text,
  buy_links jsonb not null default '[]'::jsonb,
  is_purchased boolean not null default false,
  user_comment text,
  created_at timestamptz not null default now()
);

alter table product_analyzers add column if not exists report_html text;
alter table detected_products add column if not exists buy_links jsonb not null default '[]'::jsonb;

create index if not exists analyzer_frames_analyzer_id_idx on analyzer_frames(analyzer_id);
create index if not exists detected_products_analyzer_frame_id_idx on detected_products(analyzer_frame_id);

-- MVP policies: allow anon client writes/reads.
-- Tighten these when you add authentication and per-user ownership.
alter table product_analyzers enable row level security;
alter table analyzer_frames enable row level security;
alter table detected_products enable row level security;

drop policy if exists "anon_full_product_analyzers" on product_analyzers;
create policy "anon_full_product_analyzers"
on product_analyzers
for all
to anon
using (true)
with check (true);

drop policy if exists "anon_full_analyzer_frames" on analyzer_frames;
create policy "anon_full_analyzer_frames"
on analyzer_frames
for all
to anon
using (true)
with check (true);

drop policy if exists "anon_full_detected_products" on detected_products;
create policy "anon_full_detected_products"
on detected_products
for all
to anon
using (true)
with check (true);

drop policy if exists "anon_storage_video_select" on storage.objects;
create policy "anon_storage_video_select"
on storage.objects
for select
to anon
using (bucket_id = 'product-videos');

drop policy if exists "anon_storage_video_insert" on storage.objects;
create policy "anon_storage_video_insert"
on storage.objects
for insert
to anon
with check (bucket_id = 'product-videos');

drop policy if exists "anon_storage_video_update" on storage.objects;
create policy "anon_storage_video_update"
on storage.objects
for update
to anon
using (bucket_id = 'product-videos')
with check (bucket_id = 'product-videos');

drop policy if exists "anon_storage_video_delete" on storage.objects;
create policy "anon_storage_video_delete"
on storage.objects
for delete
to anon
using (bucket_id = 'product-videos');

drop policy if exists "anon_storage_frames_select" on storage.objects;
create policy "anon_storage_frames_select"
on storage.objects
for select
to anon
using (bucket_id = 'product-frames');

drop policy if exists "anon_storage_frames_insert" on storage.objects;
create policy "anon_storage_frames_insert"
on storage.objects
for insert
to anon
with check (bucket_id = 'product-frames');

drop policy if exists "anon_storage_frames_update" on storage.objects;
create policy "anon_storage_frames_update"
on storage.objects
for update
to anon
using (bucket_id = 'product-frames')
with check (bucket_id = 'product-frames');

drop policy if exists "anon_storage_frames_delete" on storage.objects;
create policy "anon_storage_frames_delete"
on storage.objects
for delete
to anon
using (bucket_id = 'product-frames');
