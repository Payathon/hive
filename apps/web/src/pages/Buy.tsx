import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { hive, type DeliverySpec } from "../api.ts";
import { typeTitle, yuan } from "../format.ts";
import { AgentIcon, NavBar, TypeTile, useAction, usePoll, useToast, useWide } from "../ui.tsx";

type Kind = DeliverySpec["kind"];

// Offline jobs come back as photos, edits as a video; everything else defaults to "anything".
const DEFAULT_FILES: Record<string, { accept: string; count: number }> = {
  "onsite.photo": { accept: "image/*", count: 3 },
  "media.video": { accept: "video/*", count: 1 },
  "media.audio": { accept: "audio/*", count: 1 },
  "design.image": { accept: "image/*", count: 1 },
  "design.chart": { accept: "image/*", count: 1 },
};

const parseJson = (s: string, what: string) => {
  try {
    return JSON.parse(s);
  } catch {
    throw new Error(`${what}不是合法的 JSON`);
  }
};

export function Buy() {
  const { category = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { busy, run } = useAction();
  const wide = useWide();
  const { data: market } = usePoll(() => hive.categories(), 0);
  const sellers = market?.find((m) => m.id === category)?.sellers ?? [];
  const online = sellers.filter((s) => s.online);

  const preset = DEFAULT_FILES[category];
  const [brief, setBrief] = useState("");
  const [kind, setKind] = useState<Kind>(preset ? "files" : "any");
  const [accept, setAccept] = useState(preset?.accept ?? "");
  const [count, setCount] = useState(String(preset?.count ?? 1));
  const [schema, setSchema] = useState('{\n  "type": "object",\n  "required": ["items"],\n  "properties": { "items": { "type": "array", "minItems": 1 } }\n}');
  const [extra, setExtra] = useState("");

  function delivery(): DeliverySpec {
    if (kind === "json") return { kind, schema: parseJson(schema, "交付格式") };
    if (kind === "files") return { kind, ...(accept ? { accept } : {}), count: Math.max(1, Number(count) || 1) };
    return { kind: "any" };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    let order;
    try {
      order = { category, brief: brief.trim(), delivery: delivery(), ...(extra.trim() ? { input: parseJson(extra, "附加数据") } : {}) };
    } catch (err) {
      return toast((err as Error).message);
    }
    const created = await run(() => hive.createOrder(order));
    if (created) navigate(`/orders/${created.id}`, { replace: true });
  }

  const head = (
    <div className="bill-head">
      <TypeTile type={category} size={48} />
      <div className="name">{typeTitle(category)}</div>
      <div className="amt tnum">{sellers[0] ? <><small>¥</small>{yuan(sellers[0].priceFen)}<small className="qi"> 起</small></> : "—"}</div>
      <div className={`status ${online.length ? "tone-go" : "tone-mute"}`}>
        {online.length ? `${online.length} 位卖家可接单` : "暂时没有卖家接单"}
        <small>{sellers[0] ? "接单后按卖家标价付款" : "现在下单会因为没人接而自动取消，不会扣款"}</small>
      </div>
    </div>
  );

  const form = (
    <div className="card">
      <h4>说说你要什么</h4>
      <div className="field">
        <label htmlFor="brief">要做什么</label>
        <textarea id="brief" className="prose" value={brief} onChange={(e) => setBrief(e.target.value)} required maxLength={4000}
          placeholder="说清楚要什么、在哪里、有什么要求。卖家的标签会和这段话匹配" />
      </div>
      <div className="field">
        <label htmlFor="kind">交付成什么样</label>
        <select id="kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="any">不限，我看了再验收</option>
          <option value="files">文件（照片、视频、文档…）</option>
          <option value="json">JSON 数据，按我给的格式校验</option>
        </select>
        {kind === "files" && (
          <div className="field-row">
            <select aria-label="文件类型" value={accept} onChange={(e) => setAccept(e.target.value)}>
              <option value="">任意文件</option>
              <option value="image/*">图片</option>
              <option value="video/*">视频</option>
              <option value="audio/*">音频</option>
              <option value="application/pdf">PDF</option>
            </select>
            <span className="stepper">
              <span>至少</span>
              <input aria-label="至少几个" type="number" min={1} max={50} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
              <span>个</span>
            </span>
          </div>
        )}
        {kind === "json" && (
          <>
            <textarea aria-label="JSON Schema" value={schema} onChange={(e) => setSchema(e.target.value)} />
            <span className="hint">JSON Schema。交付的数据不符合就退回卖家重交</span>
          </>
        )}
        {kind !== "json" && <span className="hint">hive 只检查{kind === "files" ? "文件类型和数量" : "交付不是空的"}，好不好由你验收</span>}
      </div>
      <div className="field">
        <label htmlFor="extra">附加数据（JSON，可不填）</label>
        <textarea id="extra" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder='例如要画成图的数据：[{ "商圈": "湖滨", "门店数": 12 }]' />
      </div>
    </div>
  );

  const how = (
    <div className="card how">
      <h4>下单之后</h4>
      <ol className="steps">
        <li><b>派单</b>hive 派给在线卖家，先抢先得</li>
        <li><b>付款</b>卖家接单后，你在支付宝确认，钱直接到卖家</li>
        <li><b>验收</b>卖家交付，你看过没问题再确认收货</li>
      </ol>
    </div>
  );

  if (!wide) {
    return (
      <form className="page buy" onSubmit={submit}>
        <NavBar title="下单" />
        {head}
        {form}
        <p className="section-title">下单后 hive 会派给在线卖家。卖家接单后你再付款，钱直接到卖家的支付宝。</p>
        <div className="actionbar">
          <button className="btn" type="submit" disabled={busy}>下单</button>
        </div>
      </form>
    );
  }
  return (
    <form className="page buy" onSubmit={submit}>
      <NavBar title="下单" />
      <div className="cols">
        <div className="col main-col">{form}</div>
        <div className="col side-col">
          <div className="card head-card">
            {head}
            <button className="btn" type="submit" disabled={busy}>下单</button>
            <p className="side-note"><AgentIcon small />你的 agent 也能用 hive 帮你下同样的单</p>
          </div>
          {how}
        </div>
      </div>
    </form>
  );
}
