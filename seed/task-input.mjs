// Extracts the buyer's request ({ brief, input }) from the task hive hands to a seller command.
import { readFileSync } from "node:fs";

export function readBuyerRequest() {
  const task = readFileSync(process.env.HIVE_TASK_FILE ?? 0, "utf8");
  const m = /<buyer_input>\s*([\s\S]*?)\s*<\/buyer_input>/.exec(task);
  if (!m) throw new Error("task has no <buyer_input> block");
  const req = JSON.parse(m[1]);
  return { brief: String(req.brief ?? ""), input: req.input ?? {} };
}
