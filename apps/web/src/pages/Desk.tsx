import { TIMEOUTS, workStyle } from "@hive/core";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, hive, type Listing, type OrderSummary } from "../api.ts";
import { allCategories, category as categoryOf, mmss, specText, STATUS_LABEL, typeTitle, yuan } from "../format.ts";
import { AgentIcon, Bell, TabBar, TypeTile, useAction, useNow, usePoll, useSession, useToast } from "../ui.tsx";

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

const offerWhere = (o: OrderSummary) => `${o.brief.length > 60 ? `${o.brief.slice(0, 60)}…` : o.brief} · 交付：${specText(o.deliverySpec)}`;

const splitTags = (s: string) => [...new Set(s.split(/[,，、\s#]+/).map((x) => x.trim()).filter(Boolean))].slice(0, 10);

// Long-polls like `hive serve` does, which also keeps this seller online. Only while the page is open.
function useInbox(online: boolean) {
  const [inbox, setInbox] = useState<{ offers: OrderSummary[]; work: OrderSummary[] }>({ offers: [], work: [] });
  useEffect(() => {
    if (!online) return;
    const ctl = new AbortController();
    (async () => {
      while (!ctl.signal.aborted) {
        try {
          const r = await hive.poll(20, ctl.signal);
          setInbox(r);
          // The poll returns at once while anything is pending; don't spin on it.
          if (r.offers.length || r.work.length) await sleep(3000, ctl.signal);
        } catch {
          await sleep(3000, ctl.signal);
        }
      }
    })();
    return () => ctl.abort();
  }, [online]);
  return online ? inbox : { offers: [], work: [] };
}

function OfferSheet({ offer, priceFen, onGrab, onSkip, busy }: { offer: OrderSummary; priceFen: number | null; onGrab: () => void; onSkip: () => void; busy: boolean }) {
  const now = useNow(500);
  const total = TIMEOUTS.offer.human;
  const left = offer.deadline ? new Date(offer.deadline).getTime() - now : 0;
  const L = 2 * Math.PI * 26;
  return (
    <div className="sheet-bg">
      <div className="sheet" role="dialog" aria-label="新派单">
        <div className="sheet-hd"><b>新派单 · 同时派给几位卖家，先抢先得</b></div>
        <div className="offer">
          <div className="tx">
            <div className="nm">{typeTitle(offer.category)}</div>
            <div className="where">{offerWhere(offer)}</div>
            <div className="amt tnum"><small>¥</small>{yuan(priceFen)}</div>
          </div>
          <svg width="64" height="64" viewBox="0 0 64 64" aria-label={`剩余 ${mmss(left)}`}>
            <circle cx="32" cy="32" r="26" fill="none" stroke="#f0f0f0" strokeWidth="5" />
            <circle cx="32" cy="32" r="26" fill="none" stroke={left < 2 * 60_000 ? "#ff4d2d" : "#1677ff"} strokeWidth="5" strokeLinecap="round"
              strokeDasharray={L} strokeDashoffset={L * (1 - Math.max(0, left) / total)} transform="rotate(-90 32 32)" />
            <text x="32" y="37" textAnchor="middle" fontSize="13" fontWeight="600" fill="#1a1a1a">{mmss(left)}</text>
          </svg>
        </div>
        {offer.createdByActor === "agent" && (
          <div className="inline-note"><AgentIcon small />这单由买家的 agent 发起，付款由买家本人确认</div>
        )}
        <button className="btn" type="button" disabled={busy} onClick={onGrab}>抢单</button>
        <button className="link" type="button" disabled={busy} onClick={onSkip}>不接这单</button>
      </div>
    </div>
  );
}

function Listings({ listings, reload }: { listings: Listing[] | null; reload: () => Promise<void> }) {
  const { busy, run } = useAction();
  const toast = useToast();
  const listed = new Set(listings?.map((l) => l.category));
  const unlisted = allCategories().filter((c) => !listed.has(c.id)).map((c) => c.id);
  const [type, setType] = useState("");
  const [limit, setLimit] = useState("5");
  const [accept, setAccept] = useState<"ask" | "auto">("ask");
  const [hours, setHours] = useState("");
  const [tags, setTags] = useState("");
  const [intro, setIntro] = useState("");
  const chosen = categoryOf(type || unlisted[0] || "");
  const usualHours = chosen ? Math.ceil(chosen.manualTimeoutMs / 3600_000) : 24;

  async function setup(t: string) {
    const r = await run(() => hive.paymentSetup(t));
    if (!r) return;
    if (r.status === "ENABLED") toast(`已开通收款，标价 ¥${yuan(r.priceFen)}`);
    else if (r.configurationUrl) window.open(r.configurationUrl, "_blank", "noopener");
    await reload();
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    const t = type || unlisted[0];
    if (!t) return;
    const opts = { acceptMode: accept, deliveryHours: Number(hours) || usualHours, dailyLimit: Number(limit), tags: splitTags(tags), intro: intro.trim() || null };
    if (!(await run(() => hive.upsertListing(t, opts)))) return;
    await setup(t);
    setType("");
    setTags("");
    setIntro("");
    setHours("");
  }

  return (
    <div className="card">
      <h4><span>我能接的活</span><small>价格在支付宝收款页里设置</small></h4>
      {listings?.map((l) => (
        <div className="list-row" key={l.id}>
          <TypeTile type={l.category} size={32} />
          <div className="tx">
            <b>{typeTitle(l.category)}</b>
            <span className="tag person">{workStyle(l)}</span>
            <small>每天最多 {l.dailyLimit} 单{l.tags.length ? ` · ${l.tags.map((t) => `#${t}`).join(" ")}` : ""}</small>
          </div>
          <div className="r">
            {l.paymentStatus === "ENABLED" ? (
              <b className="tnum">¥{yuan(l.priceFen)}</b>
            ) : (
              <button className="btn sm" type="button" disabled={busy} onClick={() => setup(l.category)}>设置收款</button>
            )}
          </div>
        </div>
      ))}
      {unlisted.length > 0 && (
        <form className="list-row" onSubmit={add} style={{ flexWrap: "wrap" }}>
          <select aria-label="类目" value={type || unlisted[0]} onChange={(e) => setType(e.target.value)} style={{ flex: 1, minWidth: 0, border: 0, background: "var(--bg)", borderRadius: 8, padding: "8px 10px" }}>
            {unlisted.map((t) => <option key={t} value={t}>{typeTitle(t)}</option>)}
          </select>
          <input aria-label="每天上限" type="number" min={1} max={100} value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 64, border: 0, background: "var(--bg)", borderRadius: 8, padding: "8px 10px" }} />
          <button className="btn sm" type="submit" disabled={busy}>上架</button>
          <div style={{ display: "flex", gap: 8, width: "100%", marginTop: 8, alignItems: "center", fontSize: 13 }}>
            <select aria-label="接单方式" value={accept} onChange={(e) => setAccept(e.target.value as "ask" | "auto")} style={{ flex: 1, border: 0, background: "var(--bg)", borderRadius: 8, padding: "8px 10px" }}>
              <option value="ask">每单我来审批</option>
              <option value="auto">自动接单</option>
            </select>
            <input aria-label="几小时内交付" type="number" min={1} max={720} value={hours} placeholder={String(usualHours)} onChange={(e) => setHours(e.target.value)} style={{ width: 56, border: 0, background: "var(--bg)", borderRadius: 8, padding: "8px 10px" }} />
            <span>小时内交付</span>
          </div>
          <input aria-label="标签" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={`标签，空格隔开，例如 ${(chosen?.tags ?? []).slice(0, 3).join(" ") || "湖滨 门头"}`} style={{ width: "100%", marginTop: 8, border: 0, background: "var(--bg)", borderRadius: 8, padding: "8px 10px", fontSize: 13 }} />
          <input aria-label="一句介绍" value={intro} maxLength={200} onChange={(e) => setIntro(e.target.value)} placeholder="一句介绍，买家在市场里能看到" style={{ width: "100%", marginTop: 8, border: 0, background: "var(--bg)", borderRadius: 8, padding: "8px 10px", fontSize: 13 }} />
        </form>
      )}
    </div>
  );
}

export function Desk() {
  const { me, refresh } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const { busy, run } = useAction();
  const [online, setOnline] = useState(me.humanAccepting);
  const [since] = useState(() => Date.now());
  const now = useNow(30_000);
  const inbox = useInbox(online);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const offer = inbox.offers.find((o) => !skipped.has(o.id));
  const { data: bill } = usePoll(() => hive.bill(), 15_000);
  const { data: listings, reload: reloadListings } = usePoll(() => hive.listings(), 0);
  const canAccept = listings?.some((l) => l.paymentStatus === "ENABLED") ?? false;

  // Buzz once per new offer.
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (offer && seen.current !== offer.id) {
      seen.current = offer.id;
      navigator.vibrate?.([200, 100, 200]);
    }
  }, [offer]);

  const today = new Date().toDateString();
  const earnedToday = bill?.earned.filter((e) => e.paidAt && new Date(e.paidAt).toDateString() === today) ?? [];

  async function toggle() {
    const next = !online;
    if (!(await run(() => hive.setAccepting(next)))) return;
    setOnline(next);
    void refresh();
  }
  async function grab(o: OrderSummary) {
    try {
      await hive.action(o.id, "accept-offer");
      navigate(`/orders/${o.id}`);
    } catch (err) {
      toast(err instanceof ApiError && err.status === 409 ? "慢了一步，这单已经被别人接了" : String((err as Error).message));
      setSkipped(new Set(skipped).add(o.id));
    }
  }
  async function skip(o: OrderSummary) {
    setSkipped(new Set(skipped).add(o.id));
    await run(() => hive.action(o.id, "decline-offer"));
  }

  const minutes = Math.floor((now - since) / 60_000);
  return (
    <>
      <div className="page">
        <div className="desk-head" style={{ paddingTop: "calc(16px + env(safe-area-inset-top, 0px))" }}>
          <Bell corner />
          <button className={`desk-toggle${online ? " on" : ""}`} type="button" onClick={toggle} disabled={busy || (!online && !canAccept)}>
            <span>{online ? "接单中" : "开始接单"}<small>{online ? `已开 ${minutes} 分钟 · 关掉页面也在接` : "像出车一样上线"}</small></span>
          </button>
          <div className="desk-state">
            {!canAccept ? "先在下面上架一个能力并设置收款" : online ? <><b>正在接单</b> · 要你审批的派单在这里弹出，自动接的单直接进「进行中」</> : "已暂停，不会收到派单"}
          </div>
        </div>

        <div className="card stats">
          <div><b className="tnum">{yuan(earnedToday.reduce((n, e) => n + (e.priceFen ?? 0), 0))}</b><span>今日收入（元）</span></div>
          <div><b className="tnum">{earnedToday.length}</b><span>今日成交</span></div>
          <div><b className="tnum">{yuan(bill?.earnedFen ?? 0)}</b><span>累计收入（元）</span></div>
        </div>

        {inbox.work.length > 0 && (
          <div className="card">
            <h4>进行中</h4>
            {inbox.work.map((o) => (
              <Link className="list-row" key={o.id} to={`/orders/${o.id}`}>
                <TypeTile type={o.category} size={32} />
                <div className="tx"><b>{typeTitle(o.category)}</b><small>{offerWhere(o)}</small></div>
                <div className="r"><b className="tnum">¥{yuan(o.priceFen)}</b><small className="tone-go">{o.status === "PAID" ? "可以开始了" : STATUS_LABEL[o.status]}</small></div>
              </Link>
            ))}
          </div>
        )}

        <Listings listings={listings} reload={reloadListings} />
      </div>
      <TabBar />
      {offer && <OfferSheet offer={offer} priceFen={listings?.find((l) => l.category === offer.category)?.priceFen ?? null} busy={busy} onGrab={() => grab(offer)} onSkip={() => skip(offer)} />}
    </>
  );
}
