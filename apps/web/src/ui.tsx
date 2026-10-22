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

// ---- chrome -----------------------------------------------------------

export function NavBar({ title, right, wide }: { title: string; right?: ReactNode; wide?: boolean }) {
  const navigate = useNavigate();
  return (
    <header className={`navbar${wide ? " wide" : ""}`}>
      <button type="button" aria-label="返回" onClick={() => (history.length > 1 ? navigate(-1) : navigate("/"))}>‹</button>
      <b>{title}</b>
      <span>{right}</span>
    </header>
  );
}

const icons = {
  market: <path d="M4 9.5L6 4h12l2 5.5M4 9.5h16M4 9.5V20h16V9.5M9 20v-5h6v5" />,
  orders: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" />,
  desk: <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4v5l3 2" />,
  me: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0" />,
};
function TabIcon({ name }: { name: keyof typeof icons }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {icons[name]}
    </svg>
  );
}

// The 订单 tab shows how many orders wait for the owner (to pay or to accept a delivery).
export function TabBar() {
  const { data: waiting } = usePoll(
    async () => (await hive.orders("buyer")).filter((o) => o.status === "AWAITING_PAYMENT" || o.status === "DELIVERED").length,
    15_000,
  );
  const badges: Partial<Record<keyof typeof icons, number>> = { orders: waiting ?? 0 };
  const tabs: Array<[keyof typeof icons, string, string]> = [
    ["market", "/", "市场"],
    ["orders", "/orders", "订单"],
    ["desk", "/desk", "接单"],
    ["me", "/me", "我的"],
  ];
  return (
    <nav className="tabbar">
      {tabs.map(([k, to, label]) => (
        <NavLink key={k} to={to} end={to === "/"}>
          <TabIcon name={k} />
          {label}
          {badges[k] ? <span className="badge">{badges[k]}</span> : null}
        </NavLink>
      ))}
    </nav>
  );
}

// The 消息 bell: unread notifications for this account, polled like the rest of the app.
export function Bell({ corner }: { corner?: boolean }) {
  const { data: unread } = usePoll(async () => (await hive.notifications()).filter((n) => !n.readAt).length, 5000);
  return (
    <Link to="/inbox" className={`bell${corner ? " corner" : ""}`} aria-label={unread ? `消息，${unread} 条未读` : "消息"}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" />
      </svg>
      {unread ? <span className="badge">{unread > 99 ? "99+" : unread}</span> : null}
    </Link>
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
