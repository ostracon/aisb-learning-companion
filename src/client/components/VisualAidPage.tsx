import { useEffect, useState, type FormEvent } from "react";
import type {
  VisualAidAssetView,
  VisualAidBrief,
  VisualAidPreviewResponse,
} from "../../shared/visual.js";
import { UtilityBackLink } from "./UtilityBackLink.js";
import "../styles/visual-aid.css";

const emptyBrief: VisualAidBrief = {
  title: "",
  pedagogicalPurpose: "",
  essentialRelationships: "",
  factualConstraints: "",
  exclusions: "No answers, source code, logos, screenshots, people, or decorative filler.",
  altText: "",
  proseEquivalent: "",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const payload: unknown = await response.json();
    return new Error(isRecord(payload) && typeof payload.error === "string" ? payload.error : fallback);
  } catch {
    return new Error(fallback);
  }
}

function parsePreview(value: unknown): VisualAidPreviewResponse {
  if (
    !isRecord(value)
    || typeof value.confirmationToken !== "string"
    || typeof value.payloadHash !== "string"
    || typeof value.expiresAt !== "string"
    || value.model !== "gpt-image-2"
    || value.size !== "1024x1024"
    || value.quality !== "low"
    || !isRecord(value.brief)
    || typeof value.renderedPrompt !== "string"
  ) {
    throw new Error("The visual preview service returned malformed data.");
  }
  return value as unknown as VisualAidPreviewResponse;
}

function parseAsset(value: unknown): VisualAidAssetView {
  if (
    !isRecord(value)
    || typeof value.assetId !== "string"
    || typeof value.createdAt !== "string"
    || value.model !== "gpt-image-2"
    || value.mimeType !== "image/png"
    || typeof value.byteLength !== "number"
    || typeof value.contentHash !== "string"
    || typeof value.promptHash !== "string"
    || typeof value.imageUrl !== "string"
    || !isRecord(value.brief)
  ) {
    throw new Error("The visual service returned malformed asset data.");
  }
  return value as unknown as VisualAidAssetView;
}

