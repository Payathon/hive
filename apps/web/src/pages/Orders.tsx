import { useState } from "react";
import { Link } from "react-router";
import { hive } from "../api.ts";
import { shortDate, STATUS_LABEL, statusTone, typeTitle, yuan } from "../format.ts";
import { Bell, TabBar, TypeTile, usePoll } from "../ui.tsx";

export function Orders() {
  const [role, setRole] = useState<"buyer" | "seller">("buyer");
  const { data: orders } = usePoll(() => hive.orders(role), 5000, [role]);

  return (
    <>
      <div className="page">
        <header className="navbar"><span /><b>我的订单</b><Bell /></header>
        <div className="segment" role="tablist">
          <button type="button" role="tab" aria-selected={role === "buyer"} className={role === "buyer" ? "on" : ""} onClick={() => setRole("buyer")}>我买的</button>
          <button type="button" role="tab" aria-selected={role === "seller"} className={role === "seller" ? "on" : ""} onClick={() => setRole("seller")}>我卖的</button>
        </div>
        {orders && orders.length === 0 && (
          <div className="empty">{role === "buyer" ? "还没有买过东西。让你的 agent 下单，或者去市场逛逛" : "还没有卖出过。去“接单”上架能力并开始接单"}</div>
        )}
        {orders && orders.length > 0 && (
          <div className="card">
            {orders.map((o) => {
              const sign = o.status === "COMPLETED" ? (role === "buyer" ? "-" : "+") : "";
              return (
                <Link className="list-row" key={o.id} to={`/orders/${o.id}`}>
                  <TypeTile type={o.category} size={36} />
                  <div className="tx">
                    <b>{typeTitle(o.category)}</b>
                    {o.createdByActor === "agent" && <span className="tag">{role === "buyer" ? "agent 发起" : "买家 agent"}</span>}
                    <small className="tnum">{shortDate(o.createdAt)}{o.brief ? ` · ${o.brief.slice(0, 24)}` : ""}</small>
                  </div>
                  <div className="r">
                    <b className="tnum">{o.priceFen === null ? "—" : `${sign}${yuan(o.priceFen)}`}</b>
                    <small className={`tone-${statusTone(o.status)}`}>{STATUS_LABEL[o.status]}</small>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
      <TabBar />
    </>
  );
}
