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

    return NextResponse.json({ products: safeProducts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
