import { defineConfig } from "drizzle-kit";

// Solo per generare le migrazioni (`npm run db:generate -w @lanterna/server`).
// Il server le applica da solo all'avvio.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
