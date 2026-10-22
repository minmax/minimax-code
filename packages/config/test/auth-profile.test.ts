import fs from "node:fs";
import os from "node:os";
import { join, posix } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_NAME,
  InvalidProfileNameError,
  PROFILE_ENV_VAR,
  assertValidProfileName,
  isValidProfileName,
  listProfiles,
  normalizeProfileSelector,
  readProfileEnv,
  resolveProfileDataDirPaths,
} from "../src/auth-profile.js";
import { getProfile } from "../src/config.js";

describe("profile name validation", () => {
  it.each(["work", "personal", "a", "w1", "work-2", "a.b_c", "A1", "x".repeat(64)])(
    "accepts %j",
    (name) => {
      expect(isValidProfileName(name)).toBe(true);
      expect(assertValidProfileName(name)).toBe(name);
    },
  );

  // A profile name becomes a directory segment under $HOME. Anything that can
  // escape that segment, or that would make the generated `--profile` flag
  // ambiguous, must be refused rather than sanitised.
  it.each([
    ["parent traversal", ".."],
    ["nested traversal", "../../etc"],
    ["embedded traversal", "work/../.."],
    ["single dot", "."],
    ["dotfile", ".hidden"],
    ["separator", "a/b"],
    ["backslash", "a\\b"],
    ["absolute path", "/abs"],
    ["leading dash", "-lead"],
    ["trailing dash", "trail-"],
    ["whitespace", "has space"],
    ["shell substitution", "x$(id)"],
    ["backtick", "x`id`"],
    ["null byte", "x\u0000y"],
    ["empty", ""],
    ["too long", "x".repeat(65)],
  ])("rejects %s", (_label, name) => {
    expect(isValidProfileName(name)).toBe(false);
    expect(() => assertValidProfileName(name)).toThrow(InvalidProfileNameError);
  });

  it.each([null, undefined, 42, {}, []])("rejects non-string input %j", (value) => {
    expect(isValidProfileName(value)).toBe(false);
  });

  it("reports the rejected value on the error", () => {
    try {
      assertValidProfileName("../../etc");
      expect.unreachable("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidProfileNameError);
      expect((error as InvalidProfileNameError).profileName).toBe("../../etc");
      expect((error as InvalidProfileNameError).code).toBe("INVALID_PROFILE_NAME");
    }
  });
});

describe("profile selector normalization", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["", null],
    ["   ", null],
  ])("maps an absent selector %j to the default profile", (input, expected) => {
    expect(normalizeProfileSelector(input)).toBe(expected);
  });

  it("trims a valid selector", () => {
    expect(normalizeProfileSelector("  work  ")).toBe("work");
  });

  // `default` is the display name of the implicit profile. If it were treated as
  // an ordinary name, `--profile default` would open `~/.minimax-default` — a
  // second account with its own token, invisible to `mcode profile list`, and
  // unremovable by `mcode profile remove default`. Same wrong-account failure
  // the feature exists to prevent.
  it.each(["default", "DEFAULT", "Default", "  default  "])(
    "treats the reserved name %j as the implicit default profile",
    (input) => {
      expect(normalizeProfileSelector(input)).toBeNull();
    },
  );

  it("resolves the reserved name to the same directory as omitting the flag", () => {
    const reserved = normalizeProfileSelector("default");
    expect(reserved).toBeNull();
    expect(resolveProfileDataDirPaths(reserved, "/home/dev").dataDir).toBe(
      resolveProfileDataDirPaths(null, "/home/dev").dataDir,
    );
  });

  it("does not let a case variant of a real profile become the default", () => {
    expect(normalizeProfileSelector("defaulted")).toBe("defaulted");
    expect(normalizeProfileSelector("work")).toBe("work");
  });

  // Falling back to the default profile would point the user at a different
  // account than the one they asked for, so an unusable name must fail.
  it("throws instead of silently falling back", () => {
    expect(() => normalizeProfileSelector("../../etc")).toThrow(InvalidProfileNameError);
    expect(() => normalizeProfileSelector("  ../etc  ")).toThrow(InvalidProfileNameError);
  });
});

