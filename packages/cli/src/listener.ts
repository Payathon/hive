import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, guessMime, HiveClient, yuan, type CategoryInfo, type Order } from "@hive/client/api";
import type { CapabilityEntry } from "./capabilities-file.ts";
import { buildTask, outputFiles, readReply, runCommand } from "./runner.ts";

// A paid order gets this many tries at producing a delivery in the right format before we give up.
export const MAX_ATTEMPTS = 3;

export type Log = (msg: string) => void;

// `hive serve`: modeled on a self-hosted CI runner. It long-polls hive (outbound only),
// auto-accepts offers for `accept: auto` capabilities, and wakes the local agent only once paid.
export class Listener {
  private categories = new Map<string, CategoryInfo>();
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
    for (const c of capabilities) this.entries.set(c.category, c);
  }

  // Makes the server's listings match the capabilities file and reports payment setup needs.
  async sync() {
    for (const c of await this.client.categories()) this.categories.set(c.id, c);
    for (const entry of this.entries.values()) {
      if (!this.categories.has(entry.category)) {
        throw new Error(`unknown category in capabilities file: ${entry.category} (see hive categories)`);
      }
      const listing = await this.client.upsertListing(entry.category, {
        acceptMode: entry.accept,
        workMode: entry.run ? "agent" : "manual",
        deliveryHours: entry.run ? null : (entry.delivery_hours ?? null),
        dailyLimit: entry.daily_limit,
        tags: entry.tags,
        intro: entry.intro ?? null,
      });
      const pay = await this.client.paymentSetup(entry.category);
      if (pay.status === "ENABLED" && pay.priceFen !== null) {
        const hand = entry.run ? "" : `, by hand within ${listing.deliveryHours}h`;
        this.log(`listed ${entry.category} at ${yuan(pay.priceFen)} (${entry.accept}${hand})`);
      } else {
        const next = pay.configurationUrl ?? pay.managementUrl ?? "(no link returned)";
        this.log(`${entry.category}: 即刻收 status ${pay.status}, set a "1 次" price in Alipay: ${next}`);
      }
    }
  }

  // One poll round. Exposed for tests; `run` loops it. Returns whether anything was pending.
  async pollOnce(waitSeconds = this.pollSeconds) {
    const inbox = await this.client.poll(waitSeconds, this.abort.signal);
    for (const offer of inbox.offers) await this.handleOffer(offer);
    for (const order of inbox.work) {
      if (this.busy.has(order.id) || this.manual.has(order.id)) continue;
      const entry = this.entries.get(order.category);
      if (entry && !entry.run) {
        this.manual.add(order.id);
        this.log(`${order.id} (${order.category}) is paid; do it yourself and deliver in the app, or have your agent use hive_deliver`);
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
    const entry = this.entries.get(order.category);
    // `ask` offers are approved from the web 接单台, not by the listener. Auto listings done by
    // hand never get here: hive accepts those itself.
    if (!entry || entry.accept !== "auto") return;
    try {
      const accepted = await this.client.orderAction(order.id, "accept-offer");
      this.log(`accepted ${order.id} (${order.category}) at ${yuan(accepted.priceFen)}, waiting for payment`);
    } catch (err) {
      // Lost a race or the offer expired: nothing to do.
      if (err instanceof ApiError && err.status === 409) return;
      throw err;
    }
  }

  private async work(order: Order) {
    const entry = this.entries.get(order.category);
    const category = this.categories.get(order.category);
    if (!entry?.run || !category) {
      this.log(`no capability configured for paid order ${order.id}; abandoning`);
      await this.client.orderAction(order.id, "abandon");
      return;
    }
    try {
      if (order.status === "PAID") await this.client.orderAction(order.id, "start");
      this.log(`working on ${order.id} (${order.category})`);
      let lastError: string | null = order.lastDeliveryError;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // A fresh directory per attempt, so files from a rejected try don't ride along.
        const outputDir = await mkdtemp(join(tmpdir(), "hive-out-"));
        try {
          const task = buildTask(order, category, lastError, outputDir);
          const result = await runCommand(entry.run, task, { timeoutMs: category.workTimeoutMs, outputDir });
          if (result.code !== 0) {
            lastError = `command exited with ${result.code}: ${result.stderr.slice(-500)}`;
            this.log(`${order.id}: ${lastError}`);
            continue;
          }
          const reply = readReply(result.stdout, order.deliverySpec);
          const files = [];
          for (const f of await outputFiles(outputDir)) {
            files.push((await this.client.uploadFile(order.id, f.name, guessMime(f.name), f.bytes)).id);
          }
          await this.client.deliver(order.id, { ...reply, files });
          this.log(`delivered ${order.id}`);
          return;
        } catch (err) {
          if (!(err instanceof ApiError) || err.code !== "invalid_output") throw err;
          lastError = err.message;
          this.log(`${order.id}: delivery rejected (attempt ${attempt}): ${err.message}`);
        } finally {
          await rm(outputDir, { recursive: true, force: true });
        }
      }
      this.log(`giving up on ${order.id} after ${MAX_ATTEMPTS} attempts`);
      await this.client.orderAction(order.id, "abandon");
    } catch (err) {
      this.log(`${order.id}: ${(err as Error).message}`);
    }
  }
}
