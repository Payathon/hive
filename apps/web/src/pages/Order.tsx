import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ApiError, hive, type OrderDetail } from "../api.ts";
import {
  CANCEL_REASON,
  dateTime,
  FAIL_REASON,
  fileSize,
  isTerminal,
  mmss,
  specText,
  STATUS_LABEL,
  statusTone,
  timeline,
  typeTitle,
  VERDICT,
  yuan,
} from "../format.ts";
import { AgentIcon, NavBar, Skeleton, Timeline, TypeTile, useAction, useNow, usePoll, useSession, useToast, useWide } from "../ui.tsx";

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
      return o.offerKind === "human" ? `等卖家审批，${left} 内没人接就换一批卖家` : "卖家通常几秒内接单";
    case "ACCEPTED":
      return "马上可以付款";
    case "AWAITING_PAYMENT":
      return buyer ? `请在 ${left} 内付款，超时自动取消` : `等买家付款，${left} 后超时取消`;
    case "PAID":
      return buyer ? "钱已直接付给卖家，等卖家开始" : "买家已付款，做完在下面交付";
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
  return [
    ["要做什么", <span className="note">{o.brief}</span>],
    ...(o.input !== null && o.input !== undefined ? [["附加数据", <code>{JSON.stringify(o.input)}</code>] as [string, ReactNode]] : []),
    ["交付要求", specText(o.deliverySpec)],
  ];
}

type Store = { name: string; area?: string; address?: string; rating?: number; priceLevel?: number };

// Competitor data gets a readable list; any other data is shown as JSON.
function DataView({ data }: { data: unknown }) {
  const [all, setAll] = useState(false);
  const stores = (data as { stores?: unknown } | null)?.stores;
  if (Array.isArray(stores) && stores.every((s) => s && typeof s === "object" && "name" in s)) {
    const list = stores as Store[];
    return (
      <>
        <div className="rows">
          {(all ? list : list.slice(0, 5)).map((s, i) => (
            <div className="row" key={i}>
              <span>{s.name}{s.area ? ` · ${s.area}` : ""}{s.address && <><br /><small style={{ color: "var(--sub)" }}>{s.address}</small></>}</span>
              <em className="tnum">{[s.rating != null && `${s.rating} 分`, s.priceLevel != null && `人均 ¥${s.priceLevel}`].filter(Boolean).join(" · ")}</em>
            </div>
          ))}
        </div>
        {list.length > 5 && (
          <button className="link blue" type="button" style={{ width: "100%", marginTop: 4 }} onClick={() => setAll(!all)}>
            {all ? "收起" : `查看全部 ${list.length} 条`}
          </button>
        )}
      </>
    );
  }
  return <pre className="json">{JSON.stringify(data, null, 2)}</pre>;
}

// Folds long deliveries so the review buttons stay in reach on a phone.
function Folded({ long, children }: { long: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!long) return <>{children}</>;
  return (
    <>
      <div className={open ? undefined : "folded"}>{children}</div>
      <button className="link blue" type="button" onClick={() => setOpen(!open)}>{open ? "收起" : "展开全部"}</button>
    </>
  );
}

// A seller's note as plain text, with fenced code blocks set apart. No markup is interpreted.
function Note({ text }: { text: string }) {
  const parts = text.split(/```[\w-]*\n?([\s\S]*?)```/g);
  return (
    <Folded long={text.length > 500}>
      {parts.map((part, i) =>
        i % 2 ? <pre key={i} className="json">{part.trimEnd()}</pre> : part.trim() && <p key={i} className="note">{part.trim()}</p>,
      )}
    </Folded>
  );
}

