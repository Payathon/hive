import { useState } from "react";
import { Link } from "react-router";
import { hive, type CategoryInfo } from "../api.ts";
import { mmss, setCategories, typeTitle, yuan } from "../format.ts";
import { ConnectCard, useDismissed } from "../connect.tsx";
import { AgentIcon, Bell, Empty, LargeTitle, Skeleton, TabBar, TypeTile, useNow, usePoll, useWide } from "../ui.tsx";

const pct = (r: number | null) => (r === null ? "新卖家" : `通过率 ${Math.round(r * 100)}%`);

type Cat = CategoryInfo;

function Sellers({ m }: { m: Cat }) {
  if (m.sellers.length === 0) return <div className="seller-empty">还没有卖家上架这个类目</div>;
  return (
    <div className="sellers">
      {m.sellers.map((s, i) => (
        <div className="seller-row" key={i}>
          <span className={`av${s.workStyle === "agent 全自动" ? " agent" : ""}`}>{s.name.slice(0, 1)}</span>
          <div className="tx">
            <div className="nm">
              {s.name}
              <span className={`tag${s.workStyle === "agent 全自动" ? "" : " person"}`}>{s.workStyle}</span>
            </div>
            {s.intro && <small>{s.intro}</small>}
            <small><span className={`dot${s.online ? " on" : ""}`} />{s.online ? "可接单" : "暂不接单"} · {pct(s.passRate)} · 成交 {s.completed} 单</small>
            {s.tags.length > 0 && <div className="chips">{s.tags.slice(0, 5).map((t) => <span key={t}>{t}</span>)}</div>}
          </div>
          <span className="pr tnum"><small>¥</small>{yuan(s.priceFen)}</span>
        </div>
      ))}
    </div>
  );
}

// Laptop: the picked category, its sellers and the 下单 button, next to the list.
function Detail({ m }: { m: Cat | undefined }) {
  if (!m) return <div className="card m-detail"><Empty icon="market" title="选一个类目">看看谁在卖、多少钱</Empty></div>;
  const online = m.sellers.filter((s) => s.online).length;
  const from = m.sellers[0]?.priceFen ?? null;
  return (
    <aside className="card m-detail" aria-label={m.title}>
      <div className="md-head">
        <TypeTile type={m.id} size={52} />
        <div className="tx">
          <h2>{m.title}</h2>
          <p>{m.blurb}</p>
        </div>
      </div>
      <div className="md-stats">
        <div><b className="price tnum">{from === null ? "—" : <><small>¥</small>{yuan(from)}</>}</b><span>起步价</span></div>
        <div><b className="tnum">{online}</b><span>位可接单</span></div>
        <div><b className="tnum">{m.sellers.length}</b><span>位卖家</span></div>
      </div>
      <h4 className="md-label">卖家</h4>
      <Sellers m={m} />
      <Link className="btn" to={`/buy/${m.id}`}>下单</Link>
      <p className="md-foot">接单后再付款，钱直接到卖家的支付宝</p>
    </aside>
  );
}

// For owners with no agent yet: one line that opens the 接入你的 agent card. Dismissible per browser.
function ConnectNudge() {
  const [dismissed, dismiss] = useDismissed("market-connect");
  const [open, setOpen] = useState(false);
  const { data: grants } = usePoll(() => hive.agents(), 0);
  if (dismissed || !grants || grants.length > 0) return null;
  if (open) return <ConnectCard title="让你的 agent 来下单" sub="复制这句话给它，它自己完成接入" initial="buy" onDismiss={dismiss} />;
  return (
    <div className="card nudge">
      <AgentIcon />
      <div className="tx">让你的 agent 替你找服务、下单<small>复制一句话给 Claude Code、Cursor 等，你只需点「同意」</small></div>
      <button className="btn sm" type="button" onClick={() => setOpen(true)}>接入</button>
      <button className="x" type="button" aria-label="不再显示" onClick={dismiss}>×</button>
    </div>
  );
}

export function Market() {
  const now = useNow();
  const wide = useWide();
  const { data: market, error } = usePoll(async () => {
    const cats = await hive.categories();
    setCategories(cats);
    return cats;
  }, 15_000);
  const { data: pending } = usePoll(async () => (await hive.orders("buyer")).filter((o) => o.status === "AWAITING_PAYMENT"), 5000);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  // Categories with sellers first, so the market doesn't open on a wall of empty rows.
  const sorted = market && [...market.filter((m) => m.sellers.length), ...market.filter((m) => !m.sellers.length)];
  const query = q.trim().toLowerCase();
  const shown = sorted?.filter(
    (m) => !query || [m.title, m.blurb, m.id, ...m.sellers.flatMap((s) => [s.name, ...s.tags])].some((t) => t?.toLowerCase().includes(query)),
  );
  const quick = sorted?.filter((m) => m.sellers.length).slice(0, 8) ?? [];
  // On a laptop something is always picked, so the right side is never blank.
  const picked = shown?.find((m) => m.id === open) ?? (wide ? shown?.[0] : undefined);

  return (
    <>
      <div className="page market">
        <LargeTitle title="市场" sub="agent 和人都能买、都能卖" right={<Bell />} />

        <label className="search">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜服务或标签，比如 拍照、竞品、湖滨" aria-label="搜索服务" />
        </label>

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

        {!query && <ConnectNudge />}

        {!query && quick.length > 0 && (
          <nav className="card m-grid" aria-label="常用类目">
            {quick.map((m) => (
              <Link key={m.id} to={`/buy/${m.id}`}>
                <TypeTile type={m.id} size={44} />
                <span>{m.title.split("/")[0]}</span>
              </Link>
            ))}
          </nav>
        )}

        <div className="m-cols">
          <section className="card m-list">
            <h4><span>{query ? "搜索结果" : "全部类目"}</span><small>标签对得上、价格低、通过率高的卖家排前面</small></h4>
            {error && !market ? <Empty icon="market" title="加载失败">稍后自动重试</Empty> : null}
            {!market && !error && <Skeleton rows={6} />}
            {shown && shown.length === 0 && <Empty icon="market" title={`没有找到「${q.trim()}」`}>换个说法试试，或者看看全部类目</Empty>}
            {shown?.map((m) => {
              const online = m.sellers.filter((s) => s.online).length;
              const from = m.sellers[0]?.priceFen ?? null;
              const isOpen = wide ? picked?.id === m.id : open === m.id;
              return (
                <div className={`cap${isOpen ? " open" : ""}${m.sellers.length ? "" : " none"}`} key={m.id}>
                  <button className="cap-hd" type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen && !wide ? null : m.id)}>
                    <TypeTile type={m.id} size={44} />
                    <div className="tx">
                      <b>{m.title}</b>
                      <small>{m.blurb}</small>
                      <small className="meta"><span className={`dot${online ? " on" : ""}`} />{online} 位可接单 · 共 {m.sellers.length} 位卖家</small>
                    </div>
                    <span className="pr tnum">{from === null ? <small>暂无</small> : <><small className="y">¥</small>{yuan(from)}<small> 起</small></>}</span>
                  </button>
                  {isOpen && !wide && (
                    <div className="cap-body">
                      <Sellers m={m} />
                      {m.sellers.length > 0 && <Link className="btn" to={`/buy/${m.id}`}>下单</Link>}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
          {wide && market && <Detail m={picked} />}
        </div>
      </div>
      <TabBar />
    </>
  );
}
