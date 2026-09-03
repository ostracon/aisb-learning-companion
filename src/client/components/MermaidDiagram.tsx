import { useEffect, useId, useMemo, useState } from "react";

import { MarkdownCodeBlock } from "./MarkdownCodeBlock.js";

type MermaidApi = typeof import("mermaid")["default"];

interface MermaidRenderState {
  readonly status: "loading" | "ready" | "error";
  readonly svg?: string;
}

let mermaidPromise: Promise<MermaidApi> | null = null;

async function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "base",
        fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        htmlLabels: true,
        flowchart: {
          useMaxWidth: true,
          curve: "linear",
        },
        maxEdges: 1_000,
        maxTextSize: 50_000,
        themeVariables: {
          background: "#f5f1e8",
          primaryColor: "#fbf8f1",
          primaryTextColor: "#171715",
          primaryBorderColor: "#145edb",
          lineColor: "#287494",
          secondaryColor: "#eee9df",
          tertiaryColor: "#f5f1e8",
          clusterBkg: "#f5f1e8",
          clusterBorder: "#cfc7b9",
          edgeLabelBackground: "#f5f1e8",
          fontSize: "14px",
        },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

export interface MermaidDiagramProps {
  readonly source: string;
}

/** Lazy, strict Mermaid rendering for app-owned Markdown surfaces. */
export function MermaidDiagram({ source }: MermaidDiagramProps) {
  const reactId = useId();
  const diagramId = useMemo(
    () => `aisb-mermaid-${reactId.replace(/[^a-z0-9_-]/giu, "")}`,
    [reactId],
  );
  const [renderState, setRenderState] = useState<MermaidRenderState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setRenderState({ status: "loading" });

    void loadMermaid()
      .then((mermaid) => mermaid.render(diagramId, source))
      .then(({ svg }) => {
        if (active) setRenderState({ status: "ready", svg });
      })
      .catch(() => {
        if (active) setRenderState({ status: "error" });
      });

    return () => {
      active = false;
    };
  }, [diagramId, source]);

  if (renderState.status === "error") {
    return (
      <div className="markdown-mermaid-error" role="note">
        <p>Diagram could not be rendered; source shown below.</p>
        <MarkdownCodeBlock>
          <code className="language-mermaid">{source}</code>
        </MarkdownCodeBlock>
      </div>
    );
  }

  return (
    <figure className="markdown-mermaid" aria-label="Mermaid diagram">
      {renderState.status === "loading" ? (
        <div className="markdown-mermaid-loading" role="status">Rendering diagram…</div>
      ) : (
        <div
          className="markdown-mermaid-svg"
          dangerouslySetInnerHTML={{ __html: renderState.svg ?? "" }}
        />
      )}
    </figure>
  );
}
