import { useState } from "react";
import { Link } from "react-router";
import { hive } from "../api.ts";
import { mmss, setCategories, typeTitle, yuan } from "../format.ts";
import { AgentIcon, TabBar, TypeTile, useNow, usePoll } from "../ui.tsx";

const pct = (r: number | null) => (r === null ? "新卖家" : `通过率 ${Math.round(r * 100)}%`);

export function Market() {
  const now = useNow();
  const { data: market, error } = usePoll(async () => {
    const cats = await hive.categories();
    setCategories(cats);
    return cats;
  }, 15_000);
  const { data: pending } = usePoll(async () => (await hive.orders("buyer")).filter((o) => o.status === "AWAITING_PAYMENT"), 5000);
  const [open, setOpen] = useState<string | null>(null);
  // Categories with sellers first, so the market doesn't open on a wall of empty rows.
  const sorted = market && [...market.filter((m) => m.sellers.length), ...market.filter((m) => !m.sellers.length)];

  return (
    <>
      <div className="page">
        <div className="m-top">
          <div className="m-title">hive 市场<small>agent 和人都能买、都能卖</small></div>
        </div>

        {pending?.map((o) => (
          <Link key={o.id} to={`/orders/${o.id}`} className="card pending">
            {o.createdByActor === "agent" ? <AgentIcon /> : <TypeTile type={o.category} size={28} />}
            <div className="tx">
              {o.createdByActor === "agent" ? "你的 agent 买了" : "你买了"}{typeTitle(o.category)}
              <small className="tnum">等你付款 ¥{yuan(o.priceFen)}{o.deadline ? ` · 剩余 ${mmss(new Date(o.deadline).getTime() - now)}` : ""}</small>
            </div>
            <span className="btn sm">去付款</span>
          </Link>
        ))}

        <div className="card">
          <h4><span>全部类目</span><small>标签对得上、价格低、通过率高的卖家排前面</small></h4>
          {error && !market ? <div className="empty">加载失败，稍后自动重试</div> : null}
          {sorted?.map((m) => {
            const online = m.sellers.filter((s) => s.online).length;
            const from = m.sellers[0]?.priceFen ?? null;
            const isOpen = open === m.id;
            return (
              <div className="cap" key={m.id}>
                <button className="cap-hd" type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : m.id)}>
                  <TypeTile type={m.id} />
                  <div className="tx">
                    <b>{m.title}</b>
                    <small>{m.blurb}</small>
                    <small><span className={`dot${online ? " on" : ""}`} />{online} 位可接单 · 共 {m.sellers.length} 位卖家</small>
                  </div>
                  <span className="pr">{from === null ? <small>暂无</small> : <>¥{yuan(from)}<small> 起</small></>}</span>
                </button>
                {isOpen && (
                  <div className="cap-body">
                    {m.sellers.length === 0 && <div className="seller-row"><small>还没有卖家上架这个类目</small></div>}
                    {m.sellers.map((s, i) => (
                      <div className="seller-row" key={i}>
                        <span className="av">{s.name.slice(0, 1)}</span>
                        <div className="tx">
                          {s.name}
                          <span className={`tag${s.workStyle === "agent 全自动" ? "" : " person"}`}>{s.workStyle}</span>
                          {s.intro && <small>{s.intro}</small>}
                          {s.tags.length > 0 && <small>{s.tags.map((t) => `#${t}`).join(" ")}</small>}
                          <small><span className={`dot${s.online ? " on" : ""}`} />{s.online ? "可接单" : "暂不接单"} · {pct(s.passRate)} · 成交 {s.completed} 单</small>
                        </div>
                        <span className="tnum">¥{yuan(s.priceFen)}</span>
                      </div>
                    ))}
                    <Link className="btn" style={{ display: "block", textAlign: "center", marginTop: 10 }} to={`/buy/${m.id}`}>下单</Link>
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
