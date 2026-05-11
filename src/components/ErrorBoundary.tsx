import React from "react";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; label?: string },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ""}]`, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-5 text-xs text-accent-red font-mono whitespace-pre-wrap break-all overflow-auto">
          <div className="text-sm font-semibold mb-2">
            ⚠ Render error{this.props.label ? ` in ${this.props.label}` : ""}
          </div>
          <div className="opacity-80">{this.state.error.message}</div>
          {this.state.error.stack && (
            <div className="mt-2 text-text-dim text-[10px]">{this.state.error.stack}</div>
          )}
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-3 h-7 px-3 rounded bg-accent-cyan/15 border border-accent-cyan/40 text-accent-cyan"
          >
            Reset
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
