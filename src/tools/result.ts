import type { SourceResult } from "../sources/types.js";

/**
 * The MCP tool-result shape our tools return (text content + error flag). The
 * index signature mirrors the SDK's CallToolResult (which allows `_meta` and
 * other passthrough keys), so these values satisfy `registerTool` callbacks.
 */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError: boolean;
  [key: string]: unknown;
}

/**
 * Render a SourceResult as an MCP tool result. By convention the absence of
 * `data` (only datagaten) marks the call as an error for the host.
 */
export function toToolResult<T>(result: SourceResult<T>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError: result.data === undefined,
  };
}

/**
 * Run a source call so that ANY unexpected throw becomes an honest blocking
 * datagat instead of propagating into the transport (defense in depth — a bug
 * in normalization must never crash a tool call). Expected upstream failures
 * are already handled inside the source functions; this is the last net.
 */
export async function guarded<T>(code: string, fn: () => Promise<SourceResult<T>>): Promise<ToolResult> {
  try {
    return toToolResult(await fn());
  } catch (err) {
    const message = `Onverwachte fout in de tool: ${err instanceof Error ? err.message : String(err)}`;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { bronregels: [], datagaten: [{ code, message, severity: "blocking" }] },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
}