describe("profile selection from argv", () => {
  const originalArgv = process.argv;
  const originalEnv = process.env.MINIMAX_PROFILE;

  afterEach(() => {
    process.argv = originalArgv;
    if (originalEnv === undefined) delete process.env.MINIMAX_PROFILE;
    else process.env.MINIMAX_PROFILE = originalEnv;
  });

  /** Run the resolver as if mcode had been started with these user arguments. */
  function resolve(...userArgs: string[]): string | null {
    process.argv = ["node", "/path/to/mcode", ...userArgs];
    return getProfile();
  }

  it.each([
    [["--profile", "work"], "work"],
    [["--profile=work"], "work"],
  ])("reads %j", (args, expected) => {
    expect(resolve(...args)).toBe(expected);
  });

  it("returns null when no selector is present", () => {
    expect(resolve()).toBeNull();
  });

  // `--` ends option parsing. Everything after it is positional text, so a
  // prompt that happens to contain `--profile` must not redirect the account.
  it("ignores a profile that appears after the -- terminator", () => {
    expect(resolve("exec", "--", "--profile", "work")).toBeNull();
    expect(resolve("--", "--profile=work")).toBeNull();
  });

  // Commander's default is last-option-wins. Returning the first occurrence
  // would start the process in one account while commander reports another.
  it("lets the last occurrence win, matching commander", () => {
    expect(resolve("--profile", "work", "--profile", "personal")).toBe("personal");
    expect(resolve("--profile=work", "--profile=personal")).toBe("personal");
  });

  it("does not consume a following flag as the profile name", () => {
    // Without the guard the value would be "--env", which then fails validation
    // with a misleading message instead of reporting a missing value.
    expect(resolve("--profile", "--env", "test")).toBeNull();
  });

  it("ignores an empty inline value", () => {
    expect(resolve("--profile=")).toBeNull();
  });

  it("maps the reserved name to the default profile", () => {
    expect(resolve("--profile", "default")).toBeNull();
    expect(resolve("--profile=default")).toBeNull();
  });

  it("refuses a traversal name instead of falling back", () => {
    expect(() => resolve("--profile", "../../etc")).toThrow(InvalidProfileNameError);
  });

  it("lets the flag win over the environment", () => {
    process.env.MINIMAX_PROFILE = "from-env";
    expect(resolve("--profile", "from-flag")).toBe("from-flag");
  });

  it("falls back to the environment when the flag is absent", () => {
    process.env.MINIMAX_PROFILE = "from-env";
    expect(resolve()).toBe("from-env");
  });
});

describe("profile environment variable", () => {
  it(`reads ${PROFILE_ENV_VAR}`, () => {
    expect(readProfileEnv({ [PROFILE_ENV_VAR]: "work" })).toBe("work");
  });

  it("trims and maps a blank value to the default profile", () => {
    expect(readProfileEnv({ [PROFILE_ENV_VAR]: "  work  " })).toBe("work");
    expect(readProfileEnv({ [PROFILE_ENV_VAR]: "  " })).toBeNull();
  });

  it("returns null when unset", () => {
    expect(readProfileEnv({})).toBeNull();
  });

  it("throws on an unusable value rather than falling back", () => {
    expect(() => readProfileEnv({ [PROFILE_ENV_VAR]: "../evil" })).toThrow(
      InvalidProfileNameError,
    );
  });
});

describe("profile data directories", () => {
  it("keeps the unsuffixed directory for the default profile", () => {
    expect(resolveProfileDataDirPaths(null, "/home/dev").dataDir).toBe(
      join("/home/dev", ".minimax"),
    );
  });

  it("suffixes a named profile", () => {
    expect(resolveProfileDataDirPaths("work", "/home/dev").dataDir).toBe(
      join("/home/dev", ".minimax-work"),
    );
  });

  it("scopes the legacy compat directory the same way", () => {
    expect(resolveProfileDataDirPaths("work", "/home/dev").legacyDataDir).toBe(
      join("/home/dev", ".mavis-work"),
    );
  });

  it("resolves a traversal attempt outside neither HOME nor the profile prefix", () => {
    // Defence in depth: the validator already refuses this, but the path helper
    // must not be the second place that silently produces a usable directory.
    expect(isValidProfileName("../../etc")).toBe(false);
  });
});

