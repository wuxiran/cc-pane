import { Component, type ReactNode, type ErrorInfo } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import i18n from "@/i18n";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center gap-4">
          <AlertTriangle className="w-10 h-10 text-destructive opacity-60" />
          <div>
            <h3 className="text-sm font-medium mb-1">
              {this.props.fallbackTitle || i18n.t("errorOccurred")}
            </h3>
            <p className="text-xs text-muted-foreground max-w-md break-all">
              {this.state.error?.message}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={this.handleReset}>
            <RotateCcw size={14} className="mr-1" />
            {i18n.t("retry")}
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
