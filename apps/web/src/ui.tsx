import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router";
import { ApiError, errorMessage, hive, type Me } from "./api.ts";
import { typeIcon, type Step } from "./format.ts";

// ---- session ----------------------------------------------------------

interface Session {
  me: Me;
  refresh: () => Promise<void>;
  logout: () => void;
}
const SessionContext = createContext<Session | null>(null);
export const SessionProvider = SessionContext.Provider;
export function useSession() {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside a signed-in page");
  return s;
}

// ---- toast ------------------------------------------------------------

const ToastContext = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastHost({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 2600);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
    </ToastContext.Provider>
  );
}

// Runs an API action, toasting its error instead of throwing.
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      try {
        return await fn();
      } catch (err) {
        toast(errorMessage(err));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { busy, run };
}

// ---- data hooks -------------------------------------------------------

// Loads now and again every `ms` (0 = once). Keeps the last good value across reloads.
export function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void reload();
    if (!ms) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, ms);
    // Coming back to the tab (or the PWA) shows what changed while it was hidden.
    const onShow = () => document.visibilityState === "visible" && void reload();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ms, ...deps]);
  return { data, error, reload };
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export const isUnauthorized = (err: unknown) => err instanceof ApiError && err.status === 401;

// ---- layout -----------------------------------------------------------

