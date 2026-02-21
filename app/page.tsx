"use client";

import Image from "next/image";
import { ChangeEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";

import { getSupabaseClient, hasSupabaseConfig } from "@/lib/supabase";
import type {
  AnalyzeApiResponse,
  Analyzer,
  AzureSettings,
  CapturedFrame,
  ProductResult,
} from "@/lib/types";

const defaultSettings: AzureSettings = {
  endpoint: "",
  deployment: "",
  apiKey: "",
};
const AZURE_SETTINGS_STORAGE_KEY = "product-analyzer.azure-settings";
const MAX_CAPTURE_DIMENSION = 900;
const CAPTURE_JPEG_QUALITY = 0.72;
const ANALYSIS_MAX_DIMENSION = 1400;
const ANALYSIS_JPEG_QUALITY = 0.9;
const ANALYSIS_PADDING_FACTOR = 0.35;

type DraftBox = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

type VideoGeometry = {
  displayX: number;
  displayY: number;
  displayWidth: number;
  displayHeight: number;
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

function boxToStyle(box: DraftBox | null) {
  if (!box) {
    return null;
  }

  return {
    left: Math.min(box.startX, box.endX),
    top: Math.min(box.startY, box.endY),
    width: Math.abs(box.endX - box.startX),
    height: Math.abs(box.endY - box.startY),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export default function HomePage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const [azureSettings, setAzureSettings] = useState<AzureSettings>(defaultSettings);
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [analyzer, setAnalyzer] = useState<Analyzer | null>(null);
  const [draftBox, setDraftBox] = useState<DraftBox | null>(null);
  const [selectedBox, setSelectedBox] = useState<DraftBox | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isDrawMode, setIsDrawMode] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [status, setStatus] = useState<string>("");
  const [currentTimestamp, setCurrentTimestamp] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const allProducts = useMemo(
    () => analyzer?.frames.flatMap((frame) => frame.products) ?? [],
    [analyzer],
  );

  const visibleBox = isDrawing ? draftBox : selectedBox;
  const visibleStyle = boxToStyle(visibleBox);

  function getVideoGeometry(): VideoGeometry | null {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || !video.videoWidth || !video.videoHeight) {
      return null;
    }

    const containerWidth = overlay.clientWidth;
    const containerHeight = overlay.clientHeight;
    if (!containerWidth || !containerHeight) {
      return null;
    }

    const videoAspect = video.videoWidth / video.videoHeight;
    const containerAspect = containerWidth / containerHeight;

    let displayWidth = containerWidth;
    let displayHeight = containerHeight;
    let displayX = 0;
    let displayY = 0;

    if (videoAspect > containerAspect) {
      displayWidth = containerWidth;
      displayHeight = containerWidth / videoAspect;
      displayY = (containerHeight - displayHeight) / 2;
    } else {
      displayHeight = containerHeight;
      displayWidth = containerHeight * videoAspect;
      displayX = (containerWidth - displayWidth) / 2;
    }

    return { displayX, displayY, displayWidth, displayHeight };
  }

  useEffect(() => {
    try {
      const saved = localStorage.getItem(AZURE_SETTINGS_STORAGE_KEY);
      if (!saved) {
        return;
      }

      const parsed = JSON.parse(saved) as Partial<AzureSettings>;
      setAzureSettings({
        endpoint: parsed.endpoint ?? "",
        deployment: parsed.deployment ?? "",
        apiKey: parsed.apiKey ?? "",
      });
    } catch {
      // Ignore malformed local storage data.
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(AZURE_SETTINGS_STORAGE_KEY, JSON.stringify(azureSettings));
  }, [azureSettings]);

  function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
    }

    const nextVideoUrl = URL.createObjectURL(file);
    setVideoUrl(nextVideoUrl);
    setDraftBox(null);
    setSelectedBox(null);
    setAnalyzer({
      id: crypto.randomUUID(),
      title: file.name.replace(/\.[^.]+$/, "") || "Ny analys",
      videoName: file.name,
      videoPreviewUrl: nextVideoUrl,
      frames: [],
      createdAt: new Date().toISOString(),
    });
    setStatus("Video uppladdad. Klicka 'Markera produkt' och rita en ruta.");
  }

  function toNormalizedBox(boxDraft: DraftBox) {
    const geometry = getVideoGeometry();
    if (!geometry) {
      return null;
    }

    const style = boxToStyle(boxDraft);
    if (!style) {
      return null;
    }

    const x = (style.left - geometry.displayX) / geometry.displayWidth;
    const y = (style.top - geometry.displayY) / geometry.displayHeight;
    const width = style.width / geometry.displayWidth;
    const height = style.height / geometry.displayHeight;

    return {
      x: clamp(x, 0, 1),
      y: clamp(y, 0, 1),
      width: clamp(width, 0, 1),
      height: clamp(height, 0, 1),
    };
  }

  function enableDrawMode() {
    if (!videoRef.current) {
      setStatus("Ladda upp en video först.");
      return;
    }

    videoRef.current.pause();
    setIsDrawMode(true);
    setIsDrawing(false);
    setDraftBox(null);
    setSelectedBox(null);
    setStatus("Markeringsläge aktivt. Dra en ruta över produkten så sparas stillbilden automatiskt.");
  }

  function captureFrameFromBox(boxDraft: DraftBox) {
    if (!videoRef.current || !analyzer) {
      return;
    }

    const box = toNormalizedBox(boxDraft);
    const style = boxToStyle(boxDraft);
    if (!box || !style || style.width <= 5 || style.height <= 5) {
      setStatus("Markera ett giltigt område först.");
      return;
    }

    const video = videoRef.current;
    const canvas = document.createElement("canvas");

    const sx = Math.max(0, Math.floor(box.x * video.videoWidth));
    const sy = Math.max(0, Math.floor(box.y * video.videoHeight));
    const sw = Math.max(1, Math.floor(box.width * video.videoWidth));
    const sh = Math.max(1, Math.floor(box.height * video.videoHeight));

    const contextPadX = Math.floor(sw * ANALYSIS_PADDING_FACTOR);
    const contextPadY = Math.floor(sh * ANALYSIS_PADDING_FACTOR);
    const contextSx = Math.max(0, sx - contextPadX);
    const contextSy = Math.max(0, sy - contextPadY);
    const contextEx = Math.min(video.videoWidth, sx + sw + contextPadX);
    const contextEy = Math.min(video.videoHeight, sy + sh + contextPadY);
    const contextSw = Math.max(1, contextEx - contextSx);
    const contextSh = Math.max(1, contextEy - contextSy);

    const scale = Math.min(1, MAX_CAPTURE_DIMENSION / Math.max(sw, sh));
    const targetWidth = Math.max(1, Math.floor(sw * scale));
    const targetHeight = Math.max(1, Math.floor(sh * scale));

    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      setStatus("Kunde inte läsa videobilden.");
      return;
    }

    context.drawImage(video, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
    const imageDataUrl = canvas.toDataURL("image/jpeg", CAPTURE_JPEG_QUALITY);

    const analysisCanvas = document.createElement("canvas");
    const analysisScale = Math.min(1, ANALYSIS_MAX_DIMENSION / Math.max(contextSw, contextSh));
    const analysisWidth = Math.max(1, Math.floor(contextSw * analysisScale));
    const analysisHeight = Math.max(1, Math.floor(contextSh * analysisScale));
    analysisCanvas.width = analysisWidth;
    analysisCanvas.height = analysisHeight;

    const analysisContext = analysisCanvas.getContext("2d");
    if (!analysisContext) {
      setStatus("Kunde inte skapa analysbild.");
      return;
    }

    analysisContext.drawImage(
      video,
      contextSx,
      contextSy,
      contextSw,
      contextSh,
      0,
      0,
      analysisWidth,
      analysisHeight,
    );
    const analysisImageDataUrl = analysisCanvas.toDataURL("image/jpeg", ANALYSIS_JPEG_QUALITY);

    const frame: CapturedFrame = {
      id: crypto.randomUUID(),
      timestamp: video.currentTime,
      bbox: box,
      imageDataUrl,
      analysisImageDataUrl,
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

    setStatus(
      `Stillbild skapad vid ${formatSeconds(video.currentTime)} (${targetWidth}x${targetHeight}).`,
    );
    setSelectedBox(null);
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
      setSettingsOpen(true);
      return;
    }

    setIsLoading(true);
    setAnalyzeProgress({ current: 0, total: framesToAnalyze.length });
    setStatus(`Analyserar ${framesToAnalyze.length} bilder...`);

    try {
      const updates: Record<string, ProductResult[]> = {};

      for (const [index, frame] of framesToAnalyze.entries()) {
        const current = index + 1;
        setAnalyzeProgress({ current, total: framesToAnalyze.length });
        setStatus(`Analyserar bild ${current}/${framesToAnalyze.length}...`);

        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            imageDataUrl: frame.imageDataUrl,
            analysisImageDataUrl: frame.analysisImageDataUrl,
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
          buyLinks: item.buyLinks || [],
          searchQuery: item.searchQuery || "",
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
      setAnalyzeProgress(null);
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
    if (!analyzer) {
      setStatus("Ingen analys att spara.");
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

      const { error: analyzerError } = await supabase.from("product_analyzers").upsert({
        id: analyzerId,
        title: analyzer.title,
        video_name: analyzer.videoName,
        video_path: "__not_saved__",
        report_html: reportHtml(analyzer.title, allProducts),
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
            buy_links: product.buyLinks || [],
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
      if (message.includes("row-level security policy")) {
        setStatus(
          "Kunde inte spara: RLS-policy blockerar skrivning i Supabase. Kör SQL-fixen för policies i supabase/schema.sql.",
        );
      } else if (message.toLowerCase().includes("maximum allowed size")) {
        setStatus(
          "Kunde inte spara: stillbilden är större än bucket-gränsen. Höj maxstorlek i product-frames bucket.",
        );
      } else {
        setStatus(`Kunde inte spara: ${message}`);
      }
    } finally {
      setIsLoading(false);
    }
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!isDrawMode || !overlayRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const rect = overlayRef.current.getBoundingClientRect();
    const geometry = getVideoGeometry();
    if (!geometry) {
      return;
    }

    const rawX = event.clientX - rect.left;
    const rawY = event.clientY - rect.top;
    const x = clamp(rawX, geometry.displayX, geometry.displayX + geometry.displayWidth);
    const y = clamp(rawY, geometry.displayY, geometry.displayY + geometry.displayHeight);

    setIsDrawing(true);
    setDraftBox({ startX: x, startY: y, endX: x, endY: y });
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!isDrawMode || !isDrawing || !overlayRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const rect = overlayRef.current.getBoundingClientRect();
    const geometry = getVideoGeometry();
    if (!geometry) {
      return;
    }

    const rawX = event.clientX - rect.left;
    const rawY = event.clientY - rect.top;
    const x = clamp(rawX, geometry.displayX, geometry.displayX + geometry.displayWidth);
    const y = clamp(rawY, geometry.displayY, geometry.displayY + geometry.displayHeight);

    setDraftBox((prev) => (prev ? { ...prev, endX: x, endY: y } : prev));
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!isDrawMode || !isDrawing || !overlayRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const rect = overlayRef.current.getBoundingClientRect();
    const geometry = getVideoGeometry();
    if (!geometry) {
      return;
    }

    const rawX = event.clientX - rect.left;
    const rawY = event.clientY - rect.top;
    const x = clamp(rawX, geometry.displayX, geometry.displayX + geometry.displayWidth);
    const y = clamp(rawY, geometry.displayY, geometry.displayY + geometry.displayHeight);

    const nextBox = draftBox ? { ...draftBox, endX: x, endY: y } : null;
    const style = boxToStyle(nextBox);

    setDraftBox(nextBox);
    setSelectedBox(nextBox);
    setIsDrawing(false);
    setIsDrawMode(false);

    if (nextBox && style && style.width > 5 && style.height > 5) {
      captureFrameFromBox(nextBox);
    } else {
      setStatus("Markeringen var för liten. Prova igen.");
      setSelectedBox(null);
    }
  }

  return (
    <main className="page appLayout">
      <header className="topBar">
        <div>
          <h1>ProductAnalyzer</h1>
          <p>Stor videoyta till vänster, smidig arbetspanel till höger.</p>
        </div>
        <button type="button" className="menuButton" onClick={() => setSettingsOpen(true)}>
          ☰ Inställningar
        </button>
      </header>

      <section className="workspace">
        <section className="panel videoPanel">
          <div className="videoStage">
            {videoUrl ? (
              <div className="videoCanvas">
                <video
                  ref={videoRef}
                  src={videoUrl}
                  controls={!isDrawMode}
                  onTimeUpdate={(event) => setCurrentTimestamp(event.currentTarget.currentTime)}
                />
                <div
                  ref={overlayRef}
                  className={`drawLayer ${isDrawMode ? "active" : ""}`}
                  onPointerDown={pointerDown}
                  onPointerMove={pointerMove}
                  onPointerUp={pointerUp}
                  onPointerLeave={pointerUp}
                >
                  {visibleStyle && (
                    <div
                      className="selection"
                      style={{
                        left: visibleStyle.left,
                        top: visibleStyle.top,
                        width: visibleStyle.width,
                        height: visibleStyle.height,
                      }}
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="videoPlaceholder">Ingen video vald ännu.</div>
            )}
          </div>
          <div className="videoMeta">
            <span>Tid: {formatSeconds(currentTimestamp)}</span>
            <span>
              {analyzeProgress
                ? `Analyserar ${analyzeProgress.current}/${analyzeProgress.total}`
                : status || "Redo"}
            </span>
          </div>
        </section>

        <aside className="panel sidePanel">
          <div className="actionsColumn">
            <label className="upload">
              Välj video
              <input type="file" accept="video/*" onChange={onUpload} />
            </label>
            <button type="button" onClick={enableDrawMode} disabled={!videoUrl}>
              Markera produkt
            </button>
            <button type="button" onClick={analyzeFrames} disabled={!analyzer || isLoading}>
              {analyzeProgress
                ? `Analyserar ${analyzeProgress.current}/${analyzeProgress.total}`
                : "Analysera bilder"}
            </button>
            <button type="button" onClick={saveToSupabase} disabled={!analyzer || isLoading}>
              Spara ProductAnalyzer
            </button>
            <button type="button" onClick={downloadReport} disabled={!allProducts.length}>
              Ladda ner HTML
            </button>
          </div>

          <div className="thumbSection">
            <h3>Stillbilder ({analyzer?.frames.length ?? 0})</h3>
            <div className="thumbList">
              {(analyzer?.frames ?? []).map((frame) => (
                <article key={frame.id} className="thumbCard">
                  <Image
                    src={frame.imageDataUrl}
                    alt={`Frame ${frame.id}`}
                    width={92}
                    height={68}
                    className="thumbImage"
                    unoptimized
                  />
                  <div>
                    <p>{formatSeconds(frame.timestamp)}</p>
                    <p>{frame.analyzed ? `${frame.products.length} produkter` : "Ej analyserad"}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </aside>
      </section>

      <section className="panel">
        <h2>Rapport ({allProducts.length} produkter)</h2>
        <div className="reportTableWrap">
          <div className="reportHeader">
            <span>Bild</span>
            <span>Namn</span>
            <span>Beskrivning</span>
            <span>Köplänk</span>
            <span>Köpt</span>
            <span>Kommentar</span>
          </div>
          {allProducts.map((product) => (
            <div key={product.id} className="reportRow">
              <div className="reportCell imageCell">
                <Image
                  src={product.imageDataUrl}
                  alt={product.name}
                  width={88}
                  height={88}
                  className="reportThumb"
                  unoptimized
                />
              </div>
              <div className="reportCell">
                <input
                  type="text"
                  value={product.name}
                  onChange={(event) => updateProduct(product.id, { name: event.target.value })}
                />
              </div>
              <div className="reportCell">
                <textarea
                  value={product.description}
                  onChange={(event) =>
                    updateProduct(product.id, { description: event.target.value })
                  }
                />
              </div>
              <div className="reportCell">
                <input
                  type="text"
                  placeholder={product.searchQuery || "Lägg köplänk"}
                  value={product.buyUrl}
                  onChange={(event) => updateProduct(product.id, { buyUrl: event.target.value })}
                />
                {!!product.buyLinks?.length && (
                  <div className="suggestLinks">
                    {product.buyLinks.slice(0, 3).map((link) => (
                      <button
                        key={link}
                        type="button"
                        className="suggestLinkBtn"
                        onClick={() => updateProduct(product.id, { buyUrl: link })}
                        title={link}
                      >
                        Förslag
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="reportCell checkCell">
                <input
                  type="checkbox"
                  checked={product.purchased}
                  onChange={(event) =>
                    updateProduct(product.id, { purchased: event.target.checked })
                  }
                />
              </div>
              <div className="reportCell">
                <textarea
                  value={product.comment}
                  onChange={(event) => updateProduct(product.id, { comment: event.target.value })}
                />
              </div>
            </div>
          ))}
          {!allProducts.length && <p className="emptyReport">Inga produkter ännu.</p>}
        </div>
      </section>

      {settingsOpen && (
        <>
          <button
            type="button"
            className="settingsBackdrop"
            onClick={() => setSettingsOpen(false)}
            aria-label="Stäng inställningar"
          />
          <aside className="settingsDrawer panel">
            <div className="settingsHeader">
              <h2>Applikationsinställningar</h2>
              <button type="button" onClick={() => setSettingsOpen(false)}>
                Stäng
              </button>
            </div>
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
          </aside>
        </>
      )}
    </main>
  );
}
