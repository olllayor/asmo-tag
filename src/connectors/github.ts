import { z } from 'zod';
import type { Effect, IssueConnector } from '../core.js';
import { correlationMarker, parseEffect, receiptSchema, reconciliationSchema } from './boundary.js';

const issueSchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  html_url: z.string().url(),
  title: z.string(),
  body: z.string().nullable(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])).default([]),
  pull_request: z.unknown().optional(),
});
type Issue = z.infer<typeof issueSchema>;
type Options = { token: string; allowedRepositories: string[]; fetch?: typeof globalThis.fetch };

export function createGitHubConnector(options: Options): IssueConnector {
  const token = z.string().min(1).parse(options.token);
  const allowedRepositories = new Set(
    z
      .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/))
      .min(1)
      .parse(options.allowedRepositories)
      .map((repository) => repository.toLowerCase()),
  );
  const fetcher = options.fetch ?? globalThis.fetch;
  function authorized(rawEffect: Effect) {
    const effect = parseEffect(rawEffect);
    if (!allowedRepositories.has(effect.call.input.repository.toLowerCase()))
      throw new Error('GitHub repository is not allowlisted');
    return effect;
  }
  function receipt(issue: Issue, repository: string) {
    const url = new URL(issue.html_url);
    if (
      url.origin !== 'https://github.com' ||
      url.pathname.toLowerCase() !== `/${repository}/issues/${issue.number}`.toLowerCase() ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error('GitHub returned an unexpected issue URL');
    return receiptSchema.parse({
      providerId: String(issue.id),
      url: url.toString(),
      content: JSON.stringify({
        simulated: false,
        repository,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        labels: issue.labels.map((label) => (typeof label === 'string' ? label : label.name)),
        url: url.toString(),
      }),
    });
  }
  async function request(
    repository: string,
    method: 'GET' | 'POST',
    signal: AbortSignal,
    page = 1,
    body?: unknown,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const [owner, repo] = repository.split('/');
    const url = `https://api.github.com/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(repo ?? '')}/issues${method === 'GET' ? `?state=all&per_page=100&page=${page}` : ''}`;
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    let response;
    try {
      response = await fetcher(url, {
        method,
        signal: boundedSignal,
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'user-agent': 'asmo-tag',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(
        signal.aborted
          ? 'GitHub request canceled; write outcome may be unknown'
          : 'GitHub request failed (status unavailable); write outcome may be unknown',
      );
    }
    if (!response.ok)
      throw new Error(`GitHub request failed (status ${response.status}); write outcome may be unknown`);
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('empty response');
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2_000_000) {
            await reader.cancel();
            throw new Error('response limit');
          }
          chunks.push(decoder.decode(chunk.value, { stream: true }));
        }
      } finally {
        reader.releaseLock();
      }
      chunks.push(decoder.decode());
      return JSON.parse(chunks.join(''));
    } catch {
      throw new Error('GitHub returned an invalid or oversized response; write outcome may be unknown');
    }
  }
  return {
    simulated: false,
    async invoke(rawEffect, signal) {
      const effect = authorized(rawEffect);
      const repository = effect.call.input.repository;
      if (effect.call.name === 'github_read_issues') {
        const issues = z
          .array(issueSchema)
          .max(100)
          .parse(await request(repository, 'GET', signal));
        return receiptSchema.parse({
          providerId: `github-read:${repository}`,
          url: null,
          content: JSON.stringify({
            simulated: false,
            repository,
            issues: issues
              .filter((issue) => issue.pull_request === undefined)
              .map((issue) => JSON.parse(receipt(issue, repository).content)),
            coverage: 'First page of at most 100 issues and pull requests. Earlier pages were not retrieved.',
          }),
        });
      }
      const { title, body, labels } = effect.call.input;
      const issue = issueSchema.parse(
        await request(repository, 'POST', signal, 1, {
          title,
          body: `${body}\n\n${correlationMarker(effect)}`,
          labels,
        }),
      );
      return receipt(issue, repository);
    },
    async reconcile(rawEffect, signal) {
      const effect = authorized(rawEffect);
      if (effect.call.name !== 'github_create_issue')
        return { kind: 'absent', proof: 'github_read_issues is a read-only operation. It cannot create an external mutation; a fresh read is safe after current authorization is checked.' };
      const repository = effect.call.input.repository;
      const marker = correlationMarker(effect);
      try {
        for (let page = 1; page <= 10; page++) {
          const issues = z
            .array(issueSchema)
            .max(100)
            .parse(await request(repository, 'GET', signal, page));
          const matches = issues.filter((issue) => issue.pull_request === undefined && issue.body?.includes(marker));
          if (matches.length > 1)
            return {
              kind: 'unknown',
              reason: 'Multiple GitHub issues contain this effect marker; manual reconciliation required.',
            };
          const match = matches[0];
          if (match) return reconciliationSchema.parse({ kind: 'found', receipt: receipt(match, repository) });
          if (issues.length < 100) break;
        }
        return {
          kind: 'unknown',
          reason:
            'No positive GitHub effect marker was found in the bounded issue scan. Absence is not proven; do not retry the write blindly.',
        };
      } catch {
        return {
          kind: 'unknown',
          reason:
            'GitHub reconciliation could not establish a positive effect marker match; do not retry the write blindly.',
        };
      }
    },
  };
}
