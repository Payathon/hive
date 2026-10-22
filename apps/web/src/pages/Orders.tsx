import { useState } from "react";
import { Link } from "react-router";
import { hive } from "../api.ts";
import { shortDate, STATUS_LABEL, statusTone, typeTitle, yuan } from "../format.ts";
import { Bell, Empty, LargeTitle, Skeleton, TabBar, TypeTile, usePoll } from "../ui.tsx";

export function Orders() {
  const [role, setRole] = useState<"buyer" | "seller">("buyer");
  const { data: orders } = usePoll(() => hive.orders(role), 5000, [role]);

  return (
    <>
      <div className="page narrow">
        <LargeTitle title="订单" right={<Bell />} />
        <div className="segment" role="tablist">
          <button type="button" role="tab" aria-selected={role === "buyer"} className={role === "buyer" ? "on" : ""} onClick={() => setRole("buyer")}>我买的</button>
          <button type="button" role="tab" aria-selected={role === "seller"} className={role === "seller" ? "on" : ""} onClick={() => setRole("seller")}>我卖的</button>
        </div>
        {!orders && <Skeleton rows={5} />}
        {orders && orders.length === 0 && (
          <div className="card">
            <Empty title={role === "buyer" ? "还没有买过东西" : "还没有卖出过"}>
              {role === "buyer" ? "让你的 agent 下单，或者去市场逛逛" : "去「接单」上架能力并开始接单"}
              <Link className="btn sm" to={role === "buyer" ? "/" : "/desk"}>{role === "buyer" ? "去市场" : "去接单"}</Link>
            </Empty>
          </div>
        )}
        {orders && orders.length > 0 && (
          <div className="card list">
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