function Deliverable({ o }: { o: OrderDetail }) {
  const out = o.output;
  if (!out) return null;
  const images = out.files.filter((f) => f.mime.startsWith("image/"));
  const videos = out.files.filter((f) => f.mime.startsWith("video/"));
  const others = out.files.filter((f) => !images.includes(f) && !videos.includes(f));
  return (
    <div className="card">
      <h4><span>交付内容</span><small>{out.files.length ? `${out.files.length} 个文件` : ""}</small></h4>
      {out.note && <Note text={out.note} />}
      {out.data !== null && <Folded long={JSON.stringify(out.data).length > 800}><DataView data={out.data} /></Folded>}
      {images.length > 0 && (
        <div className="photos" style={{ marginTop: 8 }}>
          {images.map((f) => (
            <a key={f.id} href={f.url} target="_blank" rel="noreferrer"><img src={f.url} alt={f.name} /></a>
          ))}
        </div>
      )}
      {videos.map((f) => <video key={f.id} className="video" src={f.url} controls playsInline preload="metadata" />)}
      {(others.length > 0 || videos.length > 0) && (
        <div className="files">
          {[...videos, ...others].map((f) => (
            <a key={f.id} href={f.url} download={f.name}>{f.name}<small>{fileSize(f.size)}</small></a>
          ))}
        </div>
      )}
    </div>
  );
}

function Thumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url ? <img src={url} alt="" /> : <span className="file-ic">{file.name.split(".").pop()?.slice(0, 4).toUpperCase()}</span>;
}

