import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig, isLoopbackHost, PRODUCT_VERSION } from "../../src/config/env.js";

/**
 * The gateway executes commands.  Binding it to a non-loopback address without
 * authentication turns that into an unauthenticated remote execution endpoint,
 * so the configuration layer refuses the combination outright rather than
 * warning about it at request time.
 */

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const CLEAN: Record<string, string | undefined> = {
  CAPS_BIND_MODE: undefined,
  CAPS_HOST: undefined,
  CAPS_AUTH_TOKEN: undefined,
  CAPS_DEFAULT_TIMEOUT_MS: undefined,
  CAPS_MAX_TIMEOUT_MS: undefined,
  CAPS_LOG_LEVEL: undefined,
  CAPS_RETENTION_DAYS: undefined,
};

describe("isLoopbackHost", () => {
  it("accepts every loopback spelling", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "::1", "localhost", "LOCALHOST"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });

  it("rejects wildcards and routable addresses", () => {
    // A wildcard is the exact case that used to silently disable the only
    // network control the gateway had.
    for (const h of ["0.0.0.0", "::", "[::]", "*", "", "10.0.0.5", "192.168.1.10", "example.com", "128.0.0.1"]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});

describe("loadConfig bind boundary", () => {
  it("defaults to a loopback bind with no token", () => {
    withEnv(CLEAN, () => {
      const cfg = loadConfig();
      expect(cfg.bindMode).toBe("local");
      expect(cfg.host).toBe("127.0.0.1");
      expect(cfg.authToken).toBeNull();
    });
  });

  it("REFUSES a non-loopback bind in local mode", () => {
    withEnv({ ...CLEAN, CAPS_BIND_MODE: "local", CAPS_HOST: "0.0.0.0" }, () => {
      // This is the finding: CAPS_HOST=0.0.0.0 used to start silently and
      // expose authenticated-nothing process execution on every interface.
      expect(() => loadConfig()).toThrow(/loopback/i);
    });
  });

  it("REFUSES a routable bind in local mode", () => {
    withEnv({ ...CLEAN, CAPS_BIND_MODE: "local", CAPS_HOST: "10.1.2.3" }, () => {
      expect(() => loadConfig()).toThrow(/loopback/i);
    });
  });

  it("accepts an explicit loopback bind in local mode", () => {
    withEnv({ ...CLEAN, CAPS_BIND_MODE: "local", CAPS_HOST: "::1" }, () => {
      expect(loadConfig().host).toBe("::1");
    });
  });

  it("REFUSES remote mode without a token", () => {
    withEnv({ ...CLEAN, CAPS_BIND_MODE: "remote", CAPS_HOST: "0.0.0.0" }, () => {
      expect(() => loadConfig()).toThrow(/CAPS_AUTH_TOKEN/);
    });
  });

  it("REFUSES a too-short remote token", () => {
    withEnv({ ...CLEAN, CAPS_BIND_MODE: "remote", CAPS_HOST: "0.0.0.0", CAPS_AUTH_TOKEN: "short" }, () => {
      expect(() => loadConfig()).toThrow();
    });
  });

  it("accepts remote mode with a real token", () => {
    withEnv({ ...CLEAN, CAPS_BIND_MODE: "remote", CAPS_HOST: "0.0.0.0", CAPS_AUTH_TOKEN: "a".repeat(48) }, () => {
      const cfg = loadConfig();
      expect(cfg.bindMode).toBe("remote");
      expect(cfg.authToken).toHaveLength(48);
    });
  });

  it("REFUSES a token in local mode, where it would never be checked", () => {
    withEnv({ ...CLEAN, CAPS_BIND_MODE: "local", CAPS_HOST: "127.0.0.1", CAPS_AUTH_TOKEN: "b".repeat(48) }, () => {
      expect(() => loadConfig()).toThrow(/CAPS_AUTH_TOKEN/);
    });
  });
});

describe("loadConfig cross-field validation", () => {
  it("REFUSES a default timeout above the maximum", () => {
    withEnv({ ...CLEAN, CAPS_DEFAULT_TIMEOUT_MS: "90000", CAPS_MAX_TIMEOUT_MS: "30000" }, () => {
      expect(() => loadConfig()).toThrow(/exceeds/);
    });
  });

  it("REFUSES an invalid log level rather than silently defaulting to info", () => {
    withEnv({ ...CLEAN, CAPS_LOG_LEVEL: "verbose" }, () => {
      expect(() => loadConfig()).toThrow();
    });
  });

  it("REFUSES an out-of-range port", () => {
    withEnv({ ...CLEAN, CAPS_PORT: "70000" }, () => {
      expect(() => loadConfig()).toThrow();
    });
  });

  it("REFUSES a negative retention window", () => {
    withEnv({ ...CLEAN, CAPS_RETENTION_DAYS: "-1" }, () => {
      expect(() => loadConfig()).toThrow();
    });
  });

  it("treats retention 0 as a deliberate 'keep everything', not an error", () => {
    withEnv({ ...CLEAN, CAPS_RETENTION_DAYS: "0" }, () => {
      expect(loadConfig().retentionDays).toBe(0);
    });
  });
});

describe("version canonicalisation", () => {
  it("exposes a single product version", () => {
    expect(PRODUCT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    withEnv(CLEAN, () => {
      expect(loadConfig().version).toBe(PRODUCT_VERSION);
    });
  });
});
