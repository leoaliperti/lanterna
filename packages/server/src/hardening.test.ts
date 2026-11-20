import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function trackedFiles(): string[] | null {
  try {
    return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean);
  } catch {
    return null; // non è un checkout git (es. immagine Docker): il test non si applica
  }
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" || name === "dist" ? [] : sourceFiles(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

describe("nessun file privato tracciato da git", () => {
  const files = trackedFiles();
  const it_ = files ? it : it.skip;

  it_("niente .env, database, upload, backup o contenuti importati", () => {
    const forbidden = [
      /(^|\/)\.env$/,
      /(^|\/)\.env\.(?!example$)/,
      /\.(sqlite|sqlite3|db)(-wal|-shm)?$/,
      /^(packages\/server\/)?(uploads|data|backups|imports|content)\//,
      /^imports\//,
      /\.pem$|\.key$|credentials\.json$|settings\.local\.json$/,
    ];
    const bad = files!.filter((f) => forbidden.some((re) => re.test(f)));
    expect(bad).toEqual([]);
  });

  it_("il codice in src/content è tracciato (le regole di .gitignore non lo escludono)", () => {
    expect(files!.some((f) => f.startsWith("packages/server/src/content/"))).toBe(true);
  });

  it_("nessun segreto evidente nel codice tracciato", () => {
    const suspicious = /(BETTER_AUTH_SECRET\s*=\s*[A-Za-z0-9+/=]{20,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
    const hits = files!.filter((f) => /\.(ts|tsx|json|md|yml|yaml|example|js)$/.test(f) && f !== "package-lock.json").filter((f) => {
      try {
        return suspicious.test(readFileSync(join(root, f), "utf8"));
      } catch {
        return false;
      }
    });
    expect(hits).toEqual([]);
  });
});

describe(".env.example è completo", () => {
  it("documenta ogni variabile d'ambiente letta dal server", () => {
    const example = readFileSync(join(root, ".env.example"), "utf8");
    const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
    const used = new Set<string>();
    for (const f of sourceFiles(join(root, "packages/server/src"))) {
      for (const m of readFileSync(f, "utf8").matchAll(/(?:process\.env|\benv)\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]!);
    }
    // Variabili di sistema, non di configurazione.
    for (const v of ["NODE_ENV"]) used.delete(v);
    const missing = [...used].filter((v) => !documented.has(v)).sort();
    expect(missing).toEqual([]);
  });

  it("non contiene segreti: il segreto di Better Auth è vuoto", () => {
    const example = readFileSync(join(root, ".env.example"), "utf8");
    expect(example).toMatch(/^BETTER_AUTH_SECRET=\s*$/m);
    expect(example).not.toMatch(/PASSWORD=.+/);
  });
});
