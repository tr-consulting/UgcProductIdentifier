import { NextResponse } from "next/server";

import type { AnalyzeApiResponse, AzureSettings } from "@/lib/types";

type RequestBody = {
  imageDataUrl?: string;
  analysisImageDataUrl?: string;
  lensImageUrl?: string;
  settings?: AzureSettings;
};

function cleanJsonText(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  }
  return trimmed;
}

function fallbackLinks(query: string) {
  const q = query.trim();
  if (!q) {
    return [];
  }

  const encoded = encodeURIComponent(q);
  return [
    `https://www.google.com/search?tbm=shop&q=${encoded}`,
    `https://www.amazon.com/s?k=${encoded}`,
    `https://www.ebay.com/sch/i.html?_nkw=${encoded}`,
  ];
}

async function fetchSerpTopLinks(query: string) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey || !query.trim()) {
    return [];
  }

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_shopping");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", "us");
  url.searchParams.set("api_key", apiKey);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const shopping = Array.isArray(data?.shopping_results) ? data.shopping_results : [];
    const links = shopping
      .map((item: { link?: string }) => item?.link)
      .filter((value: unknown): value is string => typeof value === "string" && value.startsWith("http"));

    return Array.from(new Set(links)).slice(0, 3);
  } catch {
    return [];
  }
}

type LensCandidate = {
  title: string;
  link: string;
  source: string;
};

async function fetchLensCandidates(lensImageUrl?: string) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey || !lensImageUrl) {
    return [] as LensCandidate[];
  }

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_lens");
  url.searchParams.set("url", lensImageUrl);
  url.searchParams.set("type", "products");
  url.searchParams.set("hl", "en");
  url.searchParams.set("country", "us");
  url.searchParams.set("api_key", apiKey);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const matches = Array.isArray(data?.visual_matches) ? data.visual_matches : [];
    const links = matches
      .map((item: { title?: string; link?: string; source?: string }) => ({
        title: item?.title || "",
        link: item?.link || "",
        source: item?.source || "",
      }))
      .filter((item: LensCandidate) => item.link.startsWith("http"))
      .slice(0, 10);

    return links;
  } catch {
    return [];
  }
}

function rankLensLinksForProduct(name: string, candidates: LensCandidate[]) {
  const queryTokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);

  const scored = candidates.map((candidate) => {
    const title = candidate.title.toLowerCase();
    const score = queryTokens.reduce(
      (acc, token) => (title.includes(token) ? acc + 1 : acc),
      0,
    );
    return { ...candidate, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .map((item) => item.link)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, 3);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;

    if (!body.imageDataUrl || !body.settings) {
      return NextResponse.json({ error: "Missing imageDataUrl or settings." }, { status: 400 });
    }

    const { endpoint, deployment, apiKey } = body.settings;

    if (!endpoint || !deployment || !apiKey) {
      return NextResponse.json({ error: "Missing Azure settings." }, { status: 400 });
    }

    const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;

    const analysisImage = body.analysisImageDataUrl ?? body.imageDataUrl;
    const lensCandidates = await fetchLensCandidates(body.lensImageUrl);
    const lensContext =
      lensCandidates.length > 0
        ? `Google Lens candidate matches: ${lensCandidates
            .slice(0, 6)
            .map((item: LensCandidate) => `${item.title} -> ${item.link}`)
            .join(" | ")}`
        : "Google Lens candidate matches: none";

    const azureResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content:
              "You identify consumer products from screenshots. Be conservative and avoid guessing exact models when evidence is weak. Return only JSON with shape { products: [{ name, description, buyUrl, searchQuery }] }. searchQuery should be a short shopping query (brand + product type + model if visible). If buyUrl is uncertain, use empty string.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `First image is a context-aware crop around the marked product. Second image is the exact tight crop. ${lensContext}. Use candidate matches to improve product naming. Output 0-5 items as JSON only.`,
              },
              {
                type: "image_url",
                image_url: {
                  url: analysisImage,
                },
              },
              {
                type: "image_url",
                image_url: {
                  url: body.imageDataUrl,
                },
              },
            ],
          },
        ],
        max_completion_tokens: 700,
        temperature: 0.1,
      }),
    });

    if (!azureResponse.ok) {
      const message = await azureResponse.text();
      return NextResponse.json(
        { error: `Azure request failed: ${message}` },
        { status: azureResponse.status },
      );
    }

    const azureData = await azureResponse.json();
    const content: string =
      azureData?.choices?.[0]?.message?.content ?? "{\"products\": []}";

    const parsed = JSON.parse(cleanJsonText(content)) as AnalyzeApiResponse;
    const safeProducts = Array.isArray(parsed.products) ? parsed.products : [];
    const productsWithLinks = await Promise.all(
      safeProducts.map(async (product) => {
        const query = product.searchQuery || product.name || "";
        const lensLinks = rankLensLinksForProduct(product.name || query, lensCandidates);
        const serpLinks = lensLinks.length ? [] : await fetchSerpTopLinks(query);
        const links = lensLinks.length
          ? lensLinks
          : serpLinks.length
            ? serpLinks
            : fallbackLinks(query);
        return {
          ...product,
          buyLinks: links,
          buyUrl: product.buyUrl || links[0] || "",
        };
      }),
    );

    return NextResponse.json({ products: productsWithLinks });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
