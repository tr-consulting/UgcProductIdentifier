"use client";

import { ChangeEvent, MouseEvent, useMemo, useRef, useState } from "react";
import Image from "next/image";

import { getSupabaseClient, hasSupabaseConfig } from "@/lib/supabase";
import type { AnalyzeApiResponse, Analyzer, AzureSettings, CapturedFrame, ProductResult } from "@/lib/types";

const defaultSettings: AzureSettings = {
  endpoint: "",
  deployment: "",
  apiKey: "",
};

type DraftBox = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

function formatSeconds(value: number) {
  const min = Math.floor(value / 60);
  const sec = Math.floor(value % 60)
    .toString()
    .padStart(2, "0");
  return `${min}:${sec}`;
}

function reportHtml(title: string, products: ProductResult[]) {
  const cards = products
    .map(
      (p) => `
      <article style="border:1px solid #d1d5db;border-radius:12px;padding:12px;margin-bottom:12px;">
        <h3 style="margin:0 0 8px;">${p.name}</h3>
        <img src="${p.imageDataUrl}" alt="${p.name}" style="width:180px;border-radius:8px;display:block;margin-bottom:8px;" />
        <p style="margin:0 0 8px;"><strong>Beskrivning:</strong> ${p.description}</p>
        <p style="margin:0 0 8px;"><strong>Köplänk:</strong> <a href="${p.buyUrl}">${p.buyUrl || "Saknas"}</a></p>
        <label style="display:block;margin-bottom:8px;"><input type="checkbox" ${p.purchased ? "checked" : ""} /> Köpt</label>
        <label style="display:block;">Egen kommentar:<br/><input value="${p.comment}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;" /></label>
      </article>
    `,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} - Produktanalys</title>
</head>
<body style="font-family:Arial,Helvetica,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;">
  <h1>${title}</h1>
  <p>Skapad: ${new Date().toLocaleString("sv-SE")}</p>
  ${cards}
</body>
</html>`;
}

export default function HomePage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const [azureSettings, setAzureSettings] = useState<AzureSettings>(defaultSettings);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [analyzer, setAnalyzer] = useState<Analyzer | null>(null);
  const [draftBox, setDraftBox] = useState<DraftBox | null>(null);
  const [currentTimestamp, setCurrentTimestamp] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<string>("");

  const allProducts = useMemo(
    () => analyzer?.frames.flatMap((frame) => frame.products) ?? [],
    [analyzer],
  );

  const hasValidBox = useMemo(() => {
    if (!draftBox || !overlayRef.current) {
      return false;
    }

    const w = Math.abs(draftBox.endX - draftBox.startX);
    const h = Math.abs(draftBox.endY - draftBox.startY);
    return w > 5 && h > 5;
  }, [draftBox]);

  function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
    }

    const nextVideoUrl = URL.createObjectURL(file);
    setVideoFile(file);
    setVideoUrl(nextVideoUrl);
    setAnalyzer({
      id: crypto.randomUUID(),
      title: file.name.replace(/\.[^.]+$/, "") || "Ny analys",
      videoName: file.name,
      videoPreviewUrl: nextVideoUrl,
      frames: [],
      createdAt: new Date().toISOString(),
    });
    setStatus("Video uppladdad. Pausa videon och markera en produkt.");
  }

  function normalizedBox() {
    if (!draftBox || !overlayRef.current) {
      return null;
    }

    const bounds = overlayRef.current.getBoundingClientRect();
    const left = Math.min(draftBox.startX, draftBox.endX);
    const top = Math.min(draftBox.startY, draftBox.endY);
    const width = Math.abs(draftBox.endX - draftBox.startX);
    const height = Math.abs(draftBox.endY - draftBox.startY);

    return {
      x: left / bounds.width,
      y: top / bounds.height,
      width: width / bounds.width,
      height: height / bounds.height,
    };
  }

  function captureFrame() {
    if (!videoRef.current || !analyzer) {
      return;
    }

    const box = normalizedBox();
    if (!box) {
      setStatus("Rita en markeringsruta först.");
      return;
    }

    const video = videoRef.current;
    const canvas = document.createElement("canvas");

    const sx = Math.max(0, Math.floor(box.x * video.videoWidth));
    const sy = Math.max(0, Math.floor(box.y * video.videoHeight));
    const sw = Math.max(1, Math.floor(box.width * video.videoWidth));
    const sh = Math.max(1, Math.floor(box.height * video.videoHeight));

    canvas.width = sw;
    canvas.height = sh;

    const context = canvas.getContext("2d");
    if (!context) {
      setStatus("Kunde inte läsa videobilden.");
      return;
    }

    context.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    const imageDataUrl = canvas.toDataURL("image/jpeg", 0.9);

    const frame: CapturedFrame = {
      id: crypto.randomUUID(),
      timestamp: video.currentTime,
      bbox: box,
      imageDataUrl,
      products: [],
      analyzed: false,
    };

    setAnalyzer((prev) =>
      prev
        ? {
            ...prev,
            frames: [...prev.frames, frame],
          }
        : prev,
    );

    setStatus(`Stillbild skapad vid ${formatSeconds(video.currentTime)}.`);
  }

  async function analyzeFrames() {
    if (!analyzer) {
      return;
    }

    const framesToAnalyze = analyzer.frames.filter((frame) => !frame.analyzed);
    if (!framesToAnalyze.length) {
      setStatus("Inga nya bilder att analysera.");
      return;
    }

    if (!azureSettings.endpoint || !azureSettings.deployment || !azureSettings.apiKey) {
      setStatus("Fyll i Azure-inställningarna först.");
      return;
    }

    setIsLoading(true);
    setStatus(`Analyserar ${framesToAnalyze.length} bilder...`);

    try {
      const updates: Record<string, ProductResult[]> = {};

      for (const frame of framesToAnalyze) {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            imageDataUrl: frame.imageDataUrl,
            settings: azureSettings,
          }),
        });

        if (!response.ok) {
          throw new Error(await response.text());
        }

        const data = (await response.json()) as AnalyzeApiResponse;
        updates[frame.id] = (data.products || []).map((item) => ({
          id: crypto.randomUUID(),
          name: item.name || "Okänd produkt",
          description: item.description || "",
          buyUrl: item.buyUrl || "",
          imageDataUrl: frame.imageDataUrl,
          purchased: false,
          comment: "",
        }));
      }

      setAnalyzer((prev) => {
        if (!prev) {
          return prev;
        }

        return {
          ...prev,
          frames: prev.frames.map((frame) => {
            if (!updates[frame.id]) {
              return frame;
            }

            return {
              ...frame,
              analyzed: true,
              products: updates[frame.id],
            };
          }),
        };
      });

      setStatus("AI-analysen är klar.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Okänt fel";
      setStatus(`Analys misslyckades: ${message}`);
    } finally {
      setIsLoading(false);
    }
  }

  function updateProduct(productId: string, next: Partial<ProductResult>) {
    setAnalyzer((prev) => {
      if (!prev) {
        return prev;
      }

      return {
        ...prev,
        frames: prev.frames.map((frame) => ({
          ...frame,
          products: frame.products.map((product) =>
            product.id === productId ? { ...product, ...next } : product,
          ),
        })),
      };
    });
  }

  function downloadReport() {
    if (!analyzer) {
      return;
    }

    const html = reportHtml(analyzer.title, allProducts);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${analyzer.title.replace(/\s+/g, "-").toLowerCase()}-rapport.html`;
    anchor.click();

    URL.revokeObjectURL(url);
  }

  async function saveToSupabase() {
    if (!analyzer || !videoFile) {
      setStatus("Ingen video att spara.");
      return;
    }

    if (!hasSupabaseConfig()) {
      setStatus("Supabase env saknas. Lägg in NEXT_PUBLIC_SUPABASE_URL och NEXT_PUBLIC_SUPABASE_ANON_KEY.");
      return;
    }

    setIsLoading(true);
    setStatus("Sparar ProductAnalyzer i Supabase...");

    try {
      const supabase = getSupabaseClient();
      const analyzerId = analyzer.id;
      const videoPath = `${analyzerId}/video-${Date.now()}-${videoFile.name}`;

      const videoUpload = await supabase.storage
        .from("product-videos")
        .upload(videoPath, videoFile, { upsert: true });

      if (videoUpload.error) {
        throw videoUpload.error;
      }

      const { error: analyzerError } = await supabase.from("product_analyzers").upsert({
        id: analyzerId,
        title: analyzer.title,
        video_name: analyzer.videoName,
        video_path: videoPath,
        created_at: analyzer.createdAt,
      });

      if (analyzerError) {
        throw analyzerError;
      }

      for (const frame of analyzer.frames) {
        const framePath = `${analyzerId}/frame-${frame.id}.jpg`;
        const blob = await (await fetch(frame.imageDataUrl)).blob();

        const frameUpload = await supabase.storage
          .from("product-frames")
          .upload(framePath, blob, { upsert: true, contentType: "image/jpeg" });

        if (frameUpload.error) {
          throw frameUpload.error;
        }

        const { error: frameError } = await supabase.from("analyzer_frames").upsert({
          id: frame.id,
          analyzer_id: analyzerId,
          timestamp_seconds: frame.timestamp,
          bbox: frame.bbox,
          image_path: framePath,
        });

        if (frameError) {
          throw frameError;
        }

        for (const product of frame.products) {
          const { error: productError } = await supabase.from("detected_products").upsert({
            id: product.id,
            analyzer_frame_id: frame.id,
            name: product.name,
            description: product.description,
            buy_url: product.buyUrl,
            is_purchased: product.purchased,
            user_comment: product.comment,
          });

          if (productError) {
            throw productError;
          }
        }
      }

      setStatus("Sparat i Supabase.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Okänt fel";
      setStatus(`Kunde inte spara: ${message}`);
    } finally {
      setIsLoading(false);
    }
  }

  function pointerDown(event: MouseEvent<HTMLDivElement>) {
    if (!overlayRef.current) {
      return;
    }

    const rect = overlayRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setDraftBox({ startX: x, startY: y, endX: x, endY: y });
  }

  function pointerMove(event: MouseEvent<HTMLDivElement>) {
    if (!draftBox || !overlayRef.current) {
      return;
    }

    const rect = overlayRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    setDraftBox((prev) => (prev ? { ...prev, endX: x, endY: y } : prev));
  }

  function pointerUp() {
    if (hasValidBox) {
      setStatus("Markering klar. Klicka på 'Skapa stillbild'.");
    }
  }

  const boxStyle = useMemo(() => {
    if (!draftBox) {
      return { display: "none" };
    }

    const left = Math.min(draftBox.startX, draftBox.endX);
    const top = Math.min(draftBox.startY, draftBox.endY);
    const width = Math.abs(draftBox.endX - draftBox.startX);
    const height = Math.abs(draftBox.endY - draftBox.startY);

    return {
      display: "block",
      left,
      top,
      width,
      height,
    };
  }, [draftBox]);

  return (
    <main className="page">
      <header className="header">
        <h1>ProductAnalyzer</h1>
        <p>Ladda video, pausa, markera produkt, analysera med Azure OpenAI och bygg HTML-rapport.</p>
      </header>

      <section className="panel grid-3">
        <label>
          Azure Endpoint
          <input
            type="text"
            placeholder="https://your-resource.openai.azure.com"
            value={azureSettings.endpoint}
            onChange={(event) =>
              setAzureSettings((prev) => ({ ...prev, endpoint: event.target.value }))
            }
          />
        </label>
        <label>
          Azure Deployment
          <input
            type="text"
            placeholder="gpt-4.1-mini"
            value={azureSettings.deployment}
            onChange={(event) =>
              setAzureSettings((prev) => ({ ...prev, deployment: event.target.value }))
            }
          />
        </label>
        <label>
          Azure API Key
          <input
            type="password"
            placeholder="Din Azure OpenAI key"
            value={azureSettings.apiKey}
            onChange={(event) =>
              setAzureSettings((prev) => ({ ...prev, apiKey: event.target.value }))
            }
          />
        </label>
      </section>

      <section className="panel">
        <div className="actions">
          <label className="upload">
            Välj video
            <input type="file" accept="video/*" onChange={onUpload} />
          </label>
          <button type="button" onClick={captureFrame} disabled={!hasValidBox || !analyzer}>
            Skapa stillbild
          </button>
          <button type="button" onClick={analyzeFrames} disabled={!analyzer || isLoading}>
            {isLoading ? "Analyserar..." : "Analysera bilder"}
          </button>
          <button type="button" onClick={saveToSupabase} disabled={!analyzer || isLoading}>
            Spara ProductAnalyzer
          </button>
          <button type="button" onClick={downloadReport} disabled={!allProducts.length}>
            Ladda ner HTML-rapport
          </button>
        </div>

        <p className="status">{status}</p>

        <div className="videoWrap">
          {videoUrl ? (
            <div
              className="overlay"
              ref={overlayRef}
              onMouseDown={pointerDown}
              onMouseMove={pointerMove}
              onMouseUp={pointerUp}
            >
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                onTimeUpdate={(event) => setCurrentTimestamp(event.currentTarget.currentTime)}
              />
              <div className="selection" style={boxStyle} />
            </div>
          ) : (
            <p>Ingen video vald ännu.</p>
          )}
        </div>

        <p className="meta">Aktuell tid: {formatSeconds(currentTimestamp)}</p>
      </section>

      <section className="panel">
        <h2>Stillbilder ({analyzer?.frames.length ?? 0})</h2>
        <div className="frames">
          {(analyzer?.frames ?? []).map((frame) => (
            <article key={frame.id} className="frameCard">
              <Image
                src={frame.imageDataUrl}
                alt={`Frame ${frame.id}`}
                width={320}
                height={180}
                className="previewImage"
                unoptimized
              />
              <p>{formatSeconds(frame.timestamp)}</p>
              <p>{frame.analyzed ? `${frame.products.length} produkter` : "Ej analyserad"}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Rapport ({allProducts.length} produkter)</h2>
        <div className="products">
          {allProducts.map((product) => (
            <article key={product.id} className="productCard">
              <Image
                src={product.imageDataUrl}
                alt={product.name}
                width={320}
                height={180}
                className="previewImage"
                unoptimized
              />
              <label>
                Namn
                <input
                  type="text"
                  value={product.name}
                  onChange={(event) => updateProduct(product.id, { name: event.target.value })}
                />
              </label>
              <label>
                Beskrivning
                <textarea
                  value={product.description}
                  onChange={(event) =>
                    updateProduct(product.id, { description: event.target.value })
                  }
                />
              </label>
              <label>
                Köplänk
                <input
                  type="text"
                  value={product.buyUrl}
                  onChange={(event) => updateProduct(product.id, { buyUrl: event.target.value })}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={product.purchased}
                  onChange={(event) =>
                    updateProduct(product.id, { purchased: event.target.checked })
                  }
                />
                Köpt
              </label>
              <label>
                Egen kommentar
                <textarea
                  value={product.comment}
                  onChange={(event) => updateProduct(product.id, { comment: event.target.value })}
                />
              </label>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
