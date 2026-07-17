import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearCommandCache,
  __setTestAuthOverrides,
  getCloudApiKey,
  resolveCredentialKey,
} from "../web-tools.ts";

// Mock child_process so `!command` tests don't spawn real shells.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

// Import the mocked module to control return values in `!command` tests.
import { execSync } from "node:child_process";

const ENV_BACKUP: Record<string, string | undefined> = {};

function saveEnv(...names: string[]) {
  for (const n of names) ENV_BACKUP[n] = process.env[n];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(ENV_BACKUP)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  ENV_BACKUP.length = 0;
}

beforeEach(() => {
  saveEnv("OLLAMA_API_KEY", "MY_VAR", "OTHER_VAR");
  delete process.env.OLLAMA_API_KEY;
  delete process.env.MY_VAR;
  delete process.env.OTHER_VAR;
  vi.clearAllMocks();
});

afterEach(() => {
  __clearCommandCache();
  __setTestAuthOverrides({});
  restoreEnv();
});

describe("resolveCredentialKey — literals", () => {
  it("returns a plain literal key unchanged", () => {
    expect(resolveCredentialKey("sk-literal-123")).toBe("sk-literal-123");
  });

  it("returns undefined for an empty string", () => {
    expect(resolveCredentialKey("")).toBeUndefined();
  });

  it("treats a bare env-var-name (no $) as a literal", () => {
    process.env.MY_VAR = "secret-from-env";
    // 0.80.8 semantics: no `$` prefix => literal, NOT an env reference.
    expect(resolveCredentialKey("MY_VAR")).toBe("MY_VAR");
  });
});

describe("resolveCredentialKey — $VAR / ${VAR} templates", () => {
  it("resolves $VAR when the env var is set", () => {
    process.env.MY_VAR = "resolved-value";
    expect(resolveCredentialKey("$MY_VAR")).toBe("resolved-value");
  });

  it("resolves ${VAR} when the env var is set", () => {
    process.env.MY_VAR = "resolved-value";
    expect(resolveCredentialKey("${MY_VAR}")).toBe("resolved-value");
  });

  it("returns undefined when $VAR env var is missing (so the env fallback is reachable)", () => {
    expect(resolveCredentialKey("$MISSING_VAR")).toBeUndefined();
  });

  it("returns undefined when ${VAR} env var is missing", () => {
    expect(resolveCredentialKey("${MISSING_VAR}")).toBeUndefined();
  });

  it("interpolates $VAR inside a larger string", () => {
    process.env.MY_VAR = "mid";
    expect(resolveCredentialKey("prefix-$MY_VAR-suffix")).toBe("prefix-mid-suffix");
  });

  it("handles $$ as a literal $ and $! as a literal !", () => {
    expect(resolveCredentialKey("a$$b")).toBe("a$b");
    expect(resolveCredentialKey("cost$!5")).toBe("cost!5");
  });
});

describe("resolveCredentialKey — !command", () => {
  it("executes a !command and returns trimmed stdout", () => {
    vi.mocked(execSync).mockReturnValue("command-output\n");
    expect(resolveCredentialKey("!echo hi")).toBe("command-output");
  });

  it("returns undefined when the command fails", () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("boom");
    });
    expect(resolveCredentialKey("!false")).toBeUndefined();
  });

  it("caches command results for the lifetime of the process", () => {
    vi.mocked(execSync).mockReturnValue("first\n");
    expect(resolveCredentialKey("!my-cmd")).toBe("first");
    // Second call should hit the cache (execSync not called again).
    vi.mocked(execSync).mockReturnValue("second\n");
    expect(resolveCredentialKey("!my-cmd")).toBe("first");
  });
});

describe("getCloudApiKey — readStoredCredential path (0.80.8+)", () => {
  it("resolves a $VAR credential before sending it", async () => {
    process.env.OLLAMA_API_KEY = "env-fallback";
    __setTestAuthOverrides({
      readStoredCredential: () => ({ type: "api_key", key: "$OLLAMA_API_KEY" }),
    });
    // No env var named OLLAMA_API_KEY-as-stored... wait, the stored key is the
    // template "$OLLAMA_API_KEY" which resolves process.env["OLLAMA_API_KEY"].
    expect(await getCloudApiKey()).toBe("env-fallback");
  });

  it("falls back to process.env.OLLAMA_API_KEY when the $VAR is missing", async () => {
    process.env.OLLAMA_API_KEY = "env-fallback";
    __setTestAuthOverrides({
      readStoredCredential: () => ({ type: "api_key", key: "$TOTALLY_MISSING" }),
      AuthStorage: undefined,
    });
    expect(await getCloudApiKey()).toBe("env-fallback");
  });

  it("returns a literal credential", async () => {
    __setTestAuthOverrides({
      readStoredCredential: () => ({ type: "api_key", key: "sk-literal" }),
      AuthStorage: undefined,
    });
    expect(await getCloudApiKey()).toBe("sk-literal");
  });

  it("falls through to env fallback when credential is missing entirely", async () => {
    process.env.OLLAMA_API_KEY = "env-fallback";
    __setTestAuthOverrides({ readStoredCredential: () => undefined, AuthStorage: undefined });
    expect(await getCloudApiKey()).toBe("env-fallback");
  });

  it("returns undefined when every path is empty", async () => {
    __setTestAuthOverrides({ readStoredCredential: () => undefined, AuthStorage: undefined });
    expect(await getCloudApiKey()).toBeUndefined();
  });

  it("ignores OAuth credentials and falls through to env fallback", async () => {
    process.env.OLLAMA_API_KEY = "env-fallback";
    __setTestAuthOverrides({
      readStoredCredential: () => ({ type: "oauth", access_token: "token", expires: 0 }),
      AuthStorage: undefined,
    });
    expect(await getCloudApiKey()).toBe("env-fallback");
  });
});
