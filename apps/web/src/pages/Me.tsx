import { useEffect, useState } from "react";
import { Link } from "react-router";
import { hive, type AgentGrant } from "../api.ts";
import { shortDate, typeTitle, yuan } from "../format.ts";
import { disablePush, enablePush, pushState, type PushState } from "../push.ts";
import { AgentIcon, Bell, LargeTitle, Switch, TabBar, TypeTile, useAction, usePoll, useSession, useToast } from "../ui.tsx";

const toFen = (s: string) => (s.trim() === "" ? null : Math.round(Number(s) * 100));
const toYuan = (fen: number | null) => (fen === null ? "" : String(fen / 100));

function Rules() {
  const { me, refresh } = useSession();
  const { busy, run } = useAction();
  const toast = useToast();
  const [perOrder, setPerOrder] = useState(toYuan(me.rules.perOrderCapFen));
  const [daily, setDaily] = useState(toYuan(me.rules.dailyCapFen));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (await run(() => hive.updateRules({ perOrderCapFen: toFen(perOrder), dailyCapFen: toFen(daily) }))) {
      toast("已保存");
      await refresh();
    }
  }
  async function pause(on: boolean) {
    if (await run(() => hive.updateRules({ paused: on }))) {
      toast(on ? "已暂停，agent 不能再下单" : "已恢复");
      await refresh();
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <h4><span>给 agent 的规矩</span><small>agent 不能自己改</small></h4>
      <div className="list-row">
        <div className="tx"><b>暂停下单</b><small>打开后，你和 agent 都不能再下新订单</small></div>
        <Switch on={me.rules.paused} onChange={pause} label="暂停下单" disabled={busy} />
      </div>
      <div className="field">
        <label htmlFor="per">单笔上限（元，不填不限）</label>
        <input id="per" type="number" min={0} step="0.01" inputMode="decimal" value={perOrder} onChange={(e) => setPerOrder(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="daily">每日上限（元，不填不限）</label>
        <input id="daily" type="number" min={0} step="0.01" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
      </div>
      <button className="btn line" type="submit" disabled={busy}>保存上限</button>
    </form>
  );
}

const PUSH_HINT: Record<PushState, string> = {
  on: "已开启：关掉页面，订单要你处理时也会在系统通知里弹出",
  off: "开启后，关掉页面也能收到付款、验收、派单提醒",
  denied: "浏览器拒绝了通知：点地址栏左侧的图标，把「通知」改成允许后刷新",
  unsupported: "这个地址收不到推送（需要 https 或 localhost）。在电脑上用 http://localhost:5173 打开就能开",
  unavailable: "服务端没有开启推送",
};

// How hive reaches the owner when the page isn't open: browser push and mail. The 消息 bell covers the rest.
function Notify() {
  const { me, refresh } = useSession();
  const { busy, run } = useAction();
  const toast = useToast();
  const [push, setPush] = useState<PushState | null>(null);
  const [email, setEmail] = useState(me.email ?? "");

  useEffect(() => {
    pushState().then(setPush, () => setPush("unavailable"));
  }, []);

  async function toggle(on: boolean) {
    const next = await run(() => (on ? enablePush() : disablePush()));
    if (!next) return;
    setPush(next);
    if (on && next === "on") toast("通知已开启");
  }
  async function test() {
    if (await run(() => hive.pushTest())) toast("已发送，看看系统通知");
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (await run(() => hive.setEmail(email.trim() || null))) {
      toast(email.trim() ? "已保存，订单要你处理时会发邮件" : "已清除邮箱");
      await refresh();
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <h4><span>通知</span><small>订单要你处理时提醒你</small></h4>
      <div className="list-row">
        <div className="tx">
          <b>开启通知</b>
          <small>{push ? PUSH_HINT[push] : "检查中…"}</small>
          {push === "on" && <button className="link blue" type="button" style={{ padding: "4px 0 0" }} disabled={busy} onClick={test}>发一条试试</button>}
        </div>
        <Switch on={push === "on"} onChange={toggle} label="开启通知" disabled={busy || !push || push === "unsupported" || push === "unavailable" || push === "denied"} />
      </div>
      <div className="field">
        <label htmlFor="email">邮件通知（不填就不发）</label>
        <input id="email" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <button className="btn line" type="submit" disabled={busy || email.trim() === (me.email ?? "")}>保存邮箱</button>
    </form>
  );
}

const SOURCE: Record<string, string> = { login: "hive login 授权", api_key: "API key" };

// The agents that may order for this account. Hidden until there is one: approving happens through
// the link an agent sends, never from here.
function Agents({ grants, reload }: { grants: AgentGrant[]; reload: () => Promise<void> }) {
  const { busy, run } = useAction();
  const toast = useToast();

  async function revoke(g: AgentGrant) {
    if (!confirm(`撤销「${g.label || "agent"}」？它将不能再替你下单。`)) return;
    if (await run(() => hive.revokeAgent(g.id))) {
      toast("已撤销");
      await reload();
    }
  }

  if (grants.length === 0) return null;
  return (
    <div className="card">
      <h4><span>我的 agent</span><small>能替你找服务、下单、验收</small></h4>
      {grants.map((g) => (
        <div className="list-row" key={g.id}>
          <AgentIcon />
          <div className="tx">
            <b>{g.label || "agent"}</b>
            <small>
              {SOURCE[g.source ?? ""] ?? "授权"} · {shortDate(g.createdAt)}
              {" · "}{g.lastOrderAt ? `最近下单 ${shortDate(g.lastOrderAt)}` : "还没下过单"}
            </small>
          </div>
          <button className="btn sm line" type="button" disabled={busy} onClick={() => revoke(g)}>撤销</button>
        </div>
      ))}
    </div>
  );
}

// For MCP clients that take a key instead of sending an approval link. Kept low-key: most owners never need it.
function ApiKey({ onCreated }: { onCreated: () => Promise<void> }) {
  const { busy, run } = useAction();
  const toast = useToast();
  const [key, setKey] = useState<string | null>(null);

  async function makeKey() {
    const r = await run(() => hive.apiKey("API key"));
    if (r) {
      setKey(r.key);
      await onCreated();
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(key!);
      toast("已复制");
    } catch {
      toast("复制失败，请长按选中");
    }
  }

  if (!key) {
    return (
      <button className="link center" type="button" disabled={busy} onClick={makeKey}>
        给 Cursor 等 MCP 客户端生成 API key
      </button>
    );
  }
  return (
    <div className="card">
      <div className="field" style={{ borderTop: 0 }}>
        <label htmlFor="key">API key</label>
        <input id="key" readOnly value={key} onFocus={(e) => e.target.select()} />
        <span className="hint">只显示这一次，填到 /mcp 的 Bearer 里。<button className="link blue" type="button" onClick={copy}>复制</button></span>
      </div>
    </div>
  );
}

export function MePage() {
  const { me, logout } = useSession();
  const { data: bill } = usePoll(() => hive.bill(), 15_000);
  const { data: grants, reload: reloadGrants } = usePoll(() => hive.agents(), 0);
  const entries = [...(bill?.spent.map((e) => ({ ...e, sign: "-" })) ?? []), ...(bill?.earned.map((e) => ({ ...e, sign: "+" })) ?? [])]
    .sort((a, b) => (b.paidAt ?? "").localeCompare(a.paidAt ?? ""))
    .slice(0, 20);

  return (
    <>
      <div className="page me">
        <LargeTitle title="我的" right={<Bell />} />
        <div className="cols">
          <div className="col main-col">
            <div className="card profile">
              <span className="av">{me.name.slice(0, 1)}</span>
              <div className="tx">
                <b>{me.name}</b>
                <small className="tnum mono">{me.id}</small>
              </div>
            </div>

            <div className="card">
              <h4><span>账单</span><small>只记已付款的订单</small></h4>
              <div className="stats boxed">
                <div><b className="tnum">{yuan(bill?.spentFen ?? 0)}</b><span>支出（元）</span></div>
                <div><b className="tnum">{yuan(bill?.earnedFen ?? 0)}</b><span>收入（元）</span></div>
                <div><b className="tnum">{(bill?.spent.filter((e) => e.createdByActor === "agent").length ?? 0)}</b><span>agent 发起</span></div>
              </div>
              {bill && entries.length === 0 && <p className="hint-line">还没有付过款的订单</p>}
              {entries.map((e) => (
                <Link className="list-row" key={e.orderId + e.sign} to={`/orders/${e.orderId}`}>
                  <TypeTile type={e.category} size={36} />
                  <div className="tx">
                    <b>{typeTitle(e.category)}</b>
                    <small>{e.sign === "-" && e.createdByActor === "agent" ? "由 agent 发起，你确认 · " : ""}{e.paidAt ? shortDate(e.paidAt) : ""}</small>
                  </div>
                  <div className="r"><b className="tnum" style={{ color: e.sign === "+" ? "var(--ok)" : "var(--ink)" }}>{e.sign}{yuan(e.priceFen)}</b></div>
                </Link>
              ))}
            </div>
          </div>
          <div className="col side-col">
            <Notify />
            <Rules />
            <Agents grants={grants ?? []} reload={reloadGrants} />
            <div className="card flush">
              <button className="cell-btn danger" type="button" onClick={logout}>退出登录</button>
            </div>
            <ApiKey onCreated={reloadGrants} />
          </div>
        </div>
      </div>
      <TabBar />
    </>
  );
}
