# 卖家侧竞品调研：自动交付、人工介入、线下任务

> 调研时间：2026-10-21。对应 `docs/design.md` §10「卖家侧 agent 形态」待定项。来源以官方文档为主，二手报道会注明。

## 一句话结论

没有一家同时把三类卖家放在一个市场里：agent 市场（Virtuals ACP、Fetch.ai、扣子）只管全自动交付，众包/跑腿平台（MTurk、RentAHuman、UU 跑腿、美团众包）只管人干活。唯一把"AI 即时交付"和"人工定制"放在同一个卖家页面上的是 Fiverr Go，选哪种由**买家在下单时**决定。卖家接入方式大家基本一致：卖家在本地或自己的云上常驻一个监听进程，跟 hive 的 `hive serve` 是一个模式。几家差得最远的是验收：有的超时自动通过（MTurk），有的超时转人工仲裁（RentAHuman），有的交给第三方 evaluator（ACP）。

---

## 1. Virtuals ACP（Agent Commerce Protocol）：agent 对 agent 的托管交易

**是什么**：Virtuals 的链上 agent 商业协议（EIP/ERC-8183），分四个阶段：Request、Negotiation、Transaction、Evaluation，参与方有 Client、Provider、Evaluator 三种角色，钱和交付物都由托管合约暂存（[Virtuals Commerce Layer](https://whitepaper.virtuals.io/about-virtuals/commerce-layer)、[Technical Deep Dive](https://whitepaper.virtuals.io/about-virtuals/commerce-layer/technical-deep-dive)）。Virtuals 自报截至 2026 年 2 月完成 177 万单，但外界无法核实其中有多少是真实需求（[Forkast, 2026-07](https://forkast.news/the-machine-as-buyer-virtuals-acp-and-the-evaluator-problem/)）。

- **注册与运行位置**：卖家用 `acp sell init` 生成 `offering.json` 和 `handlers.ts`，再用 `acp sell create` 上架；然后执行 `acp serve start` 在本地起一个 WebSocket 监听器，也可以用 `acp serve deploy railway` 部署到云上。官方原话是不需要手动触发任何步骤，也不需要轮询（[openclaw-acp skill](https://skills.cat/skills/virtual-protocol/openclaw-acp)）。和 `hive serve` + 种子 agent 部署在服务器上基本是同一套设计。
- **自动 / 人工**：协议默认全自动，由 handler 接单、报价、交付，文档里没有人工介入这一档。卖家通过报价（set budget）来表示接单，买家付钱进托管后卖家才开工（[Provider workflow](https://os.virtuals.io/acp/cli/provider-workflow)）。
- **派单**：没有派单，买家自己挑卖家（Butler 等导购 agent 帮买家选）。
- **验收与纠纷**：状态依次是 Open → Budget set → Funded → Submitted → Completed / Rejected / Expired。Evaluator 是可选角色，不指定时由买家自己验收；通过就放款给卖家，拒绝就退款给买家。分成是不带 evaluator 时 95/5，带 evaluator 时 90/5/5（[ACP concepts](https://os.virtuals.io/acp/concepts)）。Forkast 的批评是"信誉只和 evaluator 一样可靠"，而 evaluator 本身也有刷量的动机。

## 2. Fetch.ai Agentverse：托管、本地、mailbox 三种运行方式

**是什么**：Fetch.ai 的 agent 注册、发现和托管平台，agent 之间用 uAgents 协议通信。

- **注册与运行位置**：官方把 agent 分成四种（[uAgents agent types](https://uagents.fetch.ai/docs/guides/types)）：
  - **Hosted**：跑在 Agentverse 云上，每次调用后全局变量会重置，状态要存进 Agent Storage。
  - **Local**：跑在开发者自己的机器上，环境完全自控，但离线时别人联系不上。
  - **Mailbox**：本地 agent 加上平台信箱，离线期间消息先存在信箱里，上线后再取。
  - **Proxy**：需要公网地址。
- **自动 / 人工**：协议层面全自动，没有人工介入的概念。
- **付款**：有一个 AgentPaymentProtocol，流程是卖方 RequestPayment，买方回 CommitPayment 或 RejectPayment，卖方再回 CompletePayment 或 CancelPayment（[Agent payment protocol](https://uagents.fetch.ai/docs/guides/agent-payment-protocol)）。这里也是**先谈好、卖方发起收款、买方确认**，和 hive"接单后生成付款入口"的顺序一致。
- **派单 / 验收 / 纠纷**：没有平台派单，由 ASI:One 或买家按目录检索；也没有平台级的验收和仲裁。

## 3. 扣子（Coze）技能商店：平台托管的付费技能

**是什么**：字节的 agent 平台。扣子 2.0（2026 年 1 月）上线了技能商店，开发者可以把技能设为付费上架（[腾讯新闻测评, 2026-01](https://news.qq.com/rain/a/20260127A03U3400)、[扣子技能商店文档](https://docs.coze.cn/cozespace_skills_store)）。

- **注册与运行位置**：技能只能在扣子自己的 agent 和云端 agent 里用，**不支持本地 agent**（[扣子技能商店文档](https://docs.coze.cn/cozespace_skills_store)）。也就是说，执行环境完全由平台托管。
- **自动 / 人工**：全自动，卖的是能力本身，没有"卖家接单"这一步。
- **派单 / 验收 / 纠纷**：没有派单，也没有逐单验收。付费技能按月购买（部分精品数据集按次计费），上架前要经过人工审核，测评文章说大约 5 个工作日（[扣子技能商店文档](https://docs.coze.cn/cozespace_skills_store)、[腾讯新闻](https://news.qq.com/rain/a/20260127A03U3400)）。36 氪报道称目前只有扣子支持 Skill 交易，腾讯、阿里的技能商店基本是免费分发（[36氪](https://36kr.com/p/3837292043484033)，二手）。
- **对 hive 的意义**：扣子代表"API 商店"路线，hive 在设计里已经否掉了这条路（"纯能力目录只是 API 商店"）。hive 的差异在于卖家的本地环境和资源，而这恰好是扣子明确不支持的。

## 4. Fiverr Go：同一个卖家页面，既有 AI 即时交付，也有人工定制

**是什么**：Fiverr 2025 年 2 月推出，卖家用自己的历史作品训练一个"Personal AI Creation Model"（每月 25 美元），买家可以直接用它生成作品、付费下载（[TechCrunch](https://techcrunch.com/2025/02/18/fiverr-wants-gig-workers-to-offload-some-of-their-work-to-ai)）。在 Fiverr 的路线图里，Fiverr Go 是卖家侧的 agent，买家侧另有一个撮合 agent Neo（[Fiverr 股东信](https://investors.fiverr.com/static-files/d74377ac-7022-4e15-acbe-e275b425ec5d)）。

- **注册与运行位置**：模型托管在 Fiverr 平台上，卖家随时可以关掉。
- **自动 / 人工由谁定**：**买家定**。买家可以选卖家模型的即时产出、选人工制作，或者两者结合；也可以在 AI 产出的基础上让卖家再改一版，或者另提定制需求（[TechCrunch](https://techcrunch.com/2025/02/18/fiverr-wants-gig-workers-to-offload-some-of-their-work-to-ai)）。AI 档是即时付费下载，人工档走原来的订单流程。
- **派单 / 验收 / 纠纷**：沿用 Fiverr 原有的订单、修改和客服仲裁。Upwork 走的是另一条路：Uma 帮雇主筛人、面试、起草合同，平台上卖的还是人的劳动（[Upwork Spring 2026](https://investors.upwork.com/news-releases/news-release-details/upwork-updates-spring-2026-ai-powered-innovations-help-small)）。

## 5. RentAHuman.ai：agent 雇人做线下任务（2026 年最直接的对标）

**是什么**：2026 年 2 月上线，agent 通过 MCP 或 REST API 发悬赏、雇人做线下任务，比如取件、到场、拍照核验（[arXiv 2602.19514](https://arxiv.org/html/2602.19514v1)）。同类还有 Hire a Human：agent 也要先过 Veriff 实名认证，平台抽成 10%（[hire-a-human.ai](https://hire-a-human.ai/)）。

- **注册与接入**：人在网页上建档，填写地点、技能和价格。agent 用邮箱验证码注册拿到 API key。**agent 的 key 不能替人申请任务、改资料**，这些只能在人自己登录的账号里做（[llms.txt](https://rentahuman.ai/llms.txt)）。
- **钱怎么走**：平台有钱包，发悬赏时从钱包扣款托管，另加 18% 服务费；钱包余额不足时返回 `deposit_url` 让主人去付。发布前要先做一次 `dryRun` 预览，**得到人明确同意后才真正发布**；放款也必须由主人指示，而且不可撤销（[llms.txt](https://rentahuman.ai/llms.txt)、[Escrow 文档](https://rentahuman.ai/docs/escrow)）。
- **派单 / 抢单**：两种方式，一是发悬赏让附近的人报名，二是按地点、技能、空闲时间直接挑人。默认由发布方人工选报名者，可以打开 `autoAccept` 自动录取合格的人（[rentahuman.ai](https://rentahuman.ai)、[llms.txt](https://rentahuman.ai/llms.txt)）。
- **验收与纠纷**：干活的人按悬赏里列的"Required evidence"提交照片、录音或笔记。发布方有 **4 天**审核，可以通过、拒绝或要求重做，最多 3 轮。**超时不会自动放款，而是自动转成平台人工仲裁**；拒绝也会进仲裁，退款需要平台裁决（[Escrow 文档](https://rentahuman.ai/docs/escrow)、[Get paid](https://rentahuman.ai/earn-with-ai/get-paid)）。
- **实际情况**：有一项安全研究抽查了 303 个悬赏，32.7% 来自 API 或 MCP，整体成交率只有 0.8%。研究归纳出 6 类滥用，其中"侦察与核验"类（定点拍照、电话核验）有 12 例。作者建议对高风险类目和超过阈值的单子**强制人工批准**，并在上游 MCP 加审批钩子（[arXiv 2602.19514](https://arxiv.org/html/2602.19514v1)）。
- **旁证**：早期主打"AI 付钱给人做任务"的 Payman，官网现在已经改成给银行和信用社做 agentic banking（[paymanai.com](https://paymanai.com)）。

## 6. Amazon Mechanical Turk：成熟的人类众包

**是什么**：最老牌的微任务众包平台，发布方发 HIT，工人领取作答。

- **接入**：发布方通过 API 创建 HIT，工人在平台上浏览、领取。
- **派单 / 抢单**：工人自己领取（相当于抢单），一个 HIT 可以开多个 assignment。领取后要在 `AssignmentDuration` 内完成，超时算放弃，任务**自动回到池子里给别人**（[CreateHITRequest](https://docs.aws.amazon.com/sdk-for-ruby/v3/api/Aws/MTurk/Types/CreateHITRequest.html)）。
- **准入**：用资格门槛筛人，例如 `PercentAssignmentsApproved`（通过率，0–100）。**提交少于 100 单的工人通过率一律按 100% 计**，因为样本太小没有意义；官方建议同时卡"已通过单数"，例如 95% 加 1000 单（[Selecting eligible workers](https://docs.aws.amazon.com/id_id/AWSMechTurk/latest/AWSMechanicalTurkRequester/SelectingEligibleWorkers.html)）。
- **验收与纠纷**：`AutoApprovalDelay` 到期后，没被明确拒绝的提交**自动通过、自动付款**。拒绝只应针对明显的敷衍，30 天内可以撤销拒绝（[AutoApprovalDelay](https://docs.aws.amazon.com/sdk-for-kotlin/api/latest/mturk/aws.sdk.kotlin.services.mturk.model/-create-hit-request/-builder/auto-approval-delay-in-seconds.html)、[CloudResearch](https://cloudresearch.com/?p=816)）。平台不仲裁，拒绝只影响工人的通过率。

## 7. 国内跑腿 / 众包配送：UU 跑腿、美团众包

**是什么**：同城即时配送，骑手是众包兼职。

- **接入**：骑手在专门的骑手 App（UU 的"跑男端"）注册接单（[App Store](https://apps.apple.com/app/id991522191)）。**UU 跑腿已经有官方 MCP server**，自称"国内首家兼容 MCP 协议的配送服务商"，提供询价、下单（凭询价返回的 `price_token`）、订单详情、跑男实时信息、取消这几个工具（[uupt-mcp-server](https://glama.ai/mcp/servers/@uupt-mcp/uupt-mcp-server)）。agent 已经可以直接叫跑腿。
- **派单 / 抢单**：美团专送以系统派单为主，众包原来是纯抢单。**2025 年 12 月起，众包改成"分配抢单"**：骑手照样点"抢"，但有多人同时抢一单时，系统等 3–5 秒，综合评估后再决定给谁，用来打击外挂和"单王"（[36氪, 2025-12-31](https://www.36kr.com/p/3619253681648129)）。拒单次数有上限（同文引骑手投诉，二手）。
- **验收**：UU 的代买单要收货人提供**收货确认码**才算完成，代送单由收货人确认收货。骑手要依次点"我已抵达、拍照取货、已送达"，提前或延后点都算违规（UU 官网 [uupt.com](https://www.uupt.com/Product.htm) 的流程说明，经搜索摘要转述；第三方页面另有"微信扫码签收"等说法）。
- **纠纷**：收货人联系不上时，转人工客服协助取消。

## 8. 闲鱼：国内 AI 服务的真实需求在这里

**是什么**：2026 年上半年，闲鱼的 AI 服务订单有 981.6 万单，同比增长 157%。其中"AI 技能接单"（AI 绘画、视频、配音、编程等）占 45.1%，"AI 模板与工作流"（包括工作流定制、智能体搭建）占 6.6%。卖家月均成交 897 元，大多是副业（[新华网, 2026-07-29](https://www.news.cn/tech/20260729/3ba4f5d1aaf044229b890f40ce52f492/c.html)）。

- **自动 / 人工**：两种交付在同一个市场里并存。虚拟商品可以靠闲管家、阿奇索这类工具在"付款后发货"时自动发卡密或说明（[阿奇索](https://www.agiso.com/product/aldsidle)、[知乎教程](https://zhuanlan.zhihu.com/p/691320514)）；定制类服务则是人工沟通、人工交付。**是否自动由卖家按商品设置**，买家只能从商品描述里看出来。
- **验收与纠纷**：主要靠超时自动确认收货（虚拟商品时限以官方为准）、协商、小法庭和客服介入。自动确认收货引发过不少纠纷，比如卖家不发货但系统照样放款（[扬子晚报, 2026-07](https://www.yzwb.net/news/sh/202607/t20260730_377694.html)）。

---

## 对 hive 的启示

1. **把"交付方式"做成上架属性，下单前让买家看到，而不是接单时才定。** Fiverr Go 让买家选 AI 即时档还是人工档，闲鱼是卖家按商品设自动发货。hive 已经有 `accept: auto | ask`，但它只管"接不接单"。建议在能力上架上再加一个 `fulfillment: agent | agent_human | onsite` 字段（对应你说的三类），用它决定接单窗口、干活时限（沿用 design.md 现有超时表，再加一档"人工定制"，例如 24 小时）和派单方式。买家 agent 在 `hive types` 里能看到，比如"这家 10 分钟全自动，那家 24 小时人工定制"，自己选。第 (2) 类人工介入的任务，需求澄清放进输入 schema，不在付款后再来回沟通，这样不违背"不做聊天"的约束。

2. **卖家接入继续用 `hive serve` 长轮询，再加一个"托管部署"选项，不做 mailbox。** ACP 的 `acp serve start` 和 `acp serve deploy railway` 跟 hive 的接单器加种子 agent 是同一套设计，说明方向没错。Fetch 的 mailbox（离线攒消息）不适合 hive，因为派单有 30 秒到 3 分钟的接单窗口，离线就不该派。扣子明确不支持本地 agent，这正是 hive 的差异点，可以写进定位里。第 (2) 类在接单器里可以是 `accept: ask`，配合 `run:` 先让本地 agent 出草稿、主人在网页上改完再交。建议在状态机 `IN_PROGRESS` 里加一个可见的 `awaiting_owner_review` 子状态（参考 A2A 的 `input-required` 中断态：任务暂停，补上输入后继续，[A2A spec](https://a2a-protocol.org/latest/specification/)），不新增顶层状态。

3. **人工抢单改成"抢单加短窗口择优"，通过率要有最小样本。** 美团众包 2025 年 12 月从纯抢单改成"抢 → 等 3–5 秒 → 系统综合评估"，原因是纯抢单只比手速，还招外挂。hive 的 `ask` 卖家现在是"同时派前 N 个，先接先得"，可以改成在 2–3 秒内收集所有"接"，再按价格和通过率选一个，实现成本很低。另外，MTurk 对少于 100 单的工人一律按 100% 算通过率。hive 的派单排序也要这样处理新卖家，否则一个差评就把新卖家打到底，或者零单卖家永远排不上。

4. **验收按类型分：自动和定制可以超时自动通过，线下任务要求结构化证据。** hive 的钱付款时就到了卖家账户，验收只影响信誉。这跟 MTurk 超时自动通过的模型一致，比 RentAHuman 的"超时进仲裁"轻得多，也符合"本期不做仲裁"。但第 (3) 类线下任务应该学 RentAHuman 的"Required evidence"和 UU 的确认码：`photo.onsite` 的输出 schema 必须包含照片、拍摄时间、定位，网页拍照时直接读 GPS 和时间戳，不收外部图片链接；格式不过可以重交，最多 3 次（RentAHuman 也是 3 轮）。卖家没按证据清单交付时，记为 `refund_eligible`，这个字段 design.md 已经预留了。

5. **线下任务是滥用的重灾区，hive 的"每笔都要人确认"要作为卖点写出来，再加类目白名单。** RentAHuman 的安全研究里，"定点拍照、核验"正是 6 类滥用之一，作者给出的头号建议就是"高风险类目强制人工批准"。hive 的支付宝人工确认天然满足这一点。但 `photo.onsite` 的输入 schema 还应该限制拍摄对象：只拍门店或公共场所，不拍具体的人或住宅门牌。线下送货类不要自建运力，可以把 UU 跑腿的官方 MCP 包成一个种子卖家（询价 → 下单 → 跑男信息），演示"agent 雇人"时比让队友拍照更真实。
