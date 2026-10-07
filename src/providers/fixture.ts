import { createHash } from "node:crypto";
import { z } from "zod";
import { toolCallSchema, turnSchema } from "../core.js";
import type { ModelProvider, ToolCall, Turn } from "../core.js";
import { citedSourceIds, modelInputSchema } from "./input.js";

const toolEvidenceSchema = z.object({
  simulated: z.boolean().optional(), repository: z.string().optional(),
  title: z.string().optional(), providerId: z.string().optional(),
  url: z.string().url().optional(), issues: z.array(z.unknown()).optional(),
});

function toolSummary(content: string) {
  try {
    const parsed = toolEvidenceSchema.safeParse(JSON.parse(content));
    if (parsed.success) {
      const evidence = parsed.data;
      if (evidence.issues) return { text: `Issue list returned ${evidence.issues.length} ${evidence.simulated ? "synthetic " : ""}records${evidence.repository ? ` from ${evidence.repository}` : ""}.` };
      if (evidence.url) {
        const url = new URL(evidence.url);
        if (url.protocol === "https:" && ["asmo-fixture.invalid", "github.com"].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash) {
          return { text: `${evidence.simulated ? "Synthetic issue" : "Issue"} receipt${evidence.providerId ? ` ${evidence.providerId}` : ""}${evidence.title ? `: ${evidence.title.slice(0, 180)}` : "."}`, url: url.toString() };
        }
      }
      return { text: "The tool returned evidence this fixture cannot summarize." };
    }
  } catch {
    const url = content.match(/https:\/\/asmo-fixture\.invalid\/issues\/[a-zA-Z0-9-]+/)?.[0];
    if (url) return { text: "Synthetic issue receipt returned by the tool.", url };
  }
  return { text: content.replace(/\s+/g, " ").slice(0, 220) };
}

