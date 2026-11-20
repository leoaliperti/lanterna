import { describe, expect, it } from "vitest";
import { ConfigError, MAX_HISTORY_ON_CONNECT, loadConfig } from "./config.js";

const SECRET = "x".repeat(32);

describe("loadConfig", () => {
  it("in produzione senza BETTER_AUTH_SECRET il server non parte", () => {
    expect(() => loadConfig({ NODE_ENV: "production", BETTER_AUTH_URL: "https://l.example" })).toThrow(ConfigError);
  });

  it("in produzione senza BETTER_AUTH_URL il server non parte", () => {
    expect(() => loadConfig({ NODE_ENV: "production", BETTER_AUTH_SECRET: SECRET })).toThrow(ConfigError);
  });

  it("rifiuta un segreto corto", () => {
    expect(() => loadConfig({ BETTER_AUTH_SECRET: "corto" })).toThrow(/32/);
  });

  it("produzione configurata: nessuna origine di sviluppo implicita", () => {
    const c = loadConfig({
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: "https://lanterna.example.com/",
    });
    expect(c.production).toBe(true);
    expect(c.baseURL).toBe("https://lanterna.example.com");
    expect(c.trustedOrigins).toEqual([]);
  });

  it("sviluppo: segreto di ripiego e origine Vite ammessa", () => {
    const c = loadConfig({});
    expect(c.production).toBe(false);
    expect(c.authSecret.length).toBeGreaterThanOrEqual(32);
    expect(c.trustedOrigins).toEqual(["http://localhost:5173"]);
  });

  it("chat: default, valori da env e cronologia iniziale limitata", () => {
    expect(loadConfig({}).chat).toEqual({
      historyOnConnect: 50,
      messagesPerMinute: 30,
      messageBurst: 10,
      rollsPerMinute: 30,
      rollBurst: 10,
    });
    const c = loadConfig({ CHAT_HISTORY_LIMIT: "100000", CHAT_MESSAGE_BURST: "3", ROLLS_PER_MINUTE: "abc" });
    expect(c.chat.historyOnConnect).toBe(MAX_HISTORY_ON_CONNECT);
    expect(c.chat.messageBurst).toBe(3);
    expect(c.chat.rollsPerMinute).toBe(30);
  });

  it.each([
    [undefined, false],
    ["false", false],
    ["true", true],
    ["loopback", "loopback"],
    ["127.0.0.1,::1", "127.0.0.1,::1"],
  ])("TRUST_PROXY=%s", (value, expected) => {
    expect(loadConfig({ TRUST_PROXY: value }).trustProxy).toEqual(expected);
  });
});
