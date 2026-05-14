import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig, sanitized } from "../src/config.js";

const baseEnv = {
  KOMODO_URL: "https://komo.example.com/",
  KOMODO_API_KEY: "key123",
  KOMODO_API_SECRET: "secret456",
};

describe("loadConfig", () => {
  it("loads with sensible defaults", () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.komodoUrl).toBe("https://komo.example.com");
    expect(cfg.apiKey).toBe("key123");
    expect(cfg.apiSecret).toBe("secret456");
    expect(cfg.exporterPort).toBe(9105);
    expect(cfg.fastPollInterval).toBe(15);
    expect(cfg.slowPollInterval).toBe(300);
    expect(cfg.metaPollInterval).toBe(1800);
    expect(cfg.requestTimeout).toBe(30);
    expect(cfg.logLevel).toBe("info");
    expect(cfg.logFormat).toBe("text");
  });

  it.each([
    ["KOMODO_URL", "KOMODO_URL is required"],
    ["KOMODO_API_KEY", "KOMODO_API_KEY is required"],
    ["KOMODO_API_SECRET", "KOMODO_API_SECRET is required"],
  ])("throws when %s is missing", (key, message) => {
    const env = { ...baseEnv, [key]: "" };
    expect(() => loadConfig(env)).toThrowError(new ConfigError(message));
  });

  it("rejects non-integer poll intervals", () => {
    expect(() =>
      loadConfig({ ...baseEnv, FAST_POLL_INTERVAL: "abc" }),
    ).toThrowError(/FAST_POLL_INTERVAL must be an integer/);
  });

  it("rejects out-of-range port", () => {
    expect(() => loadConfig({ ...baseEnv, EXPORTER_PORT: "0" })).toThrowError(
      /EXPORTER_PORT must be >= 1/,
    );
    expect(() =>
      loadConfig({ ...baseEnv, EXPORTER_PORT: "70000" }),
    ).toThrowError(/EXPORTER_PORT must be <= 65535/);
  });

  it("rejects unknown log format / level", () => {
    expect(() =>
      loadConfig({ ...baseEnv, LOG_FORMAT: "yaml" }),
    ).toThrowError(/LOG_FORMAT must be 'text' or 'json'/);
    expect(() =>
      loadConfig({ ...baseEnv, LOG_LEVEL: "trace" }),
    ).toThrowError(/LOG_LEVEL must be one of/);
  });

  it("normalizes 'warning' to 'warn'", () => {
    expect(loadConfig({ ...baseEnv, LOG_LEVEL: "WARNING" }).logLevel).toBe("warn");
  });

  it("strips trailing slash and accepts json log format", () => {
    const cfg = loadConfig({
      ...baseEnv,
      KOMODO_URL: "https://example.com/",
      LOG_FORMAT: "JSON",
    });
    expect(cfg.komodoUrl).toBe("https://example.com");
    expect(cfg.logFormat).toBe("json");
  });
});

describe("sanitized", () => {
  it("redacts api credentials", () => {
    const cfg = loadConfig(baseEnv);
    const out = sanitized(cfg);
    expect(out.apiKey).toBe("***");
    expect(out.apiSecret).toBe("***");
    expect(out.komodoUrl).toBe("https://komo.example.com");
  });
});