export function createFixtureModel(): ModelProvider {
  return {
    simulated: true,
    async turn(rawInput, signal) {
      signal.throwIfAborted();
      const input = modelInputSchema.parse(rawInput);
      const instructions = [input.task.instruction, ...input.history.filter(entry => entry.role === "user").flatMap(entry => entry.content.filter(block => block.type === "text").map(block => block.text))];
      const request = instructions.join("\n");
      const latest = instructions.at(-1) ?? input.task.instruction;
      const repository = [...request.matchAll(/\b([\w.-]+\/[\w.-]+)\b/g)].at(-1)?.[1];
      const calls = input.history.flatMap(entry => entry.content.filter(block => block.type === "tool_use"));
      const results = input.history.flatMap(entry => entry.content.filter(block => block.type === "tool_result"));
      const successful = (name: ToolCall["name"]) => calls.some(call => call.name === name && results.some(result => result.tool_use_id === call.id && !result.is_error));
      const writeRequested = /\b(create|file|open|raise|draft)\b[^\n]*\bissue\b/i.test(request) && !/\b(read[ -]?only|do not (?:create|file|open)|don'?t (?:create|file|open)|summary only|summari[sz]e only)\b/i.test(latest);
      const readRequested = /\b(read|list|check|summari[sz]e|inspect)\b[^\n]*\bissues?\b/i.test(request) && !/\bsummary only\b|\bsummari[sz]e only\b/i.test(latest);
      const euOnly = /\bEU\b|Europe/i.test(latest) && /\bonly\b|\bnarrow\b|\bfocus\b/i.test(latest);
      const sources = input.sources.filter(source => !euOnly || /\bEU\b|Europe/i.test(source.text));
      const evidence = sources.slice(0, 12).map(source => `${source.kind === "tool" ? toolSummary(source.text).text : source.text.slice(0, 800)} [Source: ${source.id}]`).join("\n");
      const findings = sources.slice(0, 6).map(source => `${source.kind === "tool" ? toolSummary(source.text).text : source.text.replace(/\s+/g, " ").slice(0, 220)} [Source: ${source.id}]`).join("\n");
      const sourceIds = new Set(input.sources.map(source => source.id));
      const memory = input.memories.filter(item => item.state === "active").map(item => `Saved memory: ${item.content}${item.evidenceIds.filter(id => sourceIds.has(id)).map(id => ` [Source: ${id}]`).join("")}`).join("\n");
      const coverage = `Captured context begins ${new Date(input.collectedSince).toISOString()}. Only a bounded selection of supplied sources is available. Omitted sources do not prove absence. Earlier and uncaptured history is unavailable.`;
      const identity = createHash("sha256").update(`${input.task.id}:${input.task.revision}:${input.history.length}:${request}`).digest("hex").slice(0, 24);
      const limitations = ["Offline fixture model; findings and usage are simulated.", coverage];
      let outcome: Turn["outcome"] = "complete";
      let text = `SIMULATED fixture findings.\n${findings || "No supporting captured sources are available."}${memory ? `\n${memory}` : ""}\nNo code inspection was performed. Root cause remains unverified.\n${coverage}`;
      let tool: ToolCall | undefined;
      if (writeRequested && !repository) {
        outcome = "needs_input";
        text = "Simulated fixture: provide the approved owner/repository before I draft an issue.";
      } else if (repository && (writeRequested || readRequested) && !successful("github_create_issue") && !successful("github_read_issues") && input.tools.includes("github_read_issues")) {
        outcome = "tools";
        text = `Simulated fixture investigation of ${repository}.\n${evidence || "No supporting captured sources are available."}\nI will read the approved issue list before drafting.`;
        tool = toolCallSchema.parse({ id: `fixture-read-${identity}`, name: "github_read_issues", input: { repository } });
      } else if (repository && writeRequested && !successful("github_create_issue") && input.tools.includes("github_create_issue")) {
        if (calls.some(call => call.name === "github_create_issue")) {
          outcome = "incomplete";
          text = "Simulated fixture: the previous issue attempt failed or remains unresolved. No second issue is proposed automatically.";
        } else {
          outcome = "tools";
          const title = /coupon/i.test(request) ? `${euOnly ? "EU " : ""}Coupon failure reported by the team` : latest.replace(/\s+/g, " ").slice(0, 180);
          const body = `Simulated fixture issue draft\n\nRequested work: ${latest}\n\nCaptured evidence:\n${evidence || "No supporting captured sources are available."}\n\n${coverage}\n\nInvestigation limitation: this fixture does not inspect code or establish a root cause. Verify the reported behavior before implementing a fix.`;
          tool = toolCallSchema.parse({ id: `fixture-create-${identity}`, name: "github_create_issue", input: { repository, title, body, labels: [] } });
          text = `Simulated fixture investigation.\n${evidence}\nExact issue draft for ${repository} requires application approval.`;
        }
      } else if (writeRequested && !successful("github_create_issue")) {
        outcome = "incomplete";
        text += "\nIssue creation is unavailable under the current tool grant.";
      } else if (successful("github_create_issue")) {
        const call = calls.find(call => call.name === "github_create_issue" && results.some(result => result.tool_use_id === call.id && !result.is_error));
        const result = results.find(result => result.tool_use_id === call?.id && !result.is_error);
        const receipt = toolSummary(result?.content ?? "Issue receipt details unavailable.");
        text += `\n${receipt.text}${receipt.url ? `\n${receipt.url}` : ""}`;
      }
      const content = [{ type: "text" as const, text }, ...(tool ? [{ type: "tool_use" as const, ...tool }] : [])];
      return turnSchema.parse({
        message: { role: "assistant", content }, outcome, limitations,
        sourceIds: citedSourceIds(text, input.sources.map(source => source.id)),
        usage: { inputTokens: Math.ceil(JSON.stringify(input).length / 4), outputTokens: Math.ceil(JSON.stringify(content).length / 4), costMicros: 1_000, simulated: true, pricingRevision: "fixture-v1-not-billed" },
        requestId: `simulated-${identity}`,
      });
    },
  };
}
