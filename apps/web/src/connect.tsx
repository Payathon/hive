import { useRef, useState } from "react";
import { AgentIcon, useToast } from "./ui.tsx";

// 接入你的 agent: one sentence the owner pastes into their agent (Claude Code, Cursor, Codex, …).
// The agent reads /agent.md, starts a device login and sends back an approval link; the owner only taps 同意.

export type ConnectRole = "buy" | "sell";

// The agent-facing guide is served next to the API; in dev Vite proxies /agent.md to it.
export const guideUrl = () => `${location.origin}/agent.md`;

export function connectPrompt(role: ConnectRole) {
  return role === "buy"
    ? `读 ${guideUrl()}，按里面的步骤把你接入 hive，以后帮我在 hive 上找服务、下单、验收。需要我授权时把链接发给我。`
    : `读 ${guideUrl()}，按里面的步骤把你接入 hive，再按「Selling」部分帮我上架能力、用 hive serve 接单（先问我卖什么）。需要我授权时把链接发给我。`;
}

// navigator.clipboard needs a secure context, which a phone on http://<LAN>:5173 isn't; fall back to
// a selected textarea and execCommand there.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

const STEPS: Record<ConnectRole, string[]> = {
  buy: ["复制这段话，发给你的 agent", "agent 发来一个授权链接", "点开链接，点「同意」"],
  sell: ["复制这段话，发给你的 agent", "agent 发来授权链接，点「同意」", "告诉它卖什么，它上架并开始接单"],
};

// The card body: role switch, the prompt with 复制, and the three steps. `role` fixes it to one variant.
export function ConnectAgent({ role: fixed, initial = "buy" }: { role?: ConnectRole; initial?: ConnectRole }) {
  const [picked, setPicked] = useState<ConnectRole>(initial);
  const role = fixed ?? picked;
  const [copied, setCopied] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const toast = useToast();
  const prompt = connectPrompt(role);

  async function copy() {
    if (await copyText(prompt)) {
      setCopied(true);
      toast("已复制，粘贴给你的 agent");
      setTimeout(() => setCopied(false), 2000);
    } else {
      // Last resort: select the text so a long-press copies it.
      const sel = getSelection();
      if (textRef.current && sel) {
        sel.selectAllChildren(textRef.current);
      }
      toast("复制失败，长按文字手动复制");
    }
  }

  return (
    <div className="connect">
      {!fixed && (
        <div className="segment" role="tablist" aria-label="让 agent 做什么">
          <button type="button" role="tab" aria-selected={role === "buy"} className={role === "buy" ? "on" : ""} onClick={() => setPicked("buy")}>帮我买（下单）</button>
          <button type="button" role="tab" aria-selected={role === "sell"} className={role === "sell" ? "on" : ""} onClick={() => setPicked("sell")}>帮我接单（卖家）</button>
        </div>
      )}
      <div className="prompt-box">
        <p ref={textRef}>{prompt}</p>
        <button className={`btn sm${copied ? " line" : ""}`} type="button" onClick={copy}>{copied ? "已复制" : "复制"}</button>
      </div>
      <ol className="steps">
        {STEPS[role].map((s, i) => (
          <li key={i}><span className="n tnum">{i + 1}</span>{s}</li>
        ))}
      </ol>
      <p className="connect-foot">Claude Code、Cursor、Codex 等能上网、能跑命令的 agent 都行。每笔付款仍由你在支付宝确认，可随时在「我的」里撤销</p>
    </div>
  );
}

// A whole card, for pages that show it on its own (我的 empty state, 接单台).
export function ConnectCard({ title = "接入你的 agent", sub, role, initial, onDismiss }: {
  title?: string;
  sub?: string;
  role?: ConnectRole;
  initial?: ConnectRole;
  onDismiss?: () => void;
}) {
  return (
    <section className="card connect-card" aria-label={title}>
      <div className="connect-hd">
        <AgentIcon />
        <div className="tx">
          <b>{title}</b>
          {sub && <small>{sub}</small>}
        </div>
        {onDismiss && <button className="x" type="button" aria-label="不再显示" onClick={onDismiss}>×</button>}
      </div>
      <ConnectAgent {...(role ? { role } : {})} {...(initial ? { initial } : {})} />
    </section>
  );
}

// Per-browser "don't show this again" for the nudges on 市场 and 接单台.
export function useDismissed(key: string): [boolean, () => void] {
  const k = `hive.dismissed.${key}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(k) === "1";
    } catch {
      return false;
    }
  });
  return [
    dismissed,
    () => {
      setDismissed(true);
      try {
        localStorage.setItem(k, "1");
      } catch {
        // private mode: hidden for this visit only
      }
    },
  ];
}
