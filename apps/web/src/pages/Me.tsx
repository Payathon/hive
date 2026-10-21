import { useState } from "react";
import { Link } from "react-router";
import { hive, type AgentGrant } from "../api.ts";
import { shortDate, typeTitle, yuan } from "../format.ts";
import { AgentIcon, Switch, TabBar, useAction, usePoll, useSession, useToast } from "../ui.tsx";

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
      <div className="field" style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
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
      <button className="link" type="button" disabled={busy} onClick={makeKey} style={{ alignSelf: "center" }}>
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

  return (
    <>
      <div className="page">
        <div className="bill-head" style={{ paddingTop: "calc(24px + env(safe-area-inset-top, 0px))" }}>
          <span className="type-tile" style={{ background: "var(--blue)", borderRadius: "50%", fontSize: 18 }}>{me.name.slice(0, 1)}</span>
          <div className="amt" style={{ fontSize: 22 }}>{me.name}</div>
          <div className="status tone-mute"><small className="tnum">{me.id}</small></div>
        </div>

        <div className="card">
          <h4><span>账单</span><small>只记已付款的订单</small></h4>
          <div className="stats" style={{ marginBottom: bill?.spent.length || bill?.earned.length ? 12 : 0 }}>
            <div><b className="tnum">{yuan(bill?.spentFen ?? 0)}</b><span>支出（元）</span></div>
            <div><b className="tnum">{yuan(bill?.earnedFen ?? 0)}</b><span>收入（元）</span></div>
            <div><b className="tnum">{(bill?.spent.filter((e) => e.createdByActor === "agent").length ?? 0)}</b><span>agent 发起</span></div>
          </div>
          {[...(bill?.spent.map((e) => ({ ...e, sign: "-" })) ?? []), ...(bill?.earned.map((e) => ({ ...e, sign: "+" })) ?? [])]
            .sort((a, b) => (b.paidAt ?? "").localeCompare(a.paidAt ?? ""))
            .slice(0, 20)
            .map((e) => (
              <Link className="list-row" key={e.orderId + e.sign} to={`/orders/${e.orderId}`}>
                <div className="tx">
                  <b>{typeTitle(e.capabilityType)}</b>
                  <small>{e.sign === "-" && e.createdByActor === "agent" ? "由 agent 发起，你确认 · " : ""}{e.paidAt ? shortDate(e.paidAt) : ""}</small>
                </div>
                <div className="r"><b className="tnum" style={{ color: e.sign === "+" ? "var(--ok)" : "var(--ink)" }}>{e.sign}{yuan(e.priceFen)}</b></div>
              </Link>
            ))}
        </div>

        <Rules />
        <Agents grants={grants ?? []} reload={reloadGrants} />
        <div className="card" style={{ padding: 0 }}>
          <button className="btn line" type="button" style={{ border: 0 }} onClick={logout}>退出登录</button>
        </div>
        <ApiKey onCreated={reloadGrants} />
      </div>
      <TabBar />
    </>
  );
}
