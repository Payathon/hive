import { useState } from "react";
import { Link } from "react-router";
import { hive } from "../api.ts";
import { mmss, typeTitle, yuan } from "../format.ts";
import { AgentIcon, TabBar, TypeTile, useNow, usePoll } from "../ui.tsx";

const BLURB: Record<string, string> = {
  "market-data.competitors": "给城市、商圈和品类，返回周边同类门店的名称、地址、评分和人均",
  "chart.compare": "把一组数据画成对比图，附一句说明",
  "photo.onsite": "请附近的人去指定地点拍照，带拍摄时间和位置",
};

const pct = (r: number | null) => (r === null ? "新卖家" : `通过率 ${Math.round(r * 100)}%`);

export function Market() {
  const now = useNow();
  const { data: market, error } = usePoll(() => hive.market(), 15_000);
  const { data: pending } = usePoll(async () => (await hive.orders("buyer")).filter((o) => o.status === "AWAITING_PAYMENT"), 5000);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <div className="page">
        <div className="m-top">
          <div className="m-title">hive 市场<small>agent 和人都能买、都能卖</small></div>
        </div>

        {pending?.map((o) => (
          <Link key={o.id} to={`/orders/${o.id}`} className="card pending">
            {o.createdByActor === "agent" ? <AgentIcon /> : <TypeTile type={o.capabilityType} size={28} />}
            <div className="tx">
              {o.createdByActor === "agent" ? "你的 agent 买了" : "你买了"}{typeTitle(o.capabilityType)}
              <small className="tnum">等你付款 ¥{yuan(o.priceFen)}{o.deadline ? ` · 剩余 ${mmss(new Date(o.deadline).getTime() - now)}` : ""}</small>
            </div>
            <span className="btn sm">去付款</span>
          </Link>
        ))}

        <div className="card">
          <h4><span>全部能力</span><small>价格低、通过率高的卖家排前面</small></h4>
          {error && !market ? <div className="empty">加载失败，稍后自动重试</div> : null}
          {market?.map((m) => {
            const online = m.sellers.filter((s) => s.online).length;
            const from = m.sellers[0]?.priceFen ?? null;
            const isOpen = open === m.type;
            return (
              <div className="cap" key={m.type}>
                <button className="cap-hd" type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : m.type)}>
                  <TypeTile type={m.type} />
                  <div className="tx">
                    <b>{m.title}</b>
                    <small>{BLURB[m.type] ?? m.type}</small>
                    <small><span className={`dot${online ? " on" : ""}`} />{online} 位在线 · 共 {m.sellers.length} 位卖家</small>
                  </div>
                  <span className="pr">{from === null ? <small>暂无</small> : <>¥{yuan(from)}<small> 起</small></>}</span>
                </button>
                {isOpen && (
                  <div className="cap-body">
                    {m.sellers.length === 0 && <div className="seller-row"><small>还没有卖家上架这个能力</small></div>}
                    {m.sellers.map((s, i) => (
                      <div className="seller-row" key={i}>
                        <span className="av">{s.name.slice(0, 1)}</span>
                        <div className="tx">
                          {s.name}
                          <span className={`tag${s.kind === "human" ? " person" : ""}`}>{s.kind === "human" ? "真人" : "agent"}</span>
                          <small><span className={`dot${s.online ? " on" : ""}`} />{s.online ? "在线" : "离线"} · {pct(s.passRate)} · 成交 {s.completed} 单</small>
                        </div>
                        <span className="tnum">¥{yuan(s.priceFen)}</span>
                      </div>
                    ))}
                    <Link className="btn" style={{ display: "block", textAlign: "center", marginTop: 10 }} to={`/buy/${m.type}`}>下单</Link>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <TabBar />
    </>
  );
}
