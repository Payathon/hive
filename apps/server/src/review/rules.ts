import { describeInput, type ReviewDecision, type Reviewer, type ReviewRequest } from "./reviewer.ts";

// Keyword rules: the reviewer for tests and local dev, and the fallback when the model reviewer
// fails. They only catch blunt cases, and never show sellers the input before they accept.

// Files and settings on the seller's machine a buyer has no business seeing.
const LOCAL_SECRET = /~\/\.|\$HOME|\/etc\/(passwd|shadow)|\.ssh\b|id_rsa|id_ed25519|\.aws\/|\.hive\/|\.claude\/|\.npmrc|\.netrc|\.git-credentials|keychain|钥匙串/i;
const HAND_OVER = /输出|贴|发给|发我|附上|打包|上传|读取|读一下|打印|cat\b|print|include|send|paste|attach|upload|dump/i;
// The seller agent's own setup, which is the seller's product.
const OWN_SETUP = /(系统提示|system prompt|提示词|你的\s*skills?|CLAUDE\.md|你的(配置|指令|记忆))/i;
// Credentials or local state, said of the seller ("你的 token", "本机的环境变量").
const SELLER_SIDE = /(你的|你电脑|你本机|本机|当前目录|工作目录|卖家的?)\s*.{0,8}(token|api[ _-]?key|密钥|密码|环境变量|env|凭证|cookie|config|配置文件|文件)/i;
// Instructions aimed at the reviewer, or at overriding the seller agent's rules.
const STEERING = /(审核|reviewer|moderator|安全检查).{0,20}(通过|放行|safe|allow|忽略|ignore)|忽略(之前|以上|前面|所有)的?(指令|规则|要求|限制)|ignore (all |the )?(previous|above|prior) (instructions|rules)/i;
// Following or watching a person.
const STALKING = /偷拍|跟踪|跟拍|盯梢|蹲守|蹲点.{0,6}(某人|他|她)|行踪|定位(他|她|某人)/;
// A private person's home as the target of on-site work.
const PRIVATE_PLACE = /(他|她|某人|这个人|此人)(家|住)|家门口|住处|住址|(\d+\s*(栋|号楼|幢)).{0,6}(\d+\s*(单元|室|号))/;
// Other people's personal data in the order: ID cards, phone numbers.
const PERSONAL_DATA = /\b\d{17}[\dXx]\b|\b1[3-9]\d{9}\b|身份证号|手机号/;

export class RuleReviewer implements Reviewer {
  readonly name = "rules";
  readonly model = null;

  async review(req: ReviewRequest): Promise<ReviewDecision> {
    const text = `${req.brief}\n${req.input === null || req.input === undefined ? "" : JSON.stringify(req.input)}`;
    const onsite = req.category.id.startsWith("onsite.");
    const block: string[] = [];
    const flag: string[] = [];
    if (LOCAL_SECRET.test(text) && HAND_OVER.test(text)) block.push("要求卖家交出本机文件或凭证");
    if (OWN_SETUP.test(text) && HAND_OVER.test(text)) block.push("要求卖家交出 agent 的提示词或配置");
    if (onsite && STALKING.test(text)) block.push("像是在跟踪或偷拍某个人");
    if (STEERING.test(text)) flag.push("需求里有给审核或卖家 agent 下指令的话");
    if (SELLER_SIDE.test(text)) flag.push("提到了卖家本机的凭证或文件");
    if (onsite && PRIVATE_PLACE.test(text)) flag.push("现场地点像是某人的住处");
    if (PERSONAL_DATA.test(text)) flag.push("含有他人的身份证或手机号");
    const reasons = block.length ? block : flag;
    return {
      verdict: block.length ? "block" : flag.length ? "flag" : "allow",
      reasons,
      discloseInput: false,
      inputSummary: describeInput(req.input),
    };
  }
}
