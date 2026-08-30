import { Component, Suspense, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";

interface DeferredRouteProps {
  readonly children: ReactNode;
}

interface DeferredRouteState {
  readonly failed: boolean;
}

class DeferredRouteErrorBoundary extends Component<DeferredRouteProps, DeferredRouteState> {
  public state: DeferredRouteState = { failed: false };

  public static getDerivedStateFromError(): DeferredRouteState {
    return { failed: true };
  }

  public componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("A deferred route could not load.", error, info.componentStack);
  }

  public render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="app-error">
          <div>
            <p className="page-kicker">Page unavailable</p>
            <h1>This page could not load.</h1>
            <p>Reload to try the local bundle again, or return to the notebook.</p>
            <div className="deferred-route-actions">
              <button className="primary-button" type="button" onClick={() => window.location.reload()}>
                Reload page
              </button>
              <Link className="outline-button" to="/">Return to the notebook</Link>
            </div>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

export function DeferredRoute({ children }: DeferredRouteProps) {
  return (
    <DeferredRouteErrorBoundary>
      <Suspense fallback={<main className="app-loading" role="status">Opening this notebook page…</main>}>
        {children}
      </Suspense>
    </DeferredRouteErrorBoundary>
  );
}