// One way in for deliveries: the owner here, `hive serve`'s run command, or the owner's agent via hive_deliver.
function DeliverForm({ o, onDone }: { o: OrderDetail; onDone: () => void }) {
  const { busy, run } = useAction();
  const toast = useToast();
  const spec = o.deliverySpec;
  const [note, setNote] = useState("");
  const [json, setJson] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  // Photos straight from the camera on a phone; other types open the file picker.
  const accept = spec.kind === "files" ? spec.accept : undefined;
  const camera = accept?.startsWith("image/");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    let data: unknown;
    if (json.trim()) {
      try {
        data = JSON.parse(json);
      } catch {
        return toast("数据不是合法的 JSON");
      }
    }
    const r = await run(async () => {
      const ids = [];
      for (const f of files) ids.push((await hive.upload(o.id, f)).id);
      return hive.deliver(o.id, { ...(note.trim() ? { note } : {}), ...(data !== undefined ? { data } : {}), files: ids });
    });
    if (r) {
      toast("已交付");
      onDone();
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h4><span>交付</span><small>买家要：{specText(spec)}</small></h4>
      <div className="inline-note"><AgentIcon small />也可以让你的 agent 交付：它用 hive 的 hive_deliver 工具，订单号 {o.id}</div>
      {spec.kind !== "json" && (
        <div className="field">
          <span className="label">{camera ? "照片" : "文件"}</span>
          <label className="drop" htmlFor="files">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {camera ? <path d="M4 8h3l2-2.5h6L17 8h3v11H4zM12 16.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /> : <path d="M12 16V4M7 9l5-5 5 5M4 15v5h16v-5" />}
            </svg>
            <b>{camera ? "拍照或选照片" : "选择文件"}</b>
            <small>{files.length ? `已选 ${files.length} 个，可以继续添加` : specText(spec)}</small>
          </label>
          <input id="files" className="visually-hidden" type="file" multiple accept={accept} {...(camera ? { capture: "environment" } : {})}
            onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
          {files.length > 0 && (
            <div className="files picked">
              {files.map((f, i) => (
                <div className="file" key={i}>
                  <Thumb file={f} />
                  <span className="tx">{f.name}<small>{fileSize(f.size)}</small></span>
                  <button type="button" className="link" onClick={() => setFiles(files.filter((_, j) => j !== i))}>移除</button>
                </div>
              ))}
            </div>
          )}
          {camera && <span className="hint">可以多拍几张，每拍一张会加到列表里</span>}
        </div>
      )}
      {(spec.kind === "json" || spec.kind === "any") && (
        <div className="field">
          <label htmlFor="out">{spec.kind === "json" ? "数据（JSON）" : "数据（JSON，可不填）"}</label>
          <textarea id="out" value={json} onChange={(e) => setJson(e.target.value)} required={spec.kind === "json"} />
        </div>
      )}
      <div className="field">
        <label htmlFor="note">给买家的说明</label>
        <textarea id="note" className="prose" value={note} onChange={(e) => setNote(e.target.value)} placeholder="交付了什么、有什么要注意的" />
      </div>
      <button className="btn" type="submit" disabled={busy}>{busy ? "提交中…" : "提交交付"}</button>
    </form>
  );
}

export function OrderPage() {
  const { id = "" } = useParams();
  const { me } = useSession();
  const toast = useToast();
  const now = useNow();
  const { busy, run } = useAction();
  const wide = useWide();
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
        {missing || error ? <div className="empty">{missing ? "找不到这个订单" : "加载失败，稍后自动重试"}</div> : <Skeleton head rows={4} />}
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
    if (isTerminal(o)) actions = <Link className="btn line" style={{ textAlign: "center" }} to={`/buy/${o.category}`}>再来一单</Link>;
  } else {
    // Delivering starts the order anyway; this only tells the buyer someone is on it.
    if (o.status === "PAID")
      actions = <button className="link" type="button" disabled={busy} onClick={() => act("start", undefined, "已告诉买家你开始了")}>先告诉买家我开始了</button>;
    if (o.status === "IN_PROGRESS")
      actions = <button className="link" type="button" disabled={busy} onClick={() => window.confirm("放弃后订单失败，买家的钱已经付给你了。确定放弃吗？") && act("abandon", undefined, "已放弃")}>放弃这单</button>;
  }

  const amount = o.priceFen === null ? "—" : `${o.status === "COMPLETED" ? (role === "buyer" ? "-" : "+") : ""}${yuan(o.priceFen)}`;

  const banner = o.createdByActor === "agent" && (
    <div className="card agent-banner">
      <AgentIcon />
      <div>
        {role === "buyer" ? "由你的 agent 发起" : "这单由买家的 agent 发起"}
        <small>{role === "buyer" ? "agent 负责下单和验收，每笔付款都要你确认" : "付款由买家本人在支付宝确认"}</small>
      </div>
    </div>
  );

  const details = (
    <div className="card">
      <h4>订单信息</h4>
      <dl className="kv">
        {inputRows(o).map(([k, v]) => (
          <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>
        ))}
        {role === "buyer" && (
          <>
            <dt>卖家</dt>
            <dd>
              {o.sellerName ?? "派单中"}
              {o.sellerName && o.sellerWorkMode && <span className={`tag${o.sellerWorkMode === "manual" ? " person" : ""}`}>{o.sellerWorkMode === "manual" ? "真人" : "agent"}</span>}
            </dd>
          </>
        )}
        <dt>付款方式</dt>
        <dd>支付宝，钱直接给卖家</dd>
        <dt>订单编号</dt>
        <dd className="tnum mono">{o.id}</dd>
        <dt>创建时间</dt>
        <dd className="tnum">{dateTime(o.createdAt)}</dd>
      </dl>
    </div>
  );

  const head = (
    <div className="bill-head">
      <TypeTile type={o.category} size={48} />
      <div className="name">{typeTitle(o.category)}{o.sellerName ? ` · ${o.sellerName}` : ""}</div>
      <div className="amt tnum">{amount}</div>
      <div className={`status tone-${tone}`}>
        {role === "seller" && o.status === "PAID" ? "可以开始了" : STATUS_LABEL[o.status]}
        <small className="tnum">{statusLine(o, role, now)}</small>
      </div>
    </div>
  );

  const work = (
    <>
      {(o.status === "DELIVERED" || o.status === "COMPLETED") && <Deliverable o={o} />}
      {role === "seller" && (o.status === "PAID" || o.status === "IN_PROGRESS") && <DeliverForm o={o} onDone={() => void reload()} />}
      <div className="card">
        <h4>订单进度</h4>
        <Timeline steps={timeline(o, role)} />
      </div>
    </>
  );

  // Phone: 支付宝账单 order, one column with the main button pinned to the bottom.
  // Laptop: the work on the left; who started it, the details and the buttons on the right.
  if (!wide) {
    return (
      <div className="page order">
        <NavBar title="订单详情" />
        {head}
        {banner}
        {work}
        {details}
        {actions && <div className="actionbar">{actions}</div>}
      </div>
    );
  }
  return (
    <div className="page order">
      <NavBar title="订单详情" />
      <div className="cols">
        <div className="col main-col">
          <div className="card head-card">{head}</div>
          {work}
        </div>
        <div className="col side-col">
          {actions && <div className="card action-panel">{actions}</div>}
          {banner}
          {details}
        </div>
      </div>
    </div>
  );
}
