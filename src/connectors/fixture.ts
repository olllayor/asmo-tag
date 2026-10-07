import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import type { Effect, IssueConnector } from "../core.js";
import { correlationMarker, effectFingerprint, effectKey, parseEffect, receiptSchema, reconciliationSchema } from "./boundary.js";

const entrySchema = z.object({ fingerprint: z.string(), repository: z.string(), receipt: receiptSchema });
type Options = { directory: string; failAfterApply?: boolean; delayMs?: number };

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function createFixtureConnector(options: Options): IssueConnector {
  const directory = resolve(z.string().min(1).parse(options.directory));
  const delayMs = z.number().int().min(0).max(60_000).parse(options.delayMs ?? 0);
  const path = (effect: Effect) => join(directory, `${effectKey(effect)}.json`);
  async function lookup(effect: Effect) {
    try {
      const entry = entrySchema.parse(JSON.parse(await readFile(path(effect), "utf8")));
      if (entry.fingerprint !== effectFingerprint(effect)) throw new Error("Fixture effect identity reused with different content");
      return entry.receipt;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  return {
    simulated: true,
    async invoke(rawEffect, signal) {
      const effect = parseEffect(rawEffect);
      signal.throwIfAborted();
      await mkdir(directory, { recursive: true });
      if (delayMs) await setTimeout(delayMs, undefined, { signal });
      signal.throwIfAborted();
      if (effect.call.name === "github_read_issues") {
        const files = (await readdir(directory)).filter(file => /^[a-f0-9]{64}\.json$/.test(file));
        if (files.length > 1_000) throw new Error("Fixture ledger exceeds bounded read limit");
        const entries = await Promise.all(files.map(async file => entrySchema.parse(JSON.parse(await readFile(join(directory, file), "utf8")))));
        return receiptSchema.parse({
          providerId: `fixture-read-${effectKey(effect)}`, url: null,
          content: JSON.stringify({ simulated: true, repository: effect.call.input.repository, issues: entries.filter(entry => entry.repository === effect.call.input.repository).map(entry => JSON.parse(entry.receipt.content)), coverage: "Only this synthetic fixture ledger was read. No GitHub call occurred." }),
        });
      }
      const existing = await lookup(effect);
      if (existing) return existing;
      const key = effectKey(effect);
      const receipt = receiptSchema.parse({
        providerId: `fixture-issue-${key}`, url: `https://asmo-fixture.invalid/issues/${key}`,
        content: JSON.stringify({ simulated: true, providerId: `fixture-issue-${key}`, url: `https://asmo-fixture.invalid/issues/${key}`, ...effect.call.input, body: `${effect.call.input.body}\n\n${correlationMarker(effect)}`, limitation: "Synthetic issue stored in the fixture ledger. No GitHub issue exists." }),
      });
      const temp = join(directory, `.${key}.${randomUUID()}.tmp`);
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ fingerprint: effectFingerprint(effect), repository: effect.call.input.repository, receipt }));
        await file.sync();
      } finally {
        await file.close();
      }
      let applied = false;
      try {
        signal.throwIfAborted();
        try {
          await link(temp, path(effect));
          applied = true;
          const folder = await open(directory, "r");
          try { await folder.sync(); } finally { await folder.close(); }
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
      } finally {
        await unlink(temp);
      }
      if (applied && options.failAfterApply) throw new Error("Simulated crash after fixture effect applied; receipt not returned");
      const persisted = await lookup(effect);
      if (!persisted) throw new Error("Fixture effect receipt unavailable after apply");
      return persisted;
    },
    async reconcile(rawEffect, signal) {
      const effect = parseEffect(rawEffect);
      signal.throwIfAborted();
      const receipt = await lookup(effect);
      return reconciliationSchema.parse(receipt
        ? { kind: "found", receipt }
        : { kind: "absent", proof: "The authoritative synthetic fixture ledger has no applied record for this effect. Its atomic effect key prevents duplicate application." });
    },
  };
}
