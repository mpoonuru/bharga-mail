import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  onReload?: () => void;
}

interface State {
  failed: boolean;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Bharga Mail render failed", error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="error-shell">
          <section className="error-panel" role="alert">
            <h1>Bharga Mail couldn’t display this view</h1>
            <p>
              Your mail is still stored locally. Reload the app to restore the interface and try
              again.
            </p>
            <button
              type="button"
              className="af-btn primary"
              onClick={this.props.onReload ?? (() => window.location.reload())}
            >
              Reload Bharga Mail
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
