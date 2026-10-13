import { z } from "zod";

const sandboxResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

export interface SandboxExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface SandboxExecutionOptions {
  command: string;
  files?: Record<string, string>;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SandboxConnector {
  execute(options: SandboxExecutionOptions, signal?: AbortSignal): Promise<SandboxExecutionResult>;
}

export class EphemeralHttpSandboxConnector implements SandboxConnector {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly fetcher: typeof globalThis.fetch = globalThis.fetch
  ) {}

  async execute(options: SandboxExecutionOptions, signal?: AbortSignal): Promise<SandboxExecutionResult> {
    const started = Date.now();
    const timeout = options.timeoutMs ?? 30_000;
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);

    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        command: options.command,
        files: options.files ?? {},
        env: options.env ?? {},
        timeoutMs: timeout,
      }),
      signal: bounded,
    });

    if (!response.ok) {
      throw new Error(`Sandbox execution failed with HTTP status ${response.status}`);
    }

    // The sandbox is a trust boundary: a malformed result must fail loudly, not surface
    // as exitCode 0 with empty output.
    const parsed = sandboxResultSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("Sandbox execution returned a malformed result");
    }
    return {
      exitCode: parsed.data.exitCode,
      stdout: parsed.data.stdout,
      stderr: parsed.data.stderr,
      durationMs: Date.now() - started,
    };
  }
}

export class InMemorySandboxConnector implements SandboxConnector {
  constructor(private readonly mockHandler?: (options: SandboxExecutionOptions) => SandboxExecutionResult) {}

  async execute(options: SandboxExecutionOptions, signal?: AbortSignal): Promise<SandboxExecutionResult> {
    signal?.throwIfAborted();
    if (this.mockHandler) {
      return this.mockHandler(options);
    }
    // Fail closed: without a remote endpoint this connector cannot execute anything.
    // Returning exitCode 0 here would record unexecuted work as a successful run.
    throw new Error("Sandbox execution is not configured. Set SANDBOX_ENDPOINT and SANDBOX_API_KEY for live execution.");
  }
}

export function createSandboxConnector(
  endpoint?: string,
  apiKey?: string,
  fetcher?: typeof globalThis.fetch
): SandboxConnector {
  if (endpoint && apiKey) {
    return new EphemeralHttpSandboxConnector(endpoint, apiKey, fetcher);
  }
  return new InMemorySandboxConnector();
}
