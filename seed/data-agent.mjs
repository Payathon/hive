// Seed seller for market-data.competitors. Deterministic sample data so demos are repeatable.
import { readBuyerInput } from "./task-input.mjs";

const BRANDS = ["一点点", "喜茶", "茶百道", "古茗", "蜜雪冰城", "霸王茶姬", "沪上阿姨", "奈雪的茶"];

const input = readBuyerInput();
const stores = input.areas.flatMap((area, i) =>
  BRANDS.slice(0, 3 + (i % 3)).map((name, j) => ({
    name,
    area,
    address: `${input.city}${area}${(j + 1) * 11} 号`,
    priceLevel: 10 + ((i * 7 + j * 5) % 20),
    rating: Math.round((4 + ((i + j) % 10) / 10) * 10) / 10,
  })),
);
console.log(JSON.stringify({ stores, source: `hive seed data agent (${input.category} sample)` }));
