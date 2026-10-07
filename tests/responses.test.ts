import { afterEach, describe, expect, it, vi } from "vitest";
import { createResponsesModel, readModelConfig } from "../src/providers/index.js";
import type { ModelInput, Transcript } from "../src/core.js";
import type { ResponsesOptions } from "../src/providers/responses.js";

const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllEnvs());
function input(history: Transcript[] = []): ModelInput {
  return {
    task: { id: "task-1", workspaceId: "workspace-1", scopeId: "scope-1", requesterId: "person-1", topicId: null, instruction: "Read acme/checkout issues", state: "running", revision: 1, epoch: 0, turns: 0, maxTurns: 8, budgetMicros: 100_000, result: null, reason: null, createdAt: 0 },
    history, sources: [{ id: "source-1", scopeId: "scope-1", text: "EU coupon fails.", revision: 1, messageId: 1, capturedAt: 10, kind: "message" }], memories: [], collectedSince: 0,
    tools: ["github_read_issues", "github_create_issue"], maxOutputTokens: 4096,
  };
}
const message = (text = "EU coupon fails [Source: source-1].") => ({ type: "message", id: "message-1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const reasoning = { type: "reasoning", id: "reasoning-1", status: "completed", summary: [{ type: "summary_text", text: "Read the authorized issue list." }], encrypted_content: "opaque-reasoning-fixture", provider_extension: { tag: "preserve-me" } };
const call = (callId = "call-1") => ({ type: "function_call", id: `item-${callId}`, call_id: callId, name: "github_read_issues", arguments: '{"repository":"acme/checkout"}', status: "completed" });
function response(output: unknown[] = [message()], status = "completed", usage: unknown = { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 12 } }) {
  return new Response(JSON.stringify({ id: "response-test", model: "test-model", status, output, usage }), { headers: { "content-type": "application/json", "x-request-id": "request-test" } });
}
const options = { apiKey: "fixture-secret-never-live", model: "test-model", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 10 };
const model = (fetcher: typeof fetch, overrides: Partial<ResponsesOptions> = {}) => createResponsesModel({ ...options, ...overrides, fetch: fetcher });

describe("Responses provider boundary", () => {
  it("validates enabled Notion tools and preserves their call results in the next request", async () => {
    const notionCall = { ...call(), name: "notion_search", arguments: '{"query":"coupon"}' };
    let count = 0;
    let captured: Record<string, unknown> = {};
    const provider = model(async (_url, request) => { captured = JSON.parse(String(request?.body)); return ++count === 1 ? response([notionCall]) : response(); });
    const first = await provider.turn({ ...input(), tools: ["notion_search", "notion_read_page"] }, signal());
    expect(first).toMatchObject({ outcome: "tools", message: { content: [{ type: "tool_use", id: "call-1", name: "notion_search", input: { query: "coupon" } }] } });
    expect(captured.tools).toMatchObject([{ name: "notion_search", strict: true, parameters: { required: ["query"], additionalProperties: false } }, { name: "notion_read_page", strict: true, parameters: { required: ["pageId"], additionalProperties: false } }]);
    const history: Transcript[] = [first.message, { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "Coupon page found", is_error: false }] }];
    expect((await provider.turn({ ...input(history), tools: ["notion_search", "notion_read_page"] }, signal())).outcome).toBe("complete");
    expect(captured.input).toEqual([notionCall, { type: "function_call_output", call_id: "call-1", output: "Coupon page found" }]);
    await expect(model(async () => response([{ ...notionCall, name: "notion_read_page", arguments: '{"pageId":"invalid-id"}' }])).turn({ ...input(), tools: ["notion_read_page"] }, signal())).rejects.toThrow("invalid tool call");
  });
  it("pins endpoint and credentials despite generic OpenAI SDK environment overrides", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://attacker.example/v1");
    vi.stubEnv("OPENAI_CUSTOM_HEADERS", "Authorization: Bearer unrelated-openai-key\nX-Other-Secret: unrelated-secret\nOpenAI-Organization: unrelated-org");
    vi.stubEnv("OPENAI_ORG_ID", "unrelated-org");
    let endpoint = "";
    let headers = new Headers();
    const turn = await model(async (url, request) => { endpoint = String(url); headers = new Headers(request?.headers); return response(); }, { provider: "deepseek" }).turn(input(), signal());
    expect(turn.outcome).toBe("complete");
    expect(endpoint).toBe("https://api.deepseek.com/responses");
    expect(headers.get("authorization")).toBe("Bearer fixture-secret-never-live");
    expect(headers.get("x-other-secret")).toBeNull();
    expect(headers.get("openai-organization")).toBeNull();
  });
  it("uses the official endpoint, stateless typed tools, and correct cached/reasoning accounting through the SDK", async () => {
    let captured: Record<string, unknown> = {};
    let endpoint = "";
    const provider = model(async (url, request) => {
      endpoint = String(url); captured = JSON.parse(String(request?.body));
      expect(new Headers(request?.headers).get("authorization")).toBe("Bearer fixture-secret-never-live");
      expect(request?.redirect).toBe("error");
      return response();
    });
    const turn = await provider.turn(input(), signal());
    expect(endpoint).toBe("https://api.openai.com/v1/responses");
    expect(captured).toMatchObject({ model: "test-model", store: false, include: ["reasoning.encrypted_content"], parallel_tool_calls: false, max_output_tokens: 4096, stream: false });
    expect(captured).not.toHaveProperty("previous_response_id");
    expect(captured).not.toHaveProperty("conversation");
    expect(captured.tools).toMatchObject([{ type: "function", strict: true, parameters: { additionalProperties: false, required: ["repository"] } }, { type: "function", strict: true, parameters: { additionalProperties: false, required: ["repository", "title", "body", "labels"] } }]);
    expect(turn).toMatchObject({ outcome: "complete", sourceIds: ["source-1"], usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 12, costMicros: 340, simulated: false } });
    expect(turn.message.providerState).toMatchObject({ provider: "openai", endpoint: "https://api.openai.com/v1/responses", model: "test-model" });
  });

  it("replays complete output items and immediate function_call_output using call_id, preserving reasoning extensions and steering", async () => {
    const outputs = [reasoning, message("Checking issues."), call(), message("Keep the EU scope.")];
    let count = 0;
    let request: Record<string, unknown> = {};
    const provider = model(async (_url, init) => { count++; request = JSON.parse(String(init?.body)); return count === 1 ? response(outputs) : response(); });
    const first = await provider.turn(input(), signal());
    expect(first).toMatchObject({ outcome: "tools", message: { content: [{ type: "text", text: "Checking issues." }, { type: "tool_use", id: "call-1", name: "github_read_issues", input: { repository: "acme/checkout" } }, { type: "text", text: "Keep the EU scope." }], providerState: { items: outputs } } });
    const history: Transcript[] = [first.message, { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "No matching issues", is_error: false }, { type: "text", text: "Summarize only." }] }];
    const second = await provider.turn(input(history), signal());
    expect(second.outcome).toBe("complete");
    expect(request.input).toEqual([...outputs, { type: "function_call_output", call_id: "call-1", output: "No matching issues" }, { role: "user", content: "Summarize only." }]);
  });

  it.each(["model", "provider", "endpoint"] as const)("never replays opaque state after %s changes", async field => {
    const first = await model(async () => response([reasoning, message()])).turn(input(), signal());
    const foreign = structuredClone(first.message);
    if (!foreign.providerState) throw new Error("Missing provider state");
    if (field === "provider") foreign.providerState.provider = "deepseek";
    else foreign.providerState[field] = "foreign-value" + (field === "endpoint" ? "://example.test" : "");
    let captured: unknown;
    const turn = await model(async (_url, init) => { captured = JSON.parse(String(init?.body)); return response(); }).turn(input([foreign]), signal());
    expect(turn.outcome).toBe("complete");
    expect(captured).toMatchObject({ input: [{ role: "assistant", content: "EU coupon fails [Source: source-1]." }] });
    expect(JSON.stringify(captured)).not.toContain("opaque-reasoning-fixture");
    expect(JSON.stringify(captured)).not.toContain("provider_extension");
  });

  it("rejects stale provider state after neutral transcript content changes", async () => {
    const first = await model(async () => response([reasoning, message()])).turn(input(), signal());
    first.message.content = [{ type: "text", text: "Source removed." }];
    await expect(model(async () => { throw new Error("Must not dispatch"); }).turn(input([first.message]), signal())).rejects.toThrow("does not match transcript");
  });

  it("serializes canonical legacy history with immediate matching call outputs and marks failed tool results", async () => {
    const history: Transcript[] = [
      { role: "assistant", content: [{ type: "text", text: "Checking two lists." }, { type: "tool_use", id: "a", name: "github_read_issues", input: { repository: "acme/checkout" } }, { type: "tool_use", id: "b", name: "github_read_issues", input: { repository: "acme/payments" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "No issues", is_error: false }, { type: "tool_result", tool_use_id: "b", content: "Read denied", is_error: true }, { type: "text", text: "Use captured evidence." }] },
    ];
    let captured: Record<string, unknown> = {};
    const turn = await model(async (_url, init) => { captured = JSON.parse(String(init?.body)); return response(); }).turn(input(history), signal());
    expect(turn.outcome).toBe("complete");
    expect(captured.input).toEqual([{ role: "assistant", content: "Checking two lists." }, { type: "function_call", call_id: "a", name: "github_read_issues", arguments: '{"repository":"acme/checkout"}' }, { type: "function_call", call_id: "b", name: "github_read_issues", arguments: '{"repository":"acme/payments"}' }, { type: "function_call_output", call_id: "a", output: "No issues" }, { type: "function_call_output", call_id: "b", output: '{"is_error":true,"content":"Read denied"}' }, { role: "user", content: "Use captured evidence." }]);
    await expect(model(async () => response()).turn(input(history.slice(0, 1)), signal())).rejects.toThrow("Missing tool results");
    await expect(model(async () => response()).turn(input([history[0]!, { role: "user", content: [{ type: "text", text: "Out of order" }, ...history[1]!.content] }]), signal())).rejects.toThrow("must precede user text");
    await expect(model(async () => response()).turn(input([{ role: "user", content: [{ type: "tool_result", tool_use_id: "unknown", content: "x", is_error: false }] }]), signal())).rejects.toThrow("Unmatched");
  });

  it.each(["incomplete", "failed", "in_progress", "queued", "cancelled"])("never exposes tool calls for %s responses", async status => {
    const turn = await model(async () => response([reasoning, { ...call(), arguments: "malformed" }, message("Partial answer")], status)).turn(input(), signal());
    expect(turn).toMatchObject({ outcome: "incomplete", message: { content: [{ type: "text", text: "Partial answer" }] }, usage: { costMicros: 340 } });
    expect(turn.message.providerState).toBeUndefined();
  });

  it("never exposes calls beside a refusal or incomplete item and keeps Needs input waiting", async () => {
    const refusal = { type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "Cannot help." }] };
    for (const outputs of [[call(), refusal], [{ ...call(), status: "incomplete" }, message("Partial")]]) {
      const turn = await model(async () => response(outputs)).turn(input(), signal());
      expect(turn.outcome).toBe("incomplete");
      expect(turn.message.content.every(block => block.type === "text")).toBe(true);
      expect(turn.message.providerState).toBeUndefined();
    }
    expect((await model(async () => response([message("Needs input: Which repository?")])).turn(input(), signal())).outcome).toBe("needs_input");
    await expect(model(async () => response([call(), message("Needs input: Which repository?")])).turn(input(), signal())).rejects.toThrow("while asking for user input");
  });

  it("rejects parallel calls, unavailable tools, invalid arguments, unknown output, and unauthorized citations", async () => {
    await expect(model(async () => response([call("a"), call("b")])).turn(input(), signal())).rejects.toThrow("parallel tool calls");
    await expect(model(async () => response([call()])).turn({ ...input(), tools: [] }, signal())).rejects.toThrow("unavailable tool");
    await expect(model(async () => response([{ ...call(), arguments: "bad secret" }])).turn(input(), signal())).rejects.toThrow(/^Provider returned invalid function arguments$/);
    await expect(model(async () => response([{ ...call(), arguments: '{"repository":"attacker/private","extra":"x"}' }])).turn(input(), signal())).rejects.toThrow("invalid tool call");
    await expect(model(async () => response([{ type: "web_search_call", id: "x" }])).turn(input(), signal())).rejects.toThrow("invalid Responses payload");
    await expect(model(async () => response([message("Claim [Source: forbidden]")])).turn(input(), signal())).rejects.toThrow("outside the authorized context");
  });

  it("enforces request/output limits and token consistency with redacted failures", async () => {
    await expect(model(async () => { throw new Error("Must not dispatch"); }, { maxRequestBytes: 1024 }).turn(input(), signal())).rejects.toThrow("byte limit");
    await expect(model(async () => response()).turn({ ...input(), maxOutputTokens: 4097 }, signal())).rejects.toThrow();
    expect(() => model(async () => response(), { maxRequestBytes: 100001 })).toThrow();
    await expect(model(async () => response([message("x".repeat(100001))])).turn(input(), signal())).rejects.toThrow("output exceeds byte limit");
    await expect(model(async () => response([message()], "completed", { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 11 } })).turn(input(), signal())).rejects.toThrow("inconsistent token usage");
    await expect(model(async () => response([message()], "completed", { input_tokens: 10, output_tokens: 2, output_tokens_details: { reasoning_tokens: 3 } })).turn(input(), signal())).rejects.toThrow("inconsistent token usage");
  });

  it("does not retry or leak HTTP/network errors and aborts before dispatch", async () => {
    let attempts = 0;
    await expect(model(async () => { attempts++; return new Response(JSON.stringify({ error: { message: "fixture-secret-never-live" } }), { status: 429 }); }).turn(input(), signal())).rejects.toThrow(/^openai request failed \(status 429\)$/);
    expect(attempts).toBe(1);
    await expect(model(async () => { throw new Error("fixture-secret-never-live"); }).turn(input(), signal())).rejects.toThrow(/^openai request failed \(status unavailable\)$/);
    const controller = new AbortController(); controller.abort();
    await expect(model(async () => { attempts++; return response(); }).turn(input(), controller.signal)).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("uses DeepSeek's documented stateless profile and locally rejects parallel calls", async () => {
    let captured: Record<string, unknown> = {};
    let endpoint = "";
    let attempts = 0;
    const provider = model(async (url, init) => { endpoint = String(url); captured = JSON.parse(String(init?.body)); return ++attempts === 1 ? response([{ type: "reasoning", id: "reason-plain", summary: [], content: [{ type: "reasoning_text", text: "Plain provider reasoning" }] }, call()]) : response([call("a"), call("b")]); }, { provider: "deepseek" });
    const first = await provider.turn(input(), signal());
    expect(endpoint).toBe("https://api.deepseek.com/responses");
    expect(captured).not.toHaveProperty("store");
    expect(captured).not.toHaveProperty("include");
    expect(captured).not.toHaveProperty("parallel_tool_calls");
    expect(captured.tools).toMatchObject([{ strict: false }, { strict: false }]);
    expect(first.outcome).toBe("tools");
    expect(first.message.providerState?.provider).toBe("deepseek");
    expect(first.message.providerState?.items[0]).toMatchObject({ type: "reasoning", content: [{ type: "reasoning_text", text: "Plain provider reasoning" }] });
    await expect(provider.turn(input(), signal())).rejects.toThrow("parallel tool calls");
  });
});

