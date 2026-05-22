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
 * Send a command to the Blockbench bridge. Resolves with the command's
 * `result`, or throws an Error carrying the message reported by Blockbench.
 */
export async function callBlockbench(
  action: string,
  params: Record<string, unknown> = {},
  timeoutMs = 60_000
): Promise<unknown> {
  const id = `req-${++requestCounter}`;
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
    clearTimeout(timer);
    if (err?.name === "AbortError") {
      throw new Error(`Command "${action}" timed out after ${timeoutMs}ms.`);
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
