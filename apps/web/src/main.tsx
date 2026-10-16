import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { getToken, hive, setToken, type Me } from "./api.ts";
import { Approve } from "./pages/Approve.tsx";
import { Buy } from "./pages/Buy.tsx";
import { Desk } from "./pages/Desk.tsx";
import { Market } from "./pages/Market.tsx";
import { MePage } from "./pages/Me.tsx";
import { OrderPage } from "./pages/Order.tsx";
import { Orders } from "./pages/Orders.tsx";
import { Welcome } from "./pages/Welcome.tsx";
import { isUnauthorized, SessionProvider, ToastHost } from "./ui.tsx";
import "./styles.css";

// Everything except /welcome needs the owner's token; without one, go sign up and come back.
function SignedIn() {
  const location = useLocation();
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState(false);
  const hasToken = getToken() !== null;

  const refresh = useCallback(async () => {
    try {
      const m = await hive.me();
      if (m.actor !== "human") {
        // An agent token works for the API but the web is for the owner.
        setToken(null);
        navigate("/welcome", { replace: true });
        return;
      }
      setMe(m);
    } catch (err) {
      if (isUnauthorized(err)) {
        setToken(null);
        navigate("/welcome", { replace: true });
      } else setFailed(true);
    }
  }, [navigate]);

  useEffect(() => {
    if (hasToken) void refresh();
  }, [hasToken, refresh]);

  if (!hasToken) return <Navigate to={`/welcome?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (failed) return <div className="empty">连不上 hive 服务，请稍后刷新</div>;
  if (!me) return <div className="empty">加载中…</div>;

  const logout = () => {
    setToken(null);
    navigate("/welcome", { replace: true });
  };
  return (
    <SessionProvider value={{ me, refresh, logout }}>
      <Routes>
        <Route path="/" element={<Market />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/:id" element={<OrderPage />} />
        <Route path="/buy/:type" element={<Buy />} />
        <Route path="/desk" element={<Desk />} />
        <Route path="/me" element={<MePage />} />
        <Route path="/approve" element={<Approve />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SessionProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastHost>
        <div className="app">
          <Routes>
            <Route path="/welcome" element={<Welcome />} />
            <Route path="/*" element={<SignedIn />} />
          </Routes>
        </div>
      </ToastHost>
    </BrowserRouter>
  </StrictMode>,
);
