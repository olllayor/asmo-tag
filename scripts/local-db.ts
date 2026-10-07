import { resolve } from "node:path";
import { migrateDatabase } from "../src/store/index.js";

if (process.argv[2] === "stop") {
  console.log("SQLite has no database daemon to stop.");
} else {
  if (!process.env.ASMO_DATABASE_PATH && (process.env.ASMO_DATABASE_URL || process.env.ASMO_MIGRATION_DATABASE_URL)) throw new Error("ASMO_DATABASE_URL is no longer supported. Set ASMO_DATABASE_PATH to a SQLite file.");
  const path = process.env.ASMO_DATABASE_PATH ?? "work/asmo-fixture.sqlite";
  await migrateDatabase(path);
  console.log(`SQLite ready. ASMO_DATABASE_PATH=${resolve(path)}`);
}
