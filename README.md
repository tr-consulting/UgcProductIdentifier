# ProductAnalyzer MVP

Webapp för att:
- ladda upp en video (t.ex. skärminspelning)
- pausa och markera produktområden
- skapa stillbilder från markeringen
- analysera bilder via Azure OpenAI
- generera en HTML-rapport med namn, bild, beskrivning, köplänk, köpt-checkbox och kommentar
- spara hela analysen (video + frames + produktdata) i Supabase

## Stack
- Next.js (App Router)
- Supabase (Postgres + Storage)
- Azure OpenAI via `/api/analyze`
- Deploy: GitHub -> Vercel

## Lokal start
```bash
npm install
cp .env.example .env.local
npm run dev
```

## 1) Supabase setup (du behöver göra detta)

1. Skapa ett nytt Supabase-projekt.
2. Gå till SQL Editor och kör innehållet i `/supabase/schema.sql`.
3. Skapa två Storage buckets:
- `product-videos`
- `product-frames`
4. Hämta:
- Project URL
- anon public key
5. Lägg in i `.env.local`:
```env
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

## 2) Azure OpenAI setup (du behöver göra detta)

I appen fyller du i:
- Endpoint
- Deployment name
- API key

Notera: i denna MVP skickas nyckeln från klienten till API-route för snabb start. Nästa steg är att flytta nyckelhantering till server-side per användare med kryptering.

## 3) Vercel deploy (du behöver göra detta)

1. Pusha repo till GitHub.
2. Importera GitHub-repot i Vercel.
3. Sätt environment variables i Vercel:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Deploy.

## Flöde i appen
1. Välj video.
2. Spela/pausa videon.
3. Rita markeringsruta över produkten.
4. Klicka `Skapa stillbild`.
5. Klicka `Analysera bilder`.
6. Justera rapportfält vid behov.
7. Klicka `Spara ProductAnalyzer`.
8. Klicka `Ladda ner HTML-rapport`.

## Nästa förbättringar
- Auth + RLS policies i Supabase
- Krypterad lagring av Azure-inställningar per användare
- Bakgrundsjobb för batch-analys
- Thumbnail-generering på analyzer-nivå
