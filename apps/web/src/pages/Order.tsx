import { Fragment, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ApiError, hive, type OrderDetail } from "../api.ts";
import {
  CANCEL_REASON,
  dateTime,
  FAIL_REASON,
  isTerminal,
  mmss,
  STATUS_LABEL,
  statusTone,
  timeline,
  typeTitle,
  VERDICT,
  yuan,
} from "../format.ts";
import { AgentIcon, NavBar, Timeline, TypeTile, useAction, useNow, usePoll, useSession, useToast } from "../ui.tsx";

type Role = "buyer" | "seller";

// The fake payment provider hands out links to the API itself; real ones go to Alipay.
const fakePayPath = (url: string | null) => {
  if (!url) return null;
  try {
    const path = new URL(url).pathname;
    return path.startsWith("/v1/dev/fake-pay/") ? path : null;
  } catch {
    return null;
  }
};

function statusLine(o: OrderDetail, role: Role, now: number): string {
  const left = o.deadline ? mmss(new Date(o.deadline).getTime() - now) : "";
  const buyer = role === "buyer";
  switch (o.status) {
    case "CREATED":
    case "DISPATCHING":
      return "正在找在线卖家";
    case "OFFERED":
      return o.offerKind === "human" ? `已派给在线的真人卖家，${left} 内有人接` : "卖家通常几秒内接单";
    case "ACCEPTED":
      return "马上可以付款";
    case "AWAITING_PAYMENT":
      return buyer ? `请在 ${left} 内付款，超时自动取消` : `等买家付款，${left} 后超时取消`;
    case "PAID":
      return buyer ? "钱已直接付给卖家，等卖家开始" : "买家已付款，可以开始了";
    case "IN_PROGRESS":
      return `${left} 内交付`;
    case "DELIVERED":
      return buyer ? `请检查交付内容，${left} 后自动确认收货` : `等买家验收，${left} 后自动确认`;
    case "COMPLETED":
      return VERDICT[o.verdict ?? ""] ?? "";
    case "CANCELLED":
      return CANCEL_REASON[o.cancelReason ?? ""] ?? "";
    case "FAILED":
      return (FAIL_REASON[o.failReason ?? ""] ?? "") + (o.paidAt && buyer ? "。退款功能还在接入中，请联系卖家" : "");
  }
}

function inputRows(o: OrderDetail): Array<[string, ReactNode]> {
  const i = (o.input ?? {}) as Record<string, unknown>;
  if (o.capabilityType === "market-data.competitors")
    return [["城市", String(i.city)], ["商圈", (i.areas as string[]).join("、")], ["品类", String(i.category)]];
  if (o.capabilityType === "photo.onsite")
    return [["地点", String(i.location)], ["拍什么", String(i.subject)], ["张数", `${i.count} 张`]];
  if (o.capabilityType === "chart.compare") return [["图表", String(i.title)], ["数据", `${(i.data as unknown[]).length} 行`]];
  return [["输入", <code>{JSON.stringify(i)}</code>]];
}

