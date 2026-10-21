import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ApiError, hive, type PendingLogin } from "../api.ts";
import { AgentIcon, NavBar, useAction, useToast } from "../ui.tsx";

// The owner side of `hive login`: the agent sends a link to this page and the owner approves once.
// Only reachable through that link; without a code it falls back to typing one in.
export function Approve() {
  const [params] = useSearchParams();
  const linked = params.get("code");
  const [code, setCode] = useState(linked ?? "");
  const [pending, setPending] = useState<PendingLogin | null>(null);
  const [expired, setExpired] = useState(false);
  const { busy, run } = useAction();
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    if (!linked) return;
    hive.pendingLogin(linked).then(setPending, (err) => {
      if (err instanceof ApiError && err.status === 404) setExpired(true);
      else toast("连不上 hive，请稍后刷新");
    });
  }, [linked, toast]);

  async function approve(e: React.FormEvent) {
    e.preventDefault();
    if (await run(() => hive.approve(code.trim()))) {
      toast("已同意，agent 可以替你下单了");
      navigate("/me", { replace: true });
    }
  }

  const name = pending?.label || "你的 agent";
  const head = (title: string, sub: string) => (
    <div className="bill-head">
      <AgentIcon />
      <div className="status">
        {title}
        <small>{sub}</small>
      </div>
    </div>
  );

  if (expired) {
    return (
      <div className="page">
        <NavBar title="授权 agent" />
        {head("这个链接已经过期", "让 agent 重新运行 hive login，再发你一个新链接")}
      </div>
    );
  }
  if (pending?.approved) {
    return (
      <div className="page">
        <NavBar title="授权 agent" />
        {head(`已同意「${name}」`, "可以在「我的」里随时撤销")}
      </div>
    );
  }

  return (
    <form className="page" onSubmit={approve}>
      <NavBar title="授权 agent" />
      {linked ? (
        head(`「${name}」想代表你下单`, "它能找服务、下单、验收；每笔付款仍要你在支付宝确认。同意一次长期有效，随时可撤销")
      ) : (
        <>
          {head("让 agent 用你的账号", "它能找服务、下单、验收；每笔付款仍要你在支付宝确认")}
          <div className="card">
            <div className="field">
              <label htmlFor="code">验证码</label>
              <input id="code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="hive login 链接里的 8 位码" autoCapitalize="characters" autoComplete="off" required />
            </div>
          </div>
        </>
      )}
      <div className="actionbar">
        <button className="btn" type="submit" disabled={busy || (!!linked && !pending)}>同意</button>
        {linked && <button className="link" type="button" disabled={busy} onClick={() => navigate("/", { replace: true })}>不同意</button>}
      </div>
    </form>
  );
}
