import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PiAgUiBridge } from "./bridge.js";

export default function piAgUiBridge(pi: ExtensionAPI): void {
  const bridge = new PiAgUiBridge(pi);

  const forward = (event: { type: string; [key: string]: any }, ctx: ExtensionContext): void => {
    bridge.setContext(ctx);
    bridge.handleEvent(event, ctx);
  };

  pi.on("session_start", async (event, ctx) => {
    await bridge.start(ctx);
    forward(event, ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(`Pi AG-UI bridge running: ${bridge.describe()}`, "info");
    }
  });

  pi.on("session_shutdown", async () => {
    await bridge.stop();
  });

  pi.on("session_tree", async (event, ctx) => forward(event, ctx));
  pi.on("session_compact", async (event, ctx) => forward(event, ctx));
  pi.on("input", async (event, ctx) => forward(event, ctx));
  pi.on("agent_start", async (event, ctx) => forward(event, ctx));
  pi.on("agent_end", async (event, ctx) => forward(event, ctx));
  pi.on("message_start", async (event, ctx) => forward(event, ctx));
  pi.on("message_update", async (event, ctx) => forward(event, ctx));
  pi.on("message_end", async (event, ctx) => forward(event, ctx));
  pi.on("tool_execution_start", async (event, ctx) => forward(event, ctx));
  pi.on("tool_execution_update", async (event, ctx) => forward(event, ctx));
  pi.on("tool_execution_end", async (event, ctx) => forward(event, ctx));
  pi.on("model_select", async (event, ctx) => forward(event, ctx));
  pi.on("thinking_level_select", async (event, ctx) => forward(event, ctx));

  pi.registerCommand("agui-bridge-info", {
    description: "Show Pi AG-UI bridge status",
    handler: async (_args, ctx) => {
      bridge.setContext(ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(bridge.describe(), "info");
      }
    },
  });

  pi.registerCommand("agui-bridge-reset-auth", {
    description: "Clear all Pi AG-UI bridge pairings",
    handler: async (_args, ctx) => {
      bridge.resetAuth();
      if (ctx.hasUI) {
        ctx.ui.notify("Cleared Pi AG-UI bridge pairings.", "info");
      }
    },
  });
}
