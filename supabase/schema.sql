create extension if not exists "pgcrypto";

create table if not exists product_analyzers (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  video_name text not null,
  video_path text not null,
  thumbnail_path text,
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
  is_purchased boolean not null default false,
  user_comment text,
  created_at timestamptz not null default now()
);

create index if not exists analyzer_frames_analyzer_id_idx on analyzer_frames(analyzer_id);
create index if not exists detected_products_analyzer_frame_id_idx on detected_products(analyzer_frame_id);
