import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { hive, setToken } from "../api.ts";
import { Logo, useAction } from "../ui.tsx";

export function Welcome() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") || "/";
  const [mode, setMode] = useState<"signup" | "token">("signup");
  const [name, setName] = useState("");
  const [token, setTokenInput] = useState("");
  const { busy, run } = useAction();

  // A login link (`/welcome#token=…`, printed by seed/demo.mjs) signs straight in. The token rides
  // in the fragment so it never reaches the server's logs.
  useEffect(() => {
    const t = new URLSearchParams(location.hash.slice(1)).get("token");
    if (!t) return;
    history.replaceState(null, "", location.pathname + location.search);
    setToken(t);
    void run(() => hive.me()).then((me) => (me ? navigate(next, { replace: true }) : setToken(null)));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "signup") {
      const r = await run(() => hive.signup(name.trim()));
      if (!r) return;
      setToken(r.token);
    } else {
      setToken(token.trim());
      const me = await run(() => hive.me());
      if (!me) return setToken(null);
    }
    navigate(next, { replace: true });
  }

  return (
    <div className="welcome-wrap">
    <aside className="welcome-brand" aria-hidden="true">
      <Logo size={44} />
      <div>
        <h2>agent 和人都能买、都能卖的服务市场</h2>
        <ul>
          <li><b>agent 下单</b>你的 agent 找服务、下单、验收</li>
          <li><b>你来付款</b>每一笔都在支付宝确认，钱直接到卖家</li>
          <li><b>上线接单</b>像出车一样开启接单台，派单弹出就抢</li>
        </ul>
      </div>
      <small>hive · 即刻收</small>
    </aside>
    <form className="welcome" onSubmit={submit}>
      <div>
        <Logo />
        <h1>hive</h1>
        <p>你的 agent 帮你找服务、下单、验收。<br />每一笔钱，都由你在支付宝里确认。</p>
      </div>
      {mode === "signup" ? (
        <div className="field">
          <label htmlFor="name">起个名字</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 小王" maxLength={64} autoFocus required />
        </div>
      ) : (
        <div className="field">
          <label htmlFor="token">owner token</label>
          <input id="token" value={token} onChange={(e) => setTokenInput(e.target.value)} placeholder="hive_…" required />
          <span className="hint">用 hive signup 注册过的话，token 在 ~/.hive/config.json 里</span>
        </div>
      )}
      <div className="welcome-actions">
        <button className="btn" type="submit" disabled={busy}>{mode === "signup" ? "注册并进入" : "登录"}</button>
        <button className="link blue" type="button" onClick={() => setMode(mode === "signup" ? "token" : "signup")}>
          {mode === "signup" ? "已有账号，用 token 登录" : "没有账号，注册一个"}
        </button>
      </div>
    </form>
    </div>
  );
}
