import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Called with a human-readable reason when the subtree fails. */
  onError: (reason: string) => void;
  /** Changing this value clears a previous failure, e.g. on retry. */
  resetKey?: string | number;
}

interface State {
  failed: boolean;
  reason: string | null;
}

/**
 * Keeps a 3D failure inside the 3D subtree. A WebGL, three.js, or shader
 * failure must never take down the Execution page: the caller renders a 2D
 * fallback instead.
 */
export class SpaceErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, reason: null };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, reason: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError(`${error.message}${info.componentStack ? ` (${info.componentStack.split("\n")[1]?.trim() ?? "scene"})` : ""}`);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false, reason: null });
  }

  render(): ReactNode {
    if (this.state.failed) return null;
    return this.props.children;
  }
}