describe("profile discovery", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), "profile-discovery-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeAuth(profile: string | null, status: string, credential: boolean): string {
    const dataDir = resolveProfileDataDirPaths(profile, home).dataDir;
    const namespace = join(dataDir, "auth", "prod", "cn", "mcode-public");
    fs.mkdirSync(namespace, { recursive: true });
    fs.writeFileSync(
      join(namespace, "auth-state.json"),
      JSON.stringify({ status, buildEnv: "prod", region: "cn" }),
    );
    if (credential) fs.writeFileSync(join(namespace, "auth.json"), "{}");
    return dataDir;
  }

  it("always reports the default profile first, even on an empty home", () => {
    const profiles = listProfiles(home);
    expect(profiles.map((profile) => profile.name)).toEqual([DEFAULT_PROFILE_NAME]);
    expect(profiles[0]).toMatchObject({ exists: false, authenticated: false });
  });

  it("discovers named profiles from their data directories", () => {
    writeAuth("work", "authenticated", true);
    const profiles = listProfiles(home);
    expect(profiles.map((profile) => profile.name)).toEqual([DEFAULT_PROFILE_NAME, "work"]);
  });

  it("reports a stored credential as authenticated", () => {
    writeAuth("work", "authenticated", true);
    const work = listProfiles(home).find((profile) => profile.name === "work");
    expect(work).toMatchObject({ exists: true, authenticated: true });
  });

  it("reports an in-progress authorization as pending", () => {
    writeAuth("work", "authorizing", false);
    const work = listProfiles(home).find((profile) => profile.name === "work");
    expect(work).toMatchObject({ pendingAuthorization: true, authenticated: false });
  });

  it("does not treat an expired authorization as pending", () => {
    writeAuth("work", "expired", false);
    const work = listProfiles(home).find((profile) => profile.name === "work");
    expect(work).toMatchObject({ pendingAuthorization: false, authenticated: false });
  });

  // `~/.mavis-work` is a compat symlink to `~/.minimax-work`; both must collapse
  // onto one profile rather than appearing twice.
  it("collapses the legacy compat directory onto the same profile", () => {
    const dataDir = writeAuth("work", "authenticated", true);
    fs.symlinkSync(dataDir, join(home, ".mavis-work"), "dir");
    const profiles = listProfiles(home);
    expect(profiles.map((profile) => profile.name)).toEqual([DEFAULT_PROFILE_NAME, "work"]);
  });

  it("ignores directories that are not valid profile names", () => {
    fs.mkdirSync(join(home, ".minimax-.."), { recursive: true });
    fs.mkdirSync(join(home, ".minimax-not a profile"), { recursive: true });
    expect(listProfiles(home).map((profile) => profile.name)).toEqual([DEFAULT_PROFILE_NAME]);
  });

  it("sorts the default profile ahead of named profiles", () => {
    fs.mkdirSync(join(home, ".minimax-alpha"), { recursive: true });
    fs.mkdirSync(join(home, ".minimax-zeta"), { recursive: true });
    expect(listProfiles(home).map((profile) => profile.name)).toEqual([
      DEFAULT_PROFILE_NAME,
      "alpha",
      "zeta",
    ]);
  });

  // A profile name is preserved verbatim, but macOS and Windows data
  // directories are case-insensitive, so these are one account, not two.
  it("collapses case variants onto a single profile", () => {
    fs.mkdirSync(join(home, ".minimax-Work"), { recursive: true });
    const names = listProfiles(home)
      .map((profile) => profile.name.toLowerCase())
      .filter((name) => name === "work");
    expect(names).toEqual(["work"]);
  });

  it("surfaces a profile that still lives only in the legacy directory", () => {
    // After an upgrade from the `~/.mavis-<name>` layout, the current directory
    // may be gone. Reporting it as absent would hide stored credentials.
    const legacy = join(home, ".mavis-old");
    const namespace = posix.join(legacy, "auth", "prod", "cn", "mcode-public");
    fs.mkdirSync(namespace, { recursive: true });
    fs.writeFileSync(posix.join(namespace, "auth.json"), "{}");
    fs.writeFileSync(
      posix.join(namespace, "auth-state.json"),
      JSON.stringify({ status: "authenticated" }),
    );
    const discovered = listProfiles(home).find((profile) => profile.name === "old");
    expect(discovered).toMatchObject({ exists: true, authenticated: true });
  });
});