describe("Responses configuration", () => {
  const env = { OPENAI_API_KEY: "openai-fixture", ASMO_MODEL: "operator-model", ASMO_INPUT_USD_PER_MILLION: "2", ASMO_CACHED_INPUT_USD_PER_MILLION: "0.5", ASMO_OUTPUT_USD_PER_MILLION: "10" };
  it("defaults to OpenAI and requires explicit model and all three prices", () => {
    expect(readModelConfig(env)).toEqual({ provider: "openai", apiKey: "openai-fixture", model: "operator-model", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 10 });
    for (const name of ["OPENAI_API_KEY", "ASMO_MODEL", "ASMO_INPUT_USD_PER_MILLION", "ASMO_CACHED_INPUT_USD_PER_MILLION", "ASMO_OUTPUT_USD_PER_MILLION"]) expect(() => readModelConfig({ ...env, [name]: undefined })).toThrow(`Missing configuration: ${name}`);
    for (const price of ["NaN", "Infinity", "-1", ""]) expect(() => readModelConfig({ ...env, ASMO_INPUT_USD_PER_MILLION: price })).toThrow();
  });
  it("isolates provider credentials and fails clearly for unverified GLM", () => {
    expect(readModelConfig({ ...env, ASMO_MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "deepseek-fixture" }).apiKey).toBe("deepseek-fixture");
    expect(() => readModelConfig({ ...env, ASMO_MODEL_PROVIDER: "deepseek" })).toThrow("DEEPSEEK_API_KEY");
    expect(() => readModelConfig({ ...env, ASMO_MODEL_PROVIDER: "glm" })).toThrow("GLM Responses compatibility is unverified");
    expect(() => model(async () => response(), { provider: "glm" })).toThrow("GLM Responses compatibility is unverified");
    expect(() => readModelConfig({ ...env, ASMO_MODEL_PROVIDER: "arbitrary" })).toThrow("must be openai, deepseek, or glm");
  });
});
