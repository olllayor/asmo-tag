import { z } from "zod";

export const modelProviderSchema = z.enum(["openai", "deepseek", "glm"]);
export type ModelProviderName = z.infer<typeof modelProviderSchema>;

export const providerProfiles = {
  openai: {
    provider: "openai", status: "supported", baseURL: "https://api.openai.com/v1",
    endpoint: "https://api.openai.com/v1/responses", apiKeyEnvironment: "OPENAI_API_KEY",
    strictTools: true, encryptedReasoning: true, storeParameter: true, serialToolParameter: true,
    documentation: "https://developers.openai.com/api/docs/guides/function-calling",
  },
  deepseek: {
    provider: "deepseek", status: "supported", baseURL: "https://api.deepseek.com",
    endpoint: "https://api.deepseek.com/responses", apiKeyEnvironment: "DEEPSEEK_API_KEY",
    strictTools: false, encryptedReasoning: false, storeParameter: false, serialToolParameter: false,
    documentation: "https://api-docs.deepseek.com/guides/responses_api/",
  },
  glm: {
    provider: "glm", status: "unverified",
    documentation: "https://docs.z.ai/guides/overview/overview",
  },
} as const;

export function resolveProviderProfile(provider: ModelProviderName) {
  const profile = providerProfiles[provider];
  if (profile.status !== "supported") throw new Error("GLM Responses compatibility is unverified. Choose openai or deepseek; Chat Completions compatibility does not establish Responses support.");
  return profile;
}

export const responsesOptionsSchema = z.object({
  provider: modelProviderSchema.default("openai"),
  apiKey: z.string().trim().min(1),
  model: z.string().trim().min(1).max(256),
  inputUsdPerMillion: z.number().finite().nonnegative(),
  cachedInputUsdPerMillion: z.number().finite().nonnegative(),
  outputUsdPerMillion: z.number().finite().nonnegative(),
  maxRequestBytes: z.number().int().min(1024).max(100_000).default(100_000),
});

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

export function readModelConfig(env: NodeJS.ProcessEnv = process.env) {
  let provider: ModelProviderName;
  try { provider = modelProviderSchema.parse(env.ASMO_MODEL_PROVIDER ?? "openai"); }
  catch { throw new Error("ASMO_MODEL_PROVIDER must be openai, deepseek, or glm."); }
  const profile = resolveProviderProfile(provider);
  const price = (name: string) => {
    const raw = required(env, name);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite nonnegative USD price per million tokens.`);
    return value;
  };
  const model = required(env, "ASMO_MODEL");
  if (model.length > 256) throw new Error("ASMO_MODEL exceeds 256 characters.");
  return {
    provider: profile.provider,
    apiKey: required(env, profile.apiKeyEnvironment),
    model,
    inputUsdPerMillion: price("ASMO_INPUT_USD_PER_MILLION"),
    cachedInputUsdPerMillion: price("ASMO_CACHED_INPUT_USD_PER_MILLION"),
    outputUsdPerMillion: price("ASMO_OUTPUT_USD_PER_MILLION"),
  };
}
