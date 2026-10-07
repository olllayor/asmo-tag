import type { IssueConnector, Messenger, ModelProvider, Store } from "./core.js";

export class Worker {
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly store: Store, private readonly model: ModelProvider, private readonly connector: IssueConnector, private readonly messenger: Messenger) {}

  interrupt(taskId: string) { this.active.get(taskId)?.abort(); }

  async step(workerId: string, signal: AbortSignal = new AbortController().signal): Promise<boolean> {
    const job = await this.store.claim(workerId);
    if (!job) return false;
    const deadline = AbortSignal.timeout(Math.max(1, job.lease.expiresAt - Date.now() - 100));
    const control = new AbortController();
    const bounded = AbortSignal.any([signal, deadline, control.signal]);
    if (job.kind === "model") this.active.set(job.input.task.id, control);
    try {
      if (job.kind === "model") {
        const turn = await this.model.turn(job.input, bounded);
        await this.store.finishModel(job, turn);
      } else if (job.kind === "effect") {
        if (job.reconcile) {
          const result = await this.connector.reconcile(job.effect, bounded);
          if (result.kind === "found") await this.store.finishEffect(job, result.receipt);
          else if (result.kind === "absent") await this.store.absentEffect(job, result.proof);
          else await this.store.unknownEffect(job, result.reason);
        } else {
          const receipt = await this.connector.invoke(job.effect, bounded);
          await this.store.finishEffect(job, receipt);
        }
      } else {
        const sent = await this.messenger.send(job.delivery, bounded);
        await this.store.finishDelivery(job, sent.messageId);
      }
    } catch {
      if (job.kind === "effect") await this.store.unknownEffect(job, "Connector outcome could not be confirmed. Reconciliation is required.");
      else await this.store.fail(job, bounded.aborted ? "Request interrupted or deadline exceeded." : "Provider or delivery request failed. Inspect configuration and task state.");
    } finally {
      if (job.kind === "model" && this.active.get(job.input.task.id) === control) this.active.delete(job.input.task.id);
    }
    return true;
  }

  async drain(limit = 200): Promise<number> {
    let worked = 0;
    for (; worked < limit; worked++) if (!await this.step("fixture-drain")) break;
    return worked;
  }
}
