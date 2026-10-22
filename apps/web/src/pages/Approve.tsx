import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ApiError, hive, type PendingLogin } from "../api.ts";
import { AgentIcon, NavBar, useAction, useToast } from "../ui.tsx";

// The owner side of a device login (/agent.md, `hive login`): the agent sends a link to this page and
// the owner approves once. Signed-out owners pass through /welcome and come back here.
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
      toast("已同意");
      // Stay here and say what happens next: the agent picks the approval up by itself.
      if (pending) setPending({ ...pending, approved: true });
      else navigate("/me", { replace: true });
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
        {head("这个链接已经过期", "链接 10 分钟内有效。让 agent 重新发起授权，再发你一个新链接")}
      </div>
    );
  }
  if (pending?.approved) {
    return (
      <div className="page">
        <NavBar title="授权 agent" />
        {head(`已同意「${name}」`, "回到你的 agent，它会自己继续完成接入。可以在「我的 → 我的 agent」里随时撤销")}
        <div className="actionbar">
          <button className="btn line" type="button" onClick={() => navigate("/me", { replace: true })}>查看我的 agent</button>
        </div>
      </div>
    );
  }

  return (
    <form className="page" onSubmit={approve}>
      <NavBar title="授权 agent" />
      {linked ? (
        <>
          {head(`「${name}」想接入你的 hive 账号`, "确认这是你刚刚让它接入的 agent 再同意")}
          <div className="card">
            <h4><span>同意后它可以</span></h4>
            <ul className="grant-list">
              <li>替你找服务、下单、验收交付</li>
              <li>按你的要求上架能力、接单、交付</li>
              <li><b>不能</b>替你付款：每一笔都要你在支付宝里确认</li>
              <li><b>不能</b>改你在「我的」里定的规矩（单笔、每日上限，暂停）</li>
            </ul>
            <p className="hint-line">同意一次长期有效，随时可以在「我的 → 我的 agent」里撤销。验证码 <span className="mono">{pending?.userCode ?? linked}</span></p>
          </div>
        </>
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
