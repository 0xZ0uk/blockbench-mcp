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
    throw new Error(data.error || `Command "${action}" failed.`);
  }
  return data.result;
}

/**
 * Send a command to the Blockbench bridge. Resolves with the command's
 * `result`, or throws an Error carrying the message reported by Blockbench.
 *
 * Retry policy (ticket #20): a timed-out attempt is re-sent exactly once
 * with the identical request before giving up. Safe because bulk creation
 * is idempotent (`dedupe_by_name`, ticket #19). Non-timeout failures —
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
