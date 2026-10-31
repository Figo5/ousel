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

  const dbIn = (dir: string, name: string) =>
    exists(path.join(dir, name)) ? name : null;
  const ouselDb = dbIn(ouselDir, NEW_DB) ?? dbIn(ouselDir, LEGACY_DB);
  const legacyDb = dbIn(legacyDir, LEGACY_DB) ?? dbIn(legacyDir, NEW_DB);

  let dataDir: string;
  let preferred = NEW_DB;
  let notice: string | null = null;

  const explicit = present(env["OUSEL_DATA_DIR"]);
  const legacyExplicit = present(env["AGENTOPS_DATA_DIR"]);
  if (explicit !== null) {
    dataDir = path.resolve(explicit);
    // An explicit directory still has to find a database that is already in
    // it, under either name, rather than create an empty one beside it.
    const here = dbIn(dataDir, NEW_DB) ?? dbIn(dataDir, LEGACY_DB);
    if (here) preferred = here;
  } else if (legacyExplicit !== null) {
    dataDir = path.resolve(legacyExplicit);
    const here = dbIn(dataDir, NEW_DB) ?? dbIn(dataDir, LEGACY_DB);
    if (here) preferred = here;
    notice = "AGENTOPS_DATA_DIR is the legacy name; prefer OUSEL_DATA_DIR";
  } else if (ouselDb !== null) {
    // A real database beats an empty directory: an existing ~/.ousel that
    // holds no data must not hide ~/.agentops history.
    dataDir = ouselDir;
    preferred = ouselDb;
    if (legacyDb !== null)
      notice = `Using ${ouselDir}; an older database also exists in ${legacyDir}`;
  } else if (legacyDb !== null) {
    dataDir = legacyDir;
    preferred = legacyDb;
    notice = `Using legacy data directory ${legacyDir} (no database in ${ouselDir})`;
  } else if (exists(ouselDir)) dataDir = ouselDir;
  else if (exists(legacyDir)) {
    dataDir = legacyDir;
    preferred = LEGACY_DB;
    notice = `Using legacy data directory ${legacyDir} (no database in ${ouselDir})`;
  } else dataDir = ouselDir;

  return {
    dataDir,
    dbPath: path.join(dataDir, preferred),
    port: resolvePort(env),
    notice,
  };
}
