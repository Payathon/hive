// Seed seller for chart.compare: renders a bar chart of the first numeric column as an SVG data URL.
import { readBuyerInput } from "./task-input.mjs";

const input = readBuyerInput();
const rows = input.data;
const labelKey = Object.keys(rows[0]).find((k) => typeof rows[0][k] === "string") ?? Object.keys(rows[0])[0];
const valueKey = Object.keys(rows[0]).find((k) => typeof rows[0][k] === "number");
const values = rows.map((r) => (valueKey ? Number(r[valueKey]) : 1));
const max = Math.max(...values, 1);
const W = 640, H = 360, pad = 48, bw = (W - pad * 2) / rows.length;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const bars = rows
  .map((r, i) => {
    const h = ((H - pad * 2) * values[i]) / max;
    const x = pad + i * bw + 6, y = H - pad - h;
    return `<rect x="${x}" y="${y}" width="${bw - 12}" height="${h}" fill="#4f6bed"/>` +
      `<text x="${x + (bw - 12) / 2}" y="${H - pad + 18}" font-size="12" text-anchor="middle">${esc(r[labelKey])}</text>` +
      `<text x="${x + (bw - 12) / 2}" y="${y - 6}" font-size="12" text-anchor="middle">${values[i]}</text>`;
  })
  .join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fff"/>` +
  `<text x="${W / 2}" y="28" font-size="16" text-anchor="middle">${esc(input.title)}</text>${bars}</svg>`;
console.log(JSON.stringify({
  imageUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  caption: `${input.title}${valueKey ? `（按 ${valueKey}）` : ""}`,
}));
