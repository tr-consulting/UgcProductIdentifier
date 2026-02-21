import { NextResponse } from "next/server";

import type { AnalyzeApiResponse, AzureSettings } from "@/lib/types";

type RequestBody = {
  imageDataUrl?: string;
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
              "You extract products shown in screenshots. Return only JSON with shape { products: [{ name, description, buyUrl }] }. If unknown buyUrl, use empty string.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Identify visible products in this screenshot/crop and return 0-5 products as JSON only.",
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
        max_tokens: 700,
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
