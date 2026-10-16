import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { hive } from "../api.ts";
import { typeTitle, yuan } from "../format.ts";
import { NavBar, TypeTile, useAction, usePoll, useToast } from "../ui.tsx";

const splitList = (s: string) => s.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);

// Hand-written forms for the platform's capability types; inputs are validated again on the server.
function useForm(type: string) {
  const [v, setV] = useState<Record<string, string>>(() =>
    type === "market-data.competitors"
      ? { city: "杭州", areas: "", category: "奶茶" }
      : type === "photo.onsite"
        ? { location: "", subject: "", count: "3" }
        : { title: "", data: '[\n  { "商圈": "湖滨", "门店数": 12 },\n  { "商圈": "武林", "门店数": 8 }\n]', instructions: "" },
  );
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const field = (k: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, hint?: string) => (
    <div className="field" key={k}>
      <label htmlFor={k}>{label}</label>
      <input id={k} value={v[k] ?? ""} onChange={set(k)} {...props} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );

  let fields: React.ReactNode;
  let toInput: () => unknown;
  if (type === "market-data.competitors") {
    fields = [
      field("city", "城市", { required: true }),
      field("areas", "商圈", { required: true, placeholder: "湖滨 武林 滨江" }, "多个商圈用空格或逗号隔开"),
      field("category", "品类", { required: true }),
    ];
    toInput = () => ({ city: v.city?.trim(), areas: splitList(v.areas ?? ""), category: v.category?.trim() });
  } else if (type === "photo.onsite") {
    fields = [
      field("location", "地点", { required: true, placeholder: "例如 杭州湖滨银泰 in77" }),
      field("subject", "拍什么", { required: true, placeholder: "例如 奶茶店门头和排队情况" }),
      field("count", "张数", { required: true, type: "number", min: 1, max: 20, inputMode: "numeric" }),
    ];
    toInput = () => ({ location: v.location?.trim(), subject: v.subject?.trim(), count: Number(v.count) });
  } else {
    fields = [
      field("title", "图表标题", { required: true }),
      <div className="field" key="data">
        <label htmlFor="data">数据（JSON 数组）</label>
        <textarea id="data" value={v.data ?? ""} onChange={set("data")} required />
      </div>,
      field("instructions", "补充说明（可不填）"),
    ];
    toInput = () => {
      let data: unknown;
      try {
        data = JSON.parse(v.data ?? "");
      } catch {
        throw new Error("数据不是合法的 JSON");
      }
      return { title: v.title?.trim(), data, ...(v.instructions?.trim() ? { instructions: v.instructions.trim() } : {}) };
    };
  }
  return { fields, toInput };
}

export function Buy() {
  const { type = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { busy, run } = useAction();
  const { fields, toInput } = useForm(type);
  const { data: market } = usePoll(() => hive.market(), 0);
  const sellers = market?.find((m) => m.type === type)?.sellers ?? [];
  const online = sellers.filter((s) => s.online);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    let input: unknown;
    try {
      input = toInput();
    } catch (err) {
      return toast((err as Error).message);
    }
    const order = await run(() => hive.createOrder(type, input));
    if (order) navigate(`/orders/${order.id}`, { replace: true });
  }

  return (
    <form className="page" onSubmit={submit}>
      <NavBar title="下单" />
      <div className="bill-head">
        <TypeTile type={type} />
        <div className="name">{typeTitle(type)}</div>
        <div className="status tone-go">
          {online.length ? `${online.length} 位卖家在线` : "暂时没有卖家在线"}
          <small>{sellers[0] ? `¥${yuan(sellers[0].priceFen)} 起，接单后按卖家标价付款` : "现在下单会因为没人接而自动取消，不会扣款"}</small>
        </div>
      </div>
      <div className="card">{fields}</div>
      <p className="section-title">下单后 hive 会派给在线卖家。卖家接单后你再付款，钱直接到卖家的支付宝。</p>
      <div className="actionbar">
        <button className="btn" type="submit" disabled={busy}>下单</button>
      </div>
    </form>
  );
}
