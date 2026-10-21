import { ApiError, HiveClient, yuan, type CapabilityTypeInfo, type Order } from "@hive/client/api";
import type { CapabilityEntry } from "./capabilities-file.ts";
import { buildTask, parseOutput, runCommand } from "./runner.ts";

// A paid order gets this many tries at producing schema-valid output before we give up.
export const MAX_ATTEMPTS = 3;

export type Log = (msg: string) => void;

// `hive serve`: modeled on a self-hosted CI runner. It long-polls hive (outbound only),
// auto-accepts offers for `accept: auto` capabilities, and wakes the local agent only once paid.
export class Listener {
  private types = new Map<string, CapabilityTypeInfo>();
  private entries = new Map<string, CapabilityEntry>();
  private busy = new Set<string>();
  // Paid orders left to the owner because their capability has no `run`; logged once each.
  private manual = new Set<string>();
  private abort = new AbortController();
  private running: Promise<void>[] = [];

  constructor(
    private readonly client: HiveClient,
    capabilities: CapabilityEntry[],
    private readonly log: Log = console.log,
    private readonly pollSeconds = 25,
  ) {
    for (const c of capabilities) this.entries.set(c.type, c);
  }

  // Makes the server's listings match the capabilities file and reports payment setup needs.
  async sync() {
    for (const t of await this.client.types()) this.types.set(t.type, t);
    for (const entry of this.entries.values()) {
      if (!this.types.has(entry.type)) throw new Error(`unknown capability type in capabilities file: ${entry.type}`);
      await this.client.upsertListing(entry.type, { acceptMode: entry.accept, dailyLimit: entry.daily_limit });
      const pay = await this.client.paymentSetup(entry.type);
      if (pay.status === "ENABLED" && pay.priceFen !== null) {
        this.log(`listed ${entry.type} at ${yuan(pay.priceFen)} (${entry.accept}${entry.run ? "" : ", by hand"})`);
      } else {
        const next = pay.configurationUrl ?? pay.managementUrl ?? "(no link returned)";
        this.log(`${entry.type}: 即刻收 status ${pay.status}, set a "1 次" price in Alipay: ${next}`);
      }
    }
  }

  // One poll round. Exposed for tests; `run` loops it. Returns whether anything was pending.
  async pollOnce(waitSeconds = this.pollSeconds) {
    const inbox = await this.client.poll(waitSeconds, this.abort.signal);
    for (const offer of inbox.offers) await this.handleOffer(offer);
    for (const order of inbox.work) {
      if (this.busy.has(order.id) || this.manual.has(order.id)) continue;
      const entry = this.entries.get(order.capabilityType);
      if (entry && !entry.run) {
        this.manual.add(order.id);
        this.log(`${order.id} (${order.capabilityType}) is paid; do it yourself and deliver in the app, or have your agent use hive_deliver`);
        continue;
      }
      this.busy.add(order.id);
      const job = this.work(order).finally(() => this.busy.delete(order.id));
      this.running.push(job);
    }
    return inbox.offers.length + inbox.work.length > 0;
  }

  async run() {
    await this.sync();
    this.log(`listening for orders on ${this.client.server}`);
    while (!this.abort.signal.aborted) {
      try {
        // The poll returns at once while anything is pending (offers left to the owner, work in
        // flight), so back off instead of spinning on it.
        if (await this.pollOnce()) await new Promise((r) => setTimeout(r, 3000));
      } catch (err) {
        if (this.abort.signal.aborted) break;
        this.log(`poll failed: ${(err as Error).message}; retrying in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async stop() {
    this.abort.abort();
    await this.drain();
  }

  // Waits for in-flight work to finish.
  async drain() {
    while (this.running.length) await Promise.allSettled(this.running.splice(0));
  }

  private async handleOffer(order: Order) {
    const entry = this.entries.get(order.capabilityType);
    // Human (`ask`) offers are answered from the web 接单台, not by the listener.
    if (!entry || entry.accept !== "auto") return;
    try {
      const accepted = await this.client.orderAction(order.id, "accept-offer");
      this.log(`accepted ${order.id} (${order.capabilityType}) at ${yuan(accepted.priceFen)}, waiting for payment`);
    } catch (err) {
      // Lost a race or the offer expired: nothing to do.
      if (err instanceof ApiError && err.status === 409) return;
      throw err;
    }
  }

  private async work(order: Order) {
    const entry = this.entries.get(order.capabilityType);
    const type = this.types.get(order.capabilityType);
    if (!entry?.run || !type) {
      this.log(`no capability configured for paid order ${order.id}; abandoning`);
      await this.client.orderAction(order.id, "abandon");
      return;
    }
    try {
      if (order.status === "PAID") await this.client.orderAction(order.id, "start");
      this.log(`working on ${order.id} (${order.capabilityType})`);
      let lastError: string | null = order.lastDeliveryError;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const result = await runCommand(entry.run, buildTask(order, type, lastError), { timeoutMs: type.workTimeoutMs });
        if (result.code !== 0) {
          lastError = `command exited with ${result.code}: ${result.stderr.slice(-500)}`;
          this.log(`${order.id}: ${lastError}`);
          continue;
        }
        let output: unknown;
        try {
          output = parseOutput(result.stdout);
        } catch (err) {
          lastError = (err as Error).message;
          continue;
        }
        try {
          await this.client.orderAction(order.id, "deliver", { output });
          this.log(`delivered ${order.id}`);
          return;
        } catch (err) {
          if (!(err instanceof ApiError) || err.code !== "invalid_output") throw err;
          lastError = err.message;
          this.log(`${order.id}: delivery rejected (attempt ${attempt}): ${err.message}`);
        }
      }
      this.log(`giving up on ${order.id} after ${MAX_ATTEMPTS} attempts`);
      await this.client.orderAction(order.id, "abandon");
    } catch (err) {
      this.log(`${order.id}: ${(err as Error).message}`);
    }
  }
}
