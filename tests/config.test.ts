/**
 * Data directory, database file and port resolution, including every path an
 * existing AgentOps user can arrive by.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveConfig, resolvePort } from "../src/server/config.js";

const HOME = "/home/user";
const OUSEL = path.join(HOME, ".ousel");
const LEGACY = path.join(HOME, ".agentops");

function resolve(env: Record<string, string>, existing: string[] = []) {
  const present = new Set(existing);
  return resolveConfig({
    env,
    home: HOME,
    exists: (target) => present.has(target),
  });
}

test("a fresh machine gets ~/.ousel and ousel.sqlite", () => {
  const config = resolve({});
  assert.equal(config.dataDir, OUSEL);
  assert.equal(config.dbPath, path.join(OUSEL, "ousel.sqlite"));
  assert.equal(config.port, 4317);
  assert.equal(config.notice, null);
});

test("~/.ousel wins over ~/.agentops when both exist", () => {
  const config = resolve({}, [OUSEL, LEGACY]);
  assert.equal(config.dataDir, OUSEL);
  assert.equal(config.dbPath, path.join(OUSEL, "ousel.sqlite"));
});

test("an existing ~/.agentops is used, with a notice, and keeps its file", () => {
  const config = resolve({}, [LEGACY, path.join(LEGACY, "agentops.sqlite")]);
  assert.equal(config.dataDir, LEGACY);
  assert.equal(config.dbPath, path.join(LEGACY, "agentops.sqlite"));
  assert.match(config.notice ?? "", /legacy data directory/i);
});

test("an empty ~/.ousel does not hide a populated ~/.agentops", () => {
  const config = resolve({}, [
    OUSEL,
    LEGACY,
    path.join(LEGACY, "agentops.sqlite"),
  ]);
  assert.equal(config.dataDir, LEGACY);
  assert.equal(config.dbPath, path.join(LEGACY, "agentops.sqlite"));
  assert.match(config.notice ?? "", /legacy data directory/i);
});

test("a populated ~/.ousel wins, and the older database is noted", () => {
  const config = resolve({}, [
    OUSEL,
    LEGACY,
    path.join(OUSEL, "ousel.sqlite"),
    path.join(LEGACY, "agentops.sqlite"),
  ]);
  assert.equal(config.dataDir, OUSEL);
  assert.match(config.notice ?? "", /older database also exists/i);
});

test("an empty legacy directory still uses the legacy file name", () => {
  const config = resolve({}, [LEGACY]);
  assert.equal(config.dbPath, path.join(LEGACY, "agentops.sqlite"));
});

test("OUSEL_DATA_DIR wins over AGENTOPS_DATA_DIR and the home directories", () => {
  const config = resolve(
    { OUSEL_DATA_DIR: "/data/new", AGENTOPS_DATA_DIR: "/data/old" },
    [OUSEL, LEGACY],
  );
  assert.equal(config.dataDir, "/data/new");
  assert.equal(config.dbPath, path.join("/data/new", "ousel.sqlite"));
});

test("AGENTOPS_DATA_DIR is accepted next, and noted as legacy", () => {
  const config = resolve({ AGENTOPS_DATA_DIR: "/data/old" }, [OUSEL]);
  assert.equal(config.dataDir, "/data/old");
  assert.match(config.notice ?? "", /OUSEL_DATA_DIR/);
});

test("a directory holding only the other database name uses that file", () => {
  const onlyLegacy = resolve({ OUSEL_DATA_DIR: "/data/x" }, [
    path.join("/data/x", "agentops.sqlite"),
  ]);
  assert.equal(onlyLegacy.dbPath, path.join("/data/x", "agentops.sqlite"));

  const onlyNew = resolve({}, [LEGACY, path.join(LEGACY, "ousel.sqlite")]);
  assert.equal(onlyNew.dbPath, path.join(LEGACY, "ousel.sqlite"));
});

test("when both files exist the directory's preferred name wins", () => {
  const both = resolve({ OUSEL_DATA_DIR: "/data/x" }, [
    path.join("/data/x", "agentops.sqlite"),
    path.join("/data/x", "ousel.sqlite"),
  ]);
  assert.equal(both.dbPath, path.join("/data/x", "ousel.sqlite"));
});

test("blank variables are treated as unset", () => {
  const config = resolve({ OUSEL_DATA_DIR: "  ", OUSEL_PORT: "" });
  assert.equal(config.dataDir, OUSEL);
  assert.equal(config.port, 4317);
});

test("OUSEL_PORT wins over AGENTOPS_PORT, which still works alone", () => {
  assert.equal(
    resolvePort({ OUSEL_PORT: "4400", AGENTOPS_PORT: "4500" }),
    4400,
  );
  assert.equal(resolvePort({ AGENTOPS_PORT: "4500" }), 4500);
  assert.equal(resolvePort({}), 4317);
});

test("an out-of-range port names the variable that supplied it", () => {
  assert.throws(() => resolvePort({ OUSEL_PORT: "80" }), /OUSEL_PORT/);
  assert.throws(() => resolvePort({ AGENTOPS_PORT: "abc" }), /AGENTOPS_PORT/);
  assert.throws(() => resolvePort({ OUSEL_PORT: "70000" }), /OUSEL_PORT/);
});
