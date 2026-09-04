/**
 * Single source of truth for the server version: `package.json`.
 *
 * Resolved at runtime relative to the compiled file, so it works from a
 * fresh clone, an `npm pack` tarball, and a globally installed bin alike.
 * Fails with an actionable message rather than a wrong version — a
 * hardcoded fallback would silently reintroduce the drift this module
 * exists to prevent.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let pkg: { version: string };
try {
  pkg = require("../package.json") as { version: string };
} catch (err: any) {
  if (err?.code === "MODULE_NOT_FOUND") {
    throw new Error(
      "BlockbenchMCP cannot read package.json next to its build output. " +
        "Run the server from a full checkout/install (npm install && npm run build) " +
        "instead of copying dist/ alone. Original error: " + err?.message
    );
  }
  throw err;
}

export const SERVER_VERSION: string = pkg.version;