// Laptop layout (left sidebar, wider columns) from this width up. Matches the 900px breakpoint in styles.css.
const WIDE = "(min-width: 900px)";
export function useWide() {
  const [wide, setWide] = useState(() => typeof matchMedia !== "undefined" && matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

// ---- chrome -----------------------------------------------------------

const Chevron = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 5l-7 7 7 7" />
  </svg>
);

// Detail pages: a centered-title bar with a back button on the phone, a left-aligned page title on a laptop.
export function NavBar({ title, right, wide }: { title: string; right?: ReactNode; wide?: boolean }) {
  const navigate = useNavigate();
  return (
    <header className={`navbar${wide ? " wide" : ""}`}>
      <button type="button" className="back" aria-label="返回" onClick={() => (history.length > 1 ? navigate(-1) : navigate("/"))}><Chevron /></button>
      <b>{title}</b>
      <span className="nav-r">{right}</span>
    </header>
  );
}

// Tab pages: an iOS large title that hands over to a small frosted bar once it scrolls away.
export function LargeTitle({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setCollapsed(!e!.isIntersecting), { rootMargin: "-44px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <header className="lt">
      <div className={`lt-bar${collapsed ? " show" : ""}`} aria-hidden="true"><b>{title}</b></div>
      <div className="lt-big">
        <div className="lt-tx">
          <h1 ref={ref}>{title}</h1>
          {sub && <p>{sub}</p>}
        </div>
        {right}
      </div>
    </header>
  );
}

const icons = {
  market: <path d="M4 9.5L6 4h12l2 5.5M4 9.5h16M4 9.5V20h16V9.5M9 20v-5h6v5" />,
  orders: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" />,
  desk: <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4v5l3 2" />,
  me: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0" />,
  inbox: <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" />,
};
function TabIcon({ name }: { name: keyof typeof icons }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {icons[name]}
    </svg>
  );
}

// Orders that wait for the owner (to pay or to accept a delivery), and unread notifications.
const useWaiting = () =>
  usePoll(async () => (await hive.orders("buyer")).filter((o) => o.status === "AWAITING_PAYMENT" || o.status === "DELIVERED").length, 15_000).data ?? 0;
const useUnread = () => usePoll(async () => (await hive.notifications()).filter((n) => !n.readAt).length, 5000).data ?? 0;
const badgeText = (n: number) => (n > 99 ? "99+" : String(n));

const TABS: Array<[keyof typeof icons, string, string]> = [
  ["market", "/", "市场"],
  ["orders", "/orders", "订单"],
  ["desk", "/desk", "接单"],
  ["me", "/me", "我的"],
];

// Phone: the four bottom tabs. On a laptop the sidebar replaces them.
export function TabBar() {
  const wide = useWide();
  return wide ? null : <PhoneTabs />;
}
function PhoneTabs() {
  const waiting = useWaiting();
  return (
    <nav className="tabbar" aria-label="主导航">
      {TABS.map(([k, to, label]) => (
        <NavLink key={k} to={to} end={to === "/"}>
          <TabIcon name={k} />
          {label}
          {k === "orders" && waiting ? <span className="badge">{badgeText(waiting)}</span> : null}
        </NavLink>
      ))}
    </nav>
  );
}

// Laptop: a fixed left sidebar with the same four places plus 消息.
export function SideNav() {
  const { me } = useSession();
  const waiting = useWaiting();
  const unread = useUnread();
  const items: Array<[keyof typeof icons, string, string, number]> = [
    ...TABS.map(([k, to, label]) => [k, to, label, k === "orders" ? waiting : 0] as [keyof typeof icons, string, string, number]),
    ["inbox", "/inbox", "消息", unread],
  ];
  return (
    <nav className="sidenav" aria-label="主导航">
      <Link to="/" className="brand"><Logo size={32} /><b>hive</b></Link>
      <div className="side-items">
        {items.map(([k, to, label, n]) => (
          <NavLink key={k} to={to} end={to === "/"}>
            <TabIcon name={k} />
            <span>{label}</span>
            {n ? <span className="badge">{badgeText(n)}</span> : null}
          </NavLink>
        ))}
      </div>
      <Link to="/me" className="side-me">
        <span className="av">{me.name.slice(0, 1)}</span>
        <span className="tx"><b>{me.name}</b><small>每笔付款都由你确认</small></span>
      </Link>
    </nav>
  );
}

export function Logo({ size = 56 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" rx="112" fill="#1677ff" />
      <path d="M256 112l124 72v144l-124 72-124-72V184z" fill="none" stroke="#fff" strokeWidth="36" strokeLinejoin="round" />
    </svg>
  );
}

// The 消息 bell on phone headers. On a laptop 消息 lives in the sidebar.
export function Bell() {
  const wide = useWide();
  return wide ? null : <PhoneBell />;
}
function PhoneBell() {
  const unread = useUnread();
  return (
    <Link to="/inbox" className="bell" aria-label={unread ? `消息，${unread} 条未读` : "消息"}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {icons.inbox}
      </svg>
      {unread ? <span className="badge">{badgeText(unread)}</span> : null}
    </Link>
  );
}

// ---- states -----------------------------------------------------------

export function Skeleton({ rows = 3, head }: { rows?: number; head?: boolean }) {
  return (
    <div className="card skel-card" aria-busy="true" aria-label="加载中">
      {head && <i className="skel" style={{ width: "40%", height: 16, marginBottom: 14 }} />}
      {Array.from({ length: rows }, (_, i) => (
        <div className="skel-row" key={i}>
          <i className="skel" style={{ width: 40, height: 40, borderRadius: 10 }} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
            <i className="skel" style={{ width: `${55 + ((i * 17) % 30)}%`, height: 14 }} />
            <i className="skel" style={{ width: `${35 + ((i * 23) % 30)}%`, height: 11 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Empty({ icon = "orders", title, children }: { icon?: keyof typeof icons; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-ic"><TabIcon name={icon} /></span>
      <b>{title}</b>
      {children && <div className="empty-sub">{children}</div>}
    </div>
  );
}

export function AgentIcon({ small }: { small?: boolean }) {
  const s = small ? 13 : 16;
  return (
    <span className={`agent-ic${small ? " sm" : ""}`} aria-hidden="true">
      <svg width={s} height={s} viewBox="0 0 16 16">
        <rect x="2" y="4" width="12" height="9" rx="3" fill="#fff" />
        <circle cx="6" cy="8.5" r="1.1" fill="#1677ff" />
        <circle cx="10" cy="8.5" r="1.1" fill="#1677ff" />
        <path d="M8 1.5v2.5" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function TypeTile({ type, size = 44 }: { type: string; size?: number }) {
  const ic = typeIcon(type);
  return (
    <span className="type-tile" style={{ background: ic.color, width: size, height: size, fontSize: size < 40 ? 12 : 13 }}>
      {ic.label}
    </span>
  );
}

export function Timeline({ steps }: { steps: Step[] }) {
  return (
    <ol className="tl">
      {steps.map((s, i) => (
        <li key={i} className={s.state}>
          <span className="d" />
          <div>
            {s.label}
            {s.note && <small>{s.note}</small>}
          </div>
          <span className="t tnum">{s.at ? new Date(s.at).toTimeString().slice(0, 5) : ""}</span>
        </li>
      ))}
    </ol>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch${on ? " on" : ""}`} disabled={disabled} onClick={() => onChange(!on)} />
  );
}
