/**
 * HTTP client that talks to the BlockbenchMCP bridge plugin running inside
 * Blockbench (see plugin/blockbench_mcp.js).
 */

const PORT = Number(process.env.BLOCKBENCH_MCP_PORT) || 8787;
const HOST = process.env.BLOCKBENCH_MCP_HOST || "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

export interface CommandResponse {
  ok: boolean;
  id?: string;
  result?: unknown;
  error?: string;
  stack?: string;
  /** execute_script structured failure phase (ticket #30): compile vs runtime. */
  phase?: string;
  /** 1-based line hint into the user's `code` (wrapper-offset compensated). */
  line?: number;
}

/**
 * Bounded MCP error payload (ticket #30): the raw multi-kilobyte stack
 * never reaches the model — the bridge omits it for execute_script and
 * truncates it elsewhere, and this client truncates the surfaced message
 * as defense-in-depth. Must stay in sync with the plugin's
 * EXEC_SCRIPT_MAX_CHARS.
 */
export const MAX_BRIDGE_ERROR_CHARS = 2000;

function truncateBridgeText(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 3)) + "...";
}

/**
 * Shape a bridge `{ok:false}` payload into the Error thrown to tool
 * handlers (and hence to MCP `isError` text). Structured execute_script
 * failures already arrive as `execute_script <phase> error at line <n>: …`;
 * older builds without `phase`/`line` pass through truncated unchanged.
 */
export function formatBridgeError(action: string, data: CommandResponse): Error {
  const raw = data.error || `Command "${action}" failed.`;
  let message = String(raw);
  const phase = data.phase === "compile" || data.phase === "runtime" ? data.phase : null;
  if (phase && !message.includes(`execute_script ${phase}`)) {
    const linePart = typeof data.line === "number" && Number.isFinite(data.line) ? ` at line ${data.line}` : "";
    message = `execute_script ${phase} error${linePart}: ${message}`;
  }
  message = truncateBridgeText(message, MAX_BRIDGE_ERROR_CHARS);
  const err = new Error(message) as Error & { phase?: string; line?: number };
  if (phase) err.phase = phase;
  if (typeof data.line === "number" && Number.isFinite(data.line)) err.line = data.line;
  return err;
}

let requestCounter = 0;

/**
 * Timeout signal for a single bridge attempt. Carries the exact public
 * timeout message; `callBlockbench` retries on this class only, so
 * bridge-reported errors and connection failures never retry.
 */
class BridgeTimeoutError extends Error {}

/**
 * One POST attempt against the bridge. Throws BridgeTimeoutError on abort,
 * a connection Error when unreachable, or the bridge-reported Error.
 */
async function attemptSend(
  id: string,
  action: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action, params }),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new BridgeTimeoutError(`Command "${action}" timed out after ${timeoutMs}ms.`);
    }
    throw new Error(
      `Cannot reach Blockbench on ${BASE_URL}. Is Blockbench open with the ` +
        `BlockbenchMCP plugin installed and its server started? (${err?.message ?? err})`
    );
  } finally {
    clearTimeout(timer);
  }

  const data = (await response.json()) as CommandResponse;
  if (!data.ok) {
    throw formatBridgeError(action, data);
  }
  return data.result;
}

/**
 * Send a command to the Blockbench bridge. Resolves with the command's
 * `result`, or throws an Error carrying the message reported by Blockbench.
 *
 * Retry policy (ticket #20): a timed-out attempt is re-sent exactly once
 * with the identical request before giving up. Safe when creation runs with
 * `dedupe_by_name:true` (ticket #19); without the flag, a retried creation
 * still duplicates. Non-timeout failures —
 * bridge-reported errors, unreachable bridge — are never retried.
 */
export async function callBlockbench(
  action: string,
  params: Record<string, unknown> = {},
  timeoutMs = 60_000
): Promise<unknown> {
  const id = `req-${++requestCounter}`;
  try {
    return await attemptSend(id, action, params, timeoutMs);
  } catch (err) {
    if (!(err instanceof BridgeTimeoutError)) throw err;
    return await attemptSend(id, action, params, timeoutMs);
  }
}

/** Quick connectivity check. Returns bridge info or throws. */
export async function ping(): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${BASE_URL}/ping`, { signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export { BASE_URL };