export function VisualAidPage({ available }: { readonly available: boolean }) {
  const [brief, setBrief] = useState<VisualAidBrief>(emptyBrief);
  const [preview, setPreview] = useState<VisualAidPreviewResponse | null>(null);
  const [assets, setAssets] = useState<readonly VisualAidAssetView[]>([]);
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [working, setWorking] = useState<"preview" | "generate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assistantPrepared, setAssistantPrepared] = useState(false);

  useEffect(() => {
    let current = true;
    void Promise.all([
      fetch("/api/visuals").then(async (response) => {
        if (!response.ok) throw await responseError(response, "Could not load saved visuals.");
        const value: unknown = await response.json();
        if (!Array.isArray(value)) throw new Error("The visual service returned malformed data.");
        return value.map(parseAsset);
      }),
      fetch("/api/visuals/pending").then(async (response) => {
        if (!response.ok) throw await responseError(response, "Could not load prepared visual briefs.");
        const value: unknown = await response.json();
        if (!Array.isArray(value)) throw new Error("The visual preview service returned malformed data.");
        return value.map(parsePreview);
      }),
    ])
      .then(([nextAssets, pending]) => {
        if (!current) return;
        setAssets(nextAssets);
        const latest = pending[0];
        if (latest !== undefined) {
          setBrief(latest.brief);
          setPreview(latest);
          setAssistantPrepared(true);
        }
      })
      .catch((reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : "Could not load saved visuals.");
      })
      .finally(() => {
        if (current) setLoadingAssets(false);
      });
    return () => {
      current = false;
    };
  }, []);

  const update = (field: keyof VisualAidBrief, value: string) => {
    setBrief((current) => ({ ...current, [field]: value }));
    setPreview(null);
    setAssistantPrepared(false);
    setError(null);
  };

  const createPreview = async (event: FormEvent) => {
    event.preventDefault();
    if (!available || working !== null) return;
    setWorking("preview");
    setError(null);
    try {
      const response = await fetch("/api/visuals/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(brief),
      });
      if (!response.ok) throw await responseError(response, "Could not prepare the visual brief.");
      setPreview(parsePreview(await response.json()));
      setAssistantPrepared(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not prepare the visual brief.");
    } finally {
      setWorking(null);
    }
  };

  const generate = async () => {
    if (preview === null || working !== null) return;
    setWorking("generate");
    setError(null);
    try {
      const response = await fetch("/api/visuals/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmationToken: preview.confirmationToken,
          payloadHash: preview.payloadHash,
        }),
      });
      if (!response.ok) throw await responseError(response, "Could not generate the visual.");
      const asset = parseAsset(await response.json());
      setAssets((current) => [asset, ...current.filter((item) => item.assetId !== asset.assetId)]);
      setPreview(null);
      setAssistantPrepared(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not generate the visual.");
      setPreview(null);
    } finally {
      setWorking(null);
    }
  };

  return (
    <main className="visual-aid-page">
      <div className="visual-aid-content">
      <header className="utility-page-header">
        <div>
          <p className="eyebrow">Optional learning aid</p>
          <h1>Make one useful visual</h1>
          <p>
            Describe the relationship you are trying to understand. Nothing is generated until you
            review the exact brief and confirm a second time.
          </p>
        </div>
        <UtilityBackLink />
      </header>

      {!available ? (
        <p className="utility-notice" role="status">
          Image generation is unavailable in this backend process. Restart it from the shell that
          provides <code>CODEX_OPENAI_API_KEY</code>.
        </p>
      ) : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {assistantPrepared ? (
        <p className="utility-notice visual-assistant-notice" role="status">
          The assistant prepared this brief from the current learning context. Review every field
          and the exact prompt below; no image has been generated yet.
        </p>
      ) : null}

      <section className="visual-brief-section" aria-labelledby="visual-brief-heading">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">1 · Brief</p>
            <h2 id="visual-brief-heading">Name the learning job</h2>
          </div>
          <p className="quiet-copy">A visual should clarify structure—not decorate the page.</p>
        </div>
        <form className="visual-brief-form" onSubmit={createPreview}>
          <label>
            <span>Title</span>
            <input required maxLength={160} value={brief.title} onChange={(event) => update("title", event.target.value)} />
          </label>
          <label>
            <span>Why would an image help?</span>
            <textarea required rows={3} maxLength={1_200} value={brief.pedagogicalPurpose} onChange={(event) => update("pedagogicalPurpose", event.target.value)} />
          </label>
          <label>
            <span>Relationships to show</span>
            <textarea required rows={4} maxLength={2_400} value={brief.essentialRelationships} onChange={(event) => update("essentialRelationships", event.target.value)} />
          </label>
          <div className="visual-form-pair">
            <label>
              <span>Facts it must preserve</span>
              <textarea required rows={4} maxLength={2_400} value={brief.factualConstraints} onChange={(event) => update("factualConstraints", event.target.value)} />
            </label>
            <label>
              <span>Things to leave out</span>
              <textarea required rows={4} maxLength={1_600} value={brief.exclusions} onChange={(event) => update("exclusions", event.target.value)} />
            </label>
          </div>
          <label>
            <span>Alt text</span>
            <textarea required rows={3} maxLength={800} value={brief.altText} onChange={(event) => update("altText", event.target.value)} />
          </label>
          <label>
            <span>Equivalent explanation without the image</span>
            <textarea required rows={3} maxLength={2_400} value={brief.proseEquivalent} onChange={(event) => update("proseEquivalent", event.target.value)} />
          </label>
          <div className="form-actions">
            <button className="primary-button" type="submit" disabled={!available || working !== null}>
              {working === "preview" ? "Preparing…" : "Review exact prompt"}
            </button>
          </div>
        </form>
      </section>

      {preview ? (
        <section className="visual-confirm-section" aria-labelledby="visual-confirm-heading">
          <div>
            <p className="eyebrow">2 · Confirm</p>
            <h2 id="visual-confirm-heading">Read what will be sent</h2>
            <p>
              This creates one low-quality 1024×1024 draft with <code>{preview.model}</code>. It may
              incur API usage. The brief expires at {new Date(preview.expiresAt).toLocaleTimeString()}.
            </p>
          </div>
          <pre>{preview.renderedPrompt}</pre>
          <div className="form-actions">
            <button className="outline-button" type="button" onClick={() => { setPreview(null); setAssistantPrepared(false); }} disabled={working !== null}>
              Edit brief
            </button>
            <button className="primary-button" type="button" onClick={() => void generate()} disabled={working !== null}>
              {working === "generate" ? "Generating…" : "Generate this visual"}
            </button>
          </div>
        </section>
      ) : null}

      <section className="visual-library" aria-labelledby="visual-library-heading">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">Saved locally</p>
            <h2 id="visual-library-heading">Visual library</h2>
          </div>
          <p className="quiet-copy">Image bytes and provenance are immutable once saved.</p>
        </div>
        {loadingAssets ? <p className="quiet-copy">Reading saved visuals…</p> : null}
        {!loadingAssets && assets.length === 0 ? (
          <p className="empty-state">No visuals yet. That is fine—use them only when a spatial explanation would genuinely help.</p>
        ) : null}
        <div className="visual-library-grid">
          {assets.map((asset) => (
            <article key={asset.assetId} className="visual-asset">
              <img src={asset.imageUrl} alt={asset.brief.altText} />
              <div>
                <h3>{asset.brief.title}</h3>
                <p>{asset.brief.proseEquivalent}</p>
                <details>
                  <summary>Provenance</summary>
                  <dl>
                    <div><dt>Created</dt><dd>{new Date(asset.createdAt).toLocaleString()}</dd></div>
                    <div><dt>Model</dt><dd>{asset.model} · {asset.quality}</dd></div>
                    <div><dt>Content</dt><dd><code>{asset.contentHash.slice(0, 24)}…</code></dd></div>
                  </dl>
                </details>
              </div>
            </article>
          ))}
        </div>
      </section>
      </div>
    </main>
  );
}
