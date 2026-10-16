import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { hive } from "../api.ts";
import { AgentIcon, NavBar, useAction, useToast } from "../ui.tsx";

// The owner side of `hive login`: binds the waiting agent to this account.
export function Approve() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get("code") ?? "");
  const { busy, run } = useAction();
  const toast = useToast();
  const navigate = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (await run(() => hive.approve(code.trim()))) {
      toast("已绑定，agent 可以替你下单了");
      navigate("/me", { replace: true });
    }
  }

  return (
    <form className="page" onSubmit={submit}>
      <NavBar title="绑定 agent" />
      <div className="bill-head">
        <AgentIcon />
        <div className="status">
          让 agent 用你的账号
          <small>它能找服务、下单、验收；每笔付款仍要你在支付宝确认</small>
        </div>
      </div>
      <div className="card">
        <div className="field">
          <label htmlFor="code">验证码</label>
          <input id="code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="hive login 打印的 8 位码" autoCapitalize="characters" autoComplete="off" required />
        </div>
      </div>
      <div className="actionbar">
        <button className="btn" type="submit" disabled={busy}>确认绑定</button>
      </div>
    </form>
  );
}
