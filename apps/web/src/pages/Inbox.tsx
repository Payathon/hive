import { useNavigate } from "react-router";
import { hive, type Notice } from "../api.ts";
import { shortDate } from "../format.ts";
import { Empty, NavBar, Skeleton, usePoll } from "../ui.tsx";

// Same headlines the server uses for push and mail.
// Icon colour per kind: blue for news, orange when it waits on you, green done, red failed.
const TONE: Record<string, string> = { offer: "go", payment_required: "wait", paid: "go", delivered: "wait", failed: "bad", completed: "ok", cancelled: "mute" };
const GLYPH: Record<string, string> = { offer: "派", payment_required: "付", paid: "款", delivered: "验", failed: "败", completed: "成", cancelled: "取" };

const KIND: Record<string, string> = {
  offer: "新派单",
  payment_required: "待付款",
  paid: "买家已付款",
  delivered: "待验收",
  failed: "订单失败",
  completed: "订单完成",
  cancelled: "已取消",
};

// 消息: everything hive told this account, newest first. A tap marks it read and opens the order.
export function Inbox() {
  const navigate = useNavigate();
  const { data: notices, reload } = usePoll(() => hive.notifications(), 5000);
  const unread = notices?.filter((n) => !n.readAt).length ?? 0;

  function open(n: Notice) {
    if (!n.readAt) void hive.markRead(n.id).catch(() => {});
    if (n.orderId) navigate(`/orders/${n.orderId}`);
    else void reload();
  }
  async function readAll() {
    await hive.markAllRead().catch(() => {});
    await reload();
  }

  return (
    <div className="page narrow">
      <NavBar title="消息" wide right={unread ? <button className="link blue" type="button" style={{ fontSize: 13, whiteSpace: "nowrap" }} onClick={readAll}>全部已读</button> : null} />
      {!notices && <Skeleton rows={4} />}
      {notices && notices.length === 0 && <div className="card"><Empty icon="inbox" title="还没有消息">要你付款、验收或抢单时会在这里提醒你</Empty></div>}
      {notices && notices.length > 0 && (
        <div className="card list">
          {notices.map((n) => (
            <button key={n.id} type="button" className={`list-row notice${n.readAt ? "" : " unread"}`} onClick={() => open(n)}>
              <span className={`n-ic bg-${TONE[n.kind] ?? "go"}`} aria-hidden="true">{GLYPH[n.kind] ?? "单"}</span>
              <div className="tx">
                <b>{n.body}</b>
                <small>{KIND[n.kind] ?? "订单更新"} · {shortDate(n.createdAt)}</small>
              </div>
              {!n.readAt && <span className="dot unread-dot" aria-label="未读" />}
              <span className="chev" aria-hidden="true">›</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
