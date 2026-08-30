import { useEffect, useState } from "react";
import type {
  PreparationRunView,
  PreparationSourceView,
  PreparationStateResponse,
} from "../../shared/preparation.js";
import { UtilityBackLink } from "./UtilityBackLink.js";
import "../styles/prepare.css";

type StartMode = "inventory" | "cache";

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json() as T & { readonly error?: string };
  if (!response.ok) throw new Error(body.error ?? fallback);
  return body;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
    timeZoneName: "short",
  }).format(new Date(value));
}

function sourceLabel(source: PreparationSourceView): string {
  return source.origins[0]?.label || new URL(source.requestedUrl).hostname;
}

function sourceStatus(source: PreparationSourceView): string {
  if (source.status === "cached") {
    const kind = source.mediaType === "html" ? "HTML + Markdown" : "PDF";
    return `${kind} · ${(source.byteLength ?? 0).toLocaleString()} bytes`;
  }
  if (source.status === "not_fetched") return "Inventory only";
  if (source.status === "unsupported") return "Unsupported in v1";
  return "Fetch failed safely";
}

function SourceRow({ source }: { readonly source: PreparationSourceView }) {
  return (
    <li className={`prepare-source prepare-source-${source.status}`}>
      <div className="prepare-source-main">
        <div>
          <strong>{sourceLabel(source)}</strong>
          <a href={source.requestedUrl} target="_blank" rel="noreferrer">{source.requestedUrl}</a>
        </div>
        <span className="prepare-source-status">{sourceStatus(source)}</span>
      </div>
      <p>{source.detail}</p>
      <details>
        <summary>Provenance · {source.originCount} curriculum reference{source.originCount === 1 ? "" : "s"}</summary>
        <dl className="prepare-provenance">
          <div><dt>Source ID</dt><dd>{source.sourceId}</dd></div>
          {source.contentHash ? <div><dt>Content hash</dt><dd>{source.contentHash}</dd></div> : null}
          {source.cachePath ? <div><dt>Cached bytes</dt><dd>{source.cachePath}</dd></div> : null}
          {source.markdownPath ? <div><dt>Text projection</dt><dd>{source.markdownPath}</dd></div> : null}
          {source.finalUrl && source.finalUrl !== source.requestedUrl
            ? <div><dt>Final URL</dt><dd>{source.finalUrl}</dd></div>
            : null}
        </dl>
        <ul className="prepare-origin-list">
          {source.origins.map((origin) => (
            <li key={`${origin.sectionId}:${origin.documentId}:${origin.label}`}>
              <strong>{origin.sectionId}</strong> · {origin.label}
              <small>{origin.documentContentHash}</small>
            </li>
          ))}
        </ul>
        {source.originsTruncated ? (
          <p className="prepare-origin-limit">Showing the first {source.origins.length} deterministic origin records.</p>
        ) : null}
      </details>
    </li>
  );
}

function RunLedger({ run }: { readonly run: PreparationRunView }) {
  return (
    <section className="prepare-ledger" aria-labelledby="prepare-ledger-heading">
      <div className="prepare-ledger-heading">
        <div>
          <p className="prepare-eyebrow">Latest immutable run</p>
          <h2 id="prepare-ledger-heading">{formatDate(run.completedAt)}</h2>
        </div>
        <span className={`prepare-run-status prepare-run-${run.status}`}>{run.status}</span>
      </div>
      <dl className="prepare-totals">
        <div><dt>Discovered</dt><dd>{run.discoveredCount}</dd></div>
        <div><dt>Cached</dt><dd>{run.cachedCount}</dd></div>
        <div><dt>Failed safely</dt><dd>{run.failedCount}</dd></div>
        <div><dt>Stored bytes</dt><dd>{run.totalCachedBytes.toLocaleString()}</dd></div>
      </dl>
      {run.inventoryTruncated ? (
        <p className="prepare-notice">The inventory exceeded this run’s {run.limits.maxInventorySources}-reference record limit. Remaining links were left untouched.</p>
      ) : null}
      {run.sources.length === 0 ? (
        <p className="prepare-empty">No verified external HTTPS references were found in the current material manifests.</p>
      ) : (
        <ol className="prepare-source-list">
          {run.sources.map((source) => <SourceRow key={source.sourceId} source={source} />)}
        </ol>
      )}
    </section>
  );
}

/** A deliberately explicit preparation surface. Merely opening it performs no external request. */
export function PreparePage() {
  const [state, setState] = useState<PreparationStateResponse | null>(null);
  const [busy, setBusy] = useState<StartMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/preparation", { signal: controller.signal })
      .then((response) => readJson<PreparationStateResponse>(response, "Preparation state could not be read"))
      .then((value) => {
        if (!controller.signal.aborted) setState(value);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Preparation state could not be read");
        }
      });
    return () => controller.abort();
  }, []);

  const start = async (mode: StartMode) => {
    if (busy !== null) return;
    setBusy(mode);
    setError(null);
    try {
      const response = await fetch("/api/preparation/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fetch: mode === "cache" }),
      });
      const run = await readJson<PreparationRunView>(response, "Preparation did not complete");
      setState({
        latestRun: run,
        externalNetworkIsUserStartedOnly: true,
        enrichment: "disabled",
        transcription: "public-captions-only-not-enabled",
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Preparation did not complete");
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="prepare-page">
      <header className="prepare-header">
        <div>
          <p className="prepare-eyebrow">Reference cache</p>
          <h1>Prepare learner-visible sources</h1>
          <p>
            Inventory verified HTTPS links from the current AISB material manifests, then explicitly choose whether to cache bounded public HTML and PDF sources.
          </p>
        </div>
        <UtilityBackLink />
      </header>

      <section className="prepare-actions" aria-labelledby="prepare-actions-heading">
        <div>
          <h2 id="prepare-actions-heading">Start a local run</h2>
          <p>Opening this page never contacts an external site or starts a model turn.</p>
        </div>
        <div className="prepare-action-buttons">
          <button type="button" disabled={busy !== null} onClick={() => void start("inventory")}>
            {busy === "inventory" ? "Scanning…" : "Inventory links"}
          </button>
          <button className="prepare-primary" type="button" disabled={busy !== null} onClick={() => void start("cache")}>
            {busy === "cache" ? "Fetching safely…" : "Inventory & cache public sources"}
          </button>
        </div>
      </section>

      <div className="prepare-boundary" aria-label="Preparation boundaries">
        <span>HTML/PDF only</span>
        <span>24-source fetch limit</span>
        <span>No Codex enrichment</span>
        <span>No audio transcription</span>
      </div>

      {error ? <p className="prepare-error" role="alert">{error}</p> : null}
      {state === null && error === null ? <p className="prepare-loading" role="status">Reading local preparation history…</p> : null}
      {state?.latestRun ? <RunLedger run={state.latestRun} /> : state ? (
        <p className="prepare-empty">No preparation run yet. Inventorying links is local-only; caching is the explicit network action.</p>
      ) : null}
    </main>
  );
}
