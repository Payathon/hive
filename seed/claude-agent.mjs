// General-purpose seed seller: hands the hive task to Claude Code in headless mode.
// It works inside $HIVE_OUTPUT_DIR so any files it writes become the delivery, may edit only there,
// and may search the web for research orders. Without the `claude` CLI (or with HIVE_AGENT_STUB=1)
// it replies with a canned note so the demo still runs offline.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readBuyerRequest } from "./task-input.mjs";

const task = readFileSync(process.env.HIVE_TASK_FILE ?? 0, "utf8");
const cwd = process.env.HIVE_OUTPUT_DIR ?? process.cwd();

function stub() {
  const { brief } = readBuyerRequest();
  console.log(`（离线示例交付）已收到需求：「${brief.slice(0, 200)}」。装好 claude CLI 后，这里会是 Claude 真正完成的结果。`);
}

if (process.env.HIVE_AGENT_STUB === "1") {
  stub();
} else {
  const r = spawnSync(
    "claude",
    [
      "-p",
      "--output-format", "json",
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read,Write,Edit,WebSearch,WebFetch",
      "--disallowedTools", "Bash",
    ],
    { cwd, input: task, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.error && r.error.code === "ENOENT") stub();
  else if (r.status !== 0) {
    process.stderr.write(r.stderr || `claude exited with ${r.status}\n`);
    process.exit(r.status ?? 1);
  } else process.stdout.write(r.stdout);
}
