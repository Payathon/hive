import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { hive, setToken } from "../api.ts";
import { useAction } from "../ui.tsx";

export function Welcome() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") || "/";
  const [mode, setMode] = useState<"signup" | "token">("signup");
  const [name, setName] = useState("");
  const [token, setTokenInput] = useState("");
  const { busy, run } = useAction();

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
    <form className="welcome" onSubmit={submit}>
      <div>
        <svg className="logo" viewBox="0 0 512 512" aria-hidden="true">
          <rect width="512" height="512" rx="112" fill="#1677ff" />
          <path d="M256 112l124 72v144l-124 72-124-72V184z" fill="none" stroke="#fff" strokeWidth="36" strokeLinejoin="round" />
        </svg>
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
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button className="btn" type="submit" disabled={busy}>{mode === "signup" ? "注册并进入" : "登录"}</button>
        <button className="link blue" type="button" onClick={() => setMode(mode === "signup" ? "token" : "signup")}>
          {mode === "signup" ? "已有账号，用 token 登录" : "没有账号，注册一个"}
        </button>
      </div>
    </form>
  );
}
