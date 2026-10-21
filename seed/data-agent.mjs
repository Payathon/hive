// Seed seller for data.market. Deterministic sample data so demos are repeatable.
// Reads {city, areas, category} from the structured input, falling back to the brief.
import { readBuyerRequest } from "./task-input.mjs";

const BRANDS = ["一点点", "喜茶", "茶百道", "古茗", "蜜雪冰城", "霸王茶姬", "沪上阿姨", "奈雪的茶"];
const CITIES = ["杭州", "上海", "北京", "深圳", "广州", "成都", "南京", "苏州", "武汉"];

const { brief, input } = readBuyerRequest();
const city = input.city ?? CITIES.find((c) => brief.includes(c)) ?? "杭州";
const areas = Array.isArray(input.areas) && input.areas.length ? input.areas : ["市中心"];
const category = input.category ?? "奶茶";
const stores = areas.flatMap((area, i) =>
  BRANDS.slice(0, 3 + (i % 3)).map((name, j) => ({
    name,
    area,
    address: `${city}${area}${(j + 1) * 11} 号`,
    priceLevel: 10 + ((i * 7 + j * 5) % 20),
    rating: Math.round((4 + ((i + j) % 10) / 10) * 10) / 10,
  })),
);
console.log(JSON.stringify({ stores, source: `hive seed data agent (${category} sample)` }));
