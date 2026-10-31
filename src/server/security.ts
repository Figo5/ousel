import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export class LocalGuard {
  readonly token = randomBytes(32).toString("hex");
  private port: number;
  constructor(port: number) {
    this.port = port;
  }
  setPort(port: number) {
    this.port = port;
  }
  /**
   * `tokenRequired: false` drops only the local action token, for `/ingest`.
   *
   * Every other check still applies, and they are the ones that matter here:
   * Host must be this loopback port, a cross-origin or cross-site request is
   * refused outright, and the body must be JSON. A web page in the operator's
   * browser therefore still cannot post events, while any process already
   * running as the operator — which could read the token from the bootstrap
   * endpoint anyway — can report with a single curl and no handshake.
   */
  check(
    req: IncomingMessage,
    res: ServerResponse,
    { tokenRequired = true }: { tokenRequired?: boolean } = {},
  ) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const host = req.headers.host;
    if (
      !host ||
      ![`127.0.0.1:${this.port}`, `localhost:${this.port}`].includes(host)
    )
      throw new HttpError(403, "Untrusted Host");
    if (req.headers.origin && req.headers.origin !== `http://${host}`)
      throw new HttpError(403, "Cross-origin request rejected");
    if (
      req.headers["sec-fetch-site"] &&
      !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"]))
    )
      throw new HttpError(403, "Cross-site request rejected");
    if (!["GET", "HEAD"].includes(req.method ?? "")) {
      if (!req.headers["content-type"]?.startsWith("application/json"))
        throw new HttpError(415, "JSON required");
      if (!tokenRequired) return;
      // `x-ousel-token` is the name; `x-agentops-token` is the pre-rename
      // spelling and carries the same token.
      const provided =
        req.headers["x-ousel-token"] ?? req.headers["x-agentops-token"];
      if (
        typeof provided !== "string" ||
        Buffer.byteLength(provided) !== Buffer.byteLength(this.token) ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(this.token))
      )
        throw new HttpError(403, "Missing or invalid local action token");
    }
  }
}
export async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "Expected a JSON object");
  }
}
export function stringField(
  body: Record<string, unknown>,
  key: string,
  max = 10000,
  optional = false,
): string {
  const v = body[key];
  if (optional && (v === undefined || v === null)) return "";
  if (
    typeof v !== "string" ||
    (!optional && !v.trim()) ||
    v.length > max ||
    v.includes("\0")
  )
    throw new HttpError(400, `Invalid ${key}`);
  return v;
}
/** Single owner per database. Stale locks are reclaimed only after an ESRCH existence probe. */
export function acquireLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lock = path.join(dataDir, "server.lock"),
    guard = lock + ".guard";
  try {
    mkdirSync(guard, { mode: 0o700 });
  } catch {
    throw new Error(
      "Another database lock acquisition is in progress; inspect server.lock.guard if a startup crashed",
    );
  }
  const owner = `${process.pid}:${randomBytes(16).toString("hex")}`;
  try {
    try {
      const previous = readFileSync(path.join(lock, "owner"), "utf8");
      const pid = Number(previous.split(":")[0]);
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error("Invalid database lock; inspect server.lock");
      try {
        process.kill(pid, 0);
        throw new Error("Another Ousel server owns this database");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(path.join(lock, "owner"), owner, { mode: 0o600 });
    return () => {
      try {
        if (readFileSync(path.join(lock, "owner"), "utf8") === owner)
          rmSync(lock, { recursive: true, force: true });
      } catch {
        /* ownership already released */
      }
    };
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}
