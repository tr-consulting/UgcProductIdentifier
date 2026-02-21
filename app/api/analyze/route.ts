import { NextResponse } from "next/server";

import type { AnalyzeApiResponse, AzureSettings } from "@/lib/types";

type RequestBody = {
  imageDataUrl?: string;
  analysisImageDataUrl?: string;
  settings?: AzureSettings;
};

function cleanJsonText(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  }
  return trimmed;
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
                text: "First image is a context-aware crop around the marked product. Second image is the exact tight crop. Identify visible products and output 0-5 items as JSON only.",
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
        const links = await fetchSerpTopLinks(product.searchQuery || product.name || "");
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
