/**
 * Where Ousel keeps its data and which port it listens on.
 *
 * Pure: the filesystem is passed in as `exists`, so every resolution case is
 * asserted in `tests/config.test.ts` without touching a real home directory.
 *
 * Existing AgentOps users must keep their data. So the legacy variables and the
 * legacy `~/.agentops` directory still work, and an existing database file is
 * found under either name rather than silently replaced by an empty one.
 */
import path from "node:path";

export interface ConfigInput {
  env: Record<string, string | undefined>;
  home: string;
  /** Whether a file or directory exists. */
  exists: (target: string) => boolean;
}

export interface ResolvedConfig {
  dataDir: string;
  dbPath: string;
  port: number;
  /** A one-line notice for the startup log, or null when there is nothing to say. */
  notice: string | null;
}

const NEW_DB = "ousel.sqlite";
const LEGACY_DB = "agentops.sqlite";

function present(value: string | undefined): string | null {
  return value !== undefined && value.trim() !== "" ? value.trim() : null;
}

/** `OUSEL_PORT` wins over the legacy `AGENTOPS_PORT`; the default is 4317. */
export function resolvePort(env: ConfigInput["env"]): number {
  const ousel = present(env["OUSEL_PORT"]);
  const legacy = present(env["AGENTOPS_PORT"]);
  const name = ousel !== null ? "OUSEL_PORT" : "AGENTOPS_PORT";
  const raw = ousel ?? legacy ?? "4317";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error(`${name} must be between 1024 and 65535`);
  return port;
}

export function resolveConfig(input: ConfigInput): ResolvedConfig {
  const { env, home, exists } = input;
  const ouselDir = path.join(home, ".ousel");
  const legacyDir = path.join(home, ".agentops");

  let dataDir: string;
  let notice: string | null = null;
  let preferred = NEW_DB;

  const explicit = present(env["OUSEL_DATA_DIR"]);
  const legacyExplicit = present(env["AGENTOPS_DATA_DIR"]);
  if (explicit !== null) dataDir = path.resolve(explicit);
  else if (legacyExplicit !== null) {
    dataDir = path.resolve(legacyExplicit);
    notice = "AGENTOPS_DATA_DIR is the legacy name; prefer OUSEL_DATA_DIR";
  } else if (exists(ouselDir)) dataDir = ouselDir;
  else if (exists(legacyDir)) {
    dataDir = legacyDir;
    preferred = LEGACY_DB;
    notice = `Using legacy data directory ${legacyDir} (no ${ouselDir} found)`;
  } else dataDir = ouselDir;

  // A directory that holds only the other name keeps using that file, so data
  // written before the rename is found rather than shadowed by a new database.
  const other = preferred === NEW_DB ? LEGACY_DB : NEW_DB;
  const file = exists(path.join(dataDir, preferred))
    ? preferred
    : exists(path.join(dataDir, other))
      ? other
      : preferred;

  return {
    dataDir,
    dbPath: path.join(dataDir, file),
    port: resolvePort(env),
    notice,
  };
}
