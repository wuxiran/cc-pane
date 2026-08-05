import type { IDisposable, Terminal } from "@xterm/xterm";
import type { TFunction } from "i18next";
import { toast } from "sonner";

import { terminalPathLinkService } from "@/services/terminalPathLinkService";
import { translateError } from "@/utils";
import { useTerminalPathLinkStore } from "@/stores/useTerminalPathLinkStore";
import { classifyOsc8TerminalLink, TerminalPathLinkProvider, type TerminalPathLinkOptions, type TerminalPathReference } from "@/lib/terminalPathLink";

export function createTerminalPathLinkIntegration(
  allowPosixAbsolute: boolean,
  getSessionId: () => string | null,
  isSsh: () => boolean,
  translate: TFunction<"panes">,
) {
  const options: TerminalPathLinkOptions = { allowPosixAbsolute };
  const activate = (reference: TerminalPathReference) => {
    const sessionId = getSessionId();
    if (!sessionId) {
      toast.error(translate("terminalPathLink.sessionUnavailable"));
      return;
    }
    void useTerminalPathLinkStore.getState().open(reference, sessionId).catch((error) => {
      toast.error(translate("terminalPathLink.resolveFailed", { error: translateError(error) }));
    });
  };

  return {
    linkHandler: {
      allowNonHttpProtocols: true,
      activate: (_event: unknown, uri: string) => {
        const target = classifyOsc8TerminalLink(uri, options);
        if (target?.type === "local") {
          if (!isSsh()) activate(target.reference);
          return;
        }
        if (target?.type === "external") {
          void terminalPathLinkService.openExternalUrl(target.url).catch((error) => {
            toast.error(translate("terminalPathLink.actionFailed", { error: translateError(error) }));
          });
        }
      },
    },
    register: (terminal: Terminal): IDisposable =>
      terminal.registerLinkProvider(new TerminalPathLinkProvider(terminal, activate, options)),
  };
}