function Deliverable({ o }: { o: OrderDetail }) {
  const [all, setAll] = useState(false);
  const out = o.output as Record<string, unknown> | null;
  if (!out) return null;
  if (o.capabilityType === "market-data.competitors") {
    const stores = out.stores as Array<{ name: string; area: string; address: string; rating?: number; priceLevel?: number }>;
    return (
      <div className="card">
        <h4><span>交付内容</span><small>{stores.length} 家门店 · 来源 {String(out.source)}</small></h4>
        <div className="rows">
          {(all ? stores : stores.slice(0, 5)).map((s, i) => (
            <div className="row" key={i}>
              <span>{s.name} · {s.area}<br /><small style={{ color: "var(--sub)" }}>{s.address}</small></span>
              <em className="tnum">{[s.rating != null && `${s.rating} 分`, s.priceLevel != null && `人均 ¥${s.priceLevel}`].filter(Boolean).join(" · ")}</em>
            </div>
          ))}
        </div>
        {stores.length > 5 && (
          <button className="link blue" type="button" style={{ width: "100%", marginTop: 4 }} onClick={() => setAll(!all)}>
            {all ? "收起" : `查看全部 ${stores.length} 家`}
          </button>
        )}
      </div>
    );
  }
  if (o.capabilityType === "chart.compare")
    return (
      <div className="card">
        <h4><span>交付内容</span><small>{String(out.caption)}</small></h4>
        <img className="chart-img" src={String(out.imageUrl)} alt={String(out.caption)} />
      </div>
    );
  if (o.capabilityType === "photo.onsite") {
    const photos = out.photos as Array<{ url: string; note?: string }>;
    return (
      <div className="card">
        <h4><span>交付内容</span><small>{photos.length} 张照片</small></h4>
        <div className="photos">
          {photos.map((p, i) => (
            <a key={i} href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={p.note ?? `照片 ${i + 1}`} /></a>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="card"><h4>交付内容</h4><pre className="json">{JSON.stringify(out, null, 2)}</pre></div>
  );
}

// One way in for deliveries: the owner here, `hive serve`'s run command, or the owner's agent via hive_deliver.
function DeliverForm({ o, onDone }: { o: OrderDetail; onDone: () => void }) {
  const { busy, run } = useAction();
  const toast = useToast();
  const count = o.capabilityType === "photo.onsite" ? Number((o.input as { count?: number }).count ?? 1) : 0;
  const [urls, setUrls] = useState<string[]>(() => Array(count).fill(""));
  const [json, setJson] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    let output: unknown;
    if (count) output = { photos: urls.map((u) => u.trim()).filter(Boolean).map((url) => ({ url })) };
    else {
      try {
        output = JSON.parse(json);
      } catch {
        return toast("交付内容不是合法的 JSON");
      }
    }
    const r = await run(() => hive.action(o.id, "deliver", { output }));
    if (r) {
      toast("已交付");
      onDone();
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h4><span>交付</span><small>提交后先做格式校验，没通过可以改了再交</small></h4>
      <div className="inline-note"><AgentIcon small />也可以让你的 agent 交付：它用 hive 的 hive_deliver 工具，订单号 {o.id}</div>
      {count ? (
        urls.map((u, i) => (
          <div className="field" key={i}>
            <label htmlFor={`p${i}`}>照片 {i + 1} 链接</label>
            <input id={`p${i}`} type="url" value={u} placeholder="https://…" onChange={(e) => setUrls(urls.map((x, j) => (j === i ? e.target.value : x)))} required={i === 0} />
          </div>
        ))
      ) : (
        <div className="field">
          <label htmlFor="out">交付内容（JSON）</label>
          <textarea id="out" value={json} onChange={(e) => setJson(e.target.value)} required />
        </div>
      )}
      {count > 0 && <p className="field hint" style={{ border: 0, padding: "4px 0 0" }}>直接上传照片还在做，先贴图片链接</p>}
      <button className="btn" type="submit" disabled={busy} style={{ marginTop: 12 }}>提交交付</button>
    </form>
  );
}

export function OrderPage() {
  const { id = "" } = useParams();
  const { me } = useSession();
  const toast = useToast();
  const now = useNow();
  const { busy, run } = useAction();
  const [polling, setPolling] = useState(true);

  const { data: o, error, reload } = usePoll(
    async () => {
      let order = await hive.order(id);
      // 即刻收 sends no payment notification, so the buyer's page asks while it waits.
      if (order.status === "AWAITING_PAYMENT" && order.buyerAccountId === me.id) {
        await hive.action(id, "check-payment").catch(() => {});
        order = await hive.order(id);
      }
      setPolling(!isTerminal(order));
      return order;
    },
    polling ? 3000 : 0,
    [id],
  );

  if (!o) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <div className="page">
        <NavBar title="订单详情" />
        <div className="empty">{missing ? "找不到这个订单" : error ? "加载失败，稍后自动重试" : "加载中…"}</div>
      </div>
    );
  }

  const role: Role = o.buyerAccountId === me.id ? "buyer" : "seller";
  const tone = statusTone(o.status);
  const act = async (action: string, body?: unknown, done?: string) => {
    const r = await run(() => hive.action(o.id, action, body));
    if (r) {
      if (done) toast(done);
      await reload();
    }
  };

  async function pay() {
    const fake = fakePayPath(o!.purchaseUrl);
    if (fake) {
      // Test environment: stands in for the buyer confirming in Alipay.
      await run(async () => {
        const res = await fetch(fake, { method: "POST" });
        if (!res.ok) throw new Error("模拟付款失败");
      });
      toast("测试环境：已模拟支付宝付款");
      await act("check-payment");
    } else if (o!.purchaseUrl) {
      window.open(o!.purchaseUrl, "_blank", "noopener");
    }
  }

  let actions: ReactNode = null;
  if (role === "buyer") {
    if (["CREATED", "DISPATCHING", "OFFERED", "ACCEPTED"].includes(o.status))
      actions = <button className="link" type="button" disabled={busy} onClick={() => act("cancel", undefined, "订单已取消")}>取消订单</button>;
    if (o.status === "AWAITING_PAYMENT")
      actions = (
        <>
          <button className="btn" type="button" disabled={busy} onClick={pay}>去支付宝付款 ¥{yuan(o.priceFen)}</button>
          <button className="link" type="button" disabled={busy} onClick={() => act("cancel", undefined, "订单已取消")}>取消订单</button>
        </>
      );
    if (o.status === "DELIVERED")
      actions = (
        <>
          <button className="btn" type="button" disabled={busy} onClick={() => act("verdict", { verdict: "accepted" }, "已确认收货")}>确认收货</button>
          <button className="link" type="button" disabled={busy} onClick={() => window.confirm("拒收会计入卖家的通过率，钱已经付给卖家，暂时不能自动退款。确定拒收吗？") && act("verdict", { verdict: "rejected" }, "已拒收")}>拒收</button>
        </>
      );
    if (isTerminal(o)) actions = <Link className="btn line" style={{ textAlign: "center" }} to={`/buy/${o.capabilityType}`}>再来一单</Link>;
  } else {
    if (o.status === "PAID")
      actions = <button className="btn" type="button" disabled={busy} onClick={() => act("start", undefined, "开始干活")}>开始干活</button>;
    if (o.status === "IN_PROGRESS")
      actions = <button className="link" type="button" disabled={busy} onClick={() => window.confirm("放弃后订单失败，买家的钱已经付给你了。确定放弃吗？") && act("abandon", undefined, "已放弃")}>放弃这单</button>;
  }

  const amount = o.priceFen === null ? "—" : `${o.status === "COMPLETED" ? (role === "buyer" ? "-" : "+") : ""}${yuan(o.priceFen)}`;

  return (
    <div className="page">
      <NavBar title="订单详情" />
      <div className="bill-head">
        <TypeTile type={o.capabilityType} />
        <div className="name">{typeTitle(o.capabilityType)}{o.sellerName ? ` · ${o.sellerName}` : ""}</div>
        <div className="amt tnum">{amount}</div>
        <div className={`status tone-${tone}`}>
          {role === "seller" && o.status === "PAID" ? "可以开始了" : STATUS_LABEL[o.status]}
          <small className="tnum">{statusLine(o, role, now)}</small>
        </div>
      </div>

      {o.createdByActor === "agent" && (
        <div className="card agent-banner">
          <AgentIcon />
          <div>
            {role === "buyer" ? "由你的 agent 发起" : "这单由买家的 agent 发起"}
            <small>{role === "buyer" ? "agent 负责下单和验收，每笔付款都要你确认" : "付款由买家本人在支付宝确认"}</small>
          </div>
        </div>
      )}

      {(o.status === "DELIVERED" || o.status === "COMPLETED") && <Deliverable o={o} />}
      {role === "seller" && o.status === "IN_PROGRESS" && <DeliverForm o={o} onDone={() => void reload()} />}

      <div className="card">
        <h4>订单进度</h4>
        <Timeline steps={timeline(o, role)} />
      </div>

      <div className="card">
        <dl className="kv">
          {inputRows(o).map(([k, v]) => (
            <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>
          ))}
          {role === "buyer" && (
            <>
              <dt>卖家</dt>
              <dd>
                {o.sellerName ?? "派单中"}
                {o.sellerName && o.offerKind && <span className={`tag${o.offerKind === "human" ? " person" : ""}`}>{o.offerKind === "human" ? "真人" : "agent"}</span>}
              </dd>
            </>
          )}
          <dt>付款方式</dt>
          <dd>支付宝，钱直接给卖家</dd>
          <dt>订单编号</dt>
          <dd className="tnum">{o.id}</dd>
          <dt>创建时间</dt>
          <dd className="tnum">{dateTime(o.createdAt)}</dd>
        </dl>
      </div>

      {actions && <div className="actionbar">{actions}</div>}
    </div>
  );
}
