import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SESSIONS_GENERATION,
  DURABLE_CAS_DIR_BASENAME,
  DURABLE_ROOT_BASENAME,
  DURABLE_RUNTIME_DB_BASENAME,
  DURABLE_SESSIONS_DB_BASENAME,
  DURABLE_SOCKET_BASENAME,
  LEGACY_ROOT,
  LegacyWriteError,
  assertNoLegacyWrite,
  ensureDurableLayout,
  resolveCasDirPath,
  resolveDurableRoot,
  resolveMcodedSocketPath,
  resolveRuntimeDbPath,
  resolveSessionsDbPath,
} from "../src/durable-paths.js";
import { InvalidProfileNameError } from "../src/auth-profile.js";

describe("durable root resolution", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), "durable-root-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("resolves the unsuffixed root for the default profile", () => {
    const expected = join(home, DURABLE_ROOT_BASENAME);
    expect(resolveDurableRoot(undefined, home)).toBe(expected);
    expect(resolveDurableRoot(null, home)).toBe(expected);
  });

  it.each(["", "   ", "default"])("maps the absent selector %j to the unsuffixed root", (profile) => {
    expect(resolveDurableRoot(profile, home)).toBe(join(home, DURABLE_ROOT_BASENAME));
  });

  it("suffixes a named profile", () => {
    expect(resolveDurableRoot("work", home)).toBe(join(home, `${DURABLE_ROOT_BASENAME}-work`));
  });

  // The profile name becomes a directory segment under $HOME, so the same
  // allowlist as the auth profile applies: an unusable name must be refused,
  // not sanitised into some other directory.
  it.each(["../evil", "a/b", "-lead"])("refuses the profile name %j", (profile) => {
    expect(() => resolveDurableRoot(profile, home)).toThrow(InvalidProfileNameError);
  });

  it("keeps the durable root separate from the legacy data directory", () => {
    expect(DURABLE_ROOT_BASENAME).toBe(".mcode-durable");
    expect(LEGACY_ROOT).toBe(join(os.homedir(), ".minimax"));
  });
});

describe("session database generations", () => {
  const root = join("/home", "dev", DURABLE_ROOT_BASENAME);

  it("resolves the first generation by default", () => {
    expect(resolveSessionsDbPath(root)).toBe(join(root, "sessions.g1.db"));
    expect(DEFAULT_SESSIONS_GENERATION).toBe(1);
  });

  it("resolves an explicit generation next to the previous one", () => {
    expect(resolveSessionsDbPath(root, 2)).toBe(join(root, "sessions.g2.db"));
    expect(resolveSessionsDbPath(root, 2)).toContain(DURABLE_SESSIONS_DB_BASENAME);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects the generation %j", (generation) => {
    expect(() => resolveSessionsDbPath(root, generation)).toThrow(RangeError);
  });
});

describe("durable layout paths", () => {
  const root = join("/home", "dev", DURABLE_ROOT_BASENAME);

  it("resolves the blob store, service tables, and daemon socket", () => {
    expect(resolveCasDirPath(root)).toBe(join(root, DURABLE_CAS_DIR_BASENAME));
    expect(resolveRuntimeDbPath(root)).toBe(join(root, DURABLE_RUNTIME_DB_BASENAME));
    expect(resolveMcodedSocketPath(root)).toBe(join(root, DURABLE_SOCKET_BASENAME));
  });

  it("pins the documented file names", () => {
    expect(DURABLE_CAS_DIR_BASENAME).toBe("cas");
    expect(DURABLE_RUNTIME_DB_BASENAME).toBe("runtime.db");
    expect(DURABLE_SOCKET_BASENAME).toBe("mcoded.sock");
  });
});

describe("legacy write guard", () => {
  let home: string;
  let legacyRoot: string;

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), "legacy-guard-"));
    legacyRoot = join(home, ".minimax");
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("allows the durable root and everything under it", () => {
    const durable = join(home, DURABLE_ROOT_BASENAME);
    expect(assertNoLegacyWrite(durable, legacyRoot)).toBe(durable);
    expect(assertNoLegacyWrite(join(durable, "runtime.db"), legacyRoot)).toBe(
      join(durable, "runtime.db"),
    );
  });

  it("allows paths elsewhere under the home directory", () => {
    expect(assertNoLegacyWrite(join(home, "projects", "notes.txt"), legacyRoot)).toBe(
      join(home, "projects", "notes.txt"),
    );
  });

  it("allows the home directory itself", () => {
    expect(assertNoLegacyWrite(home, legacyRoot)).toBe(home);
  });

  it("blocks the legacy root and everything inside it", () => {
    expect(() => assertNoLegacyWrite(legacyRoot, legacyRoot)).toThrow(LegacyWriteError);
    expect(() => assertNoLegacyWrite(join(legacyRoot, "auth", "token.json"), legacyRoot)).toThrow(
      LegacyWriteError,
    );
  });

  // The legacy family includes the profile-suffixed siblings: the durable
  // rule is "no writes to `~/.minimax*`", not just the unsuffixed directory.
  it("blocks the profile-suffixed legacy directories", () => {
    expect(() => assertNoLegacyWrite(join(home, ".minimax-work", "auth.json"), legacyRoot)).toThrow(
      LegacyWriteError,
    );
  });

  it("blocks traversal spellings that resolve into the legacy root", () => {
    expect(() => assertNoLegacyWrite(join(home, "projects", "..", ".minimax", "db"), legacyRoot)).toThrow(
      LegacyWriteError,
    );
  });

  it("reports the refused path on the error", () => {
    const target = join(legacyRoot, "sessions.sqlite");
    try {
      assertNoLegacyWrite(target, legacyRoot);
      expect.unreachable("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(LegacyWriteError);
      expect((error as LegacyWriteError).code).toBe("LEGACY_WRITE_FORBIDDEN");
      expect((error as LegacyWriteError).targetPath).toBe(target);
      expect((error as LegacyWriteError).legacyRoot).toBe(legacyRoot);
    }
  });

  it("defaults to the real legacy root", () => {
    expect(() => assertNoLegacyWrite(join(LEGACY_ROOT, "config.yaml"))).toThrow(LegacyWriteError);
    expect(assertNoLegacyWrite(join(os.tmpdir(), "somewhere-else", "data.db"))).toBe(
      join(os.tmpdir(), "somewhere-else", "data.db"),
    );
  });
});

describe("durable layout creation", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), "durable-layout-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("creates the root and the blob store directory", () => {
    const root = join(home, DURABLE_ROOT_BASENAME);
    ensureDurableLayout(root);
    expect(fs.statSync(root).isDirectory()).toBe(true);
    expect(fs.statSync(resolveCasDirPath(root)).isDirectory()).toBe(true);
  });

  it("leaves files to their owners", () => {
    const root = join(home, DURABLE_ROOT_BASENAME);
    ensureDurableLayout(root);
    expect(fs.readdirSync(root)).toEqual([DURABLE_CAS_DIR_BASENAME]);
  });

  it("is idempotent", () => {
    const root = join(home, DURABLE_ROOT_BASENAME);
    ensureDurableLayout(root);
    ensureDurableLayout(root);
    expect(fs.readdirSync(root)).toEqual([DURABLE_CAS_DIR_BASENAME]);
  });

  // The guard fires before any filesystem call, so a misconfigured root inside
  // the legacy family is refused without touching the disk.
  it("refuses a root inside the legacy root", () => {
    const escape = join(LEGACY_ROOT, "escape");
    expect(() => ensureDurableLayout(escape)).toThrow(LegacyWriteError);
    expect(fs.existsSync(escape)).toBe(false);
  });
});
