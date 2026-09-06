/**
 * Smoke-тест: поднимает сервер и дёргает инструменты по-настоящему, вживую.
 * Ходит в сеть — офлайн упадёт, и это ожидаемо.
 *
 *   npm test
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.mjs");
const proc = spawn("node", [ENTRY], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
// ответы сопоставляются по JSON-RPC id, а не по порядку: параллельные вызовы
// могут вернуться в любом порядке, и очередь тут врала бы молча
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line.startsWith("{")) continue;
    const msg = JSON.parse(line);
    const r = pending.get(msg.id);
    if (r) { pending.delete(msg.id); r(msg); }
  }
});
let id = 0;
const rpc = (method, params) => {
  const mine = ++id;
  const p = new Promise((r) => pending.set(mine, r));
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mine, method, params }) + "\n");
  return p;
};
const notify = (method) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");

const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  return { text: r.result.content[0].text, isError: !!r.result.isError };
};
const json = async (name, args) => JSON.parse((await call(name, args)).text);

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" },
});
check("initialize", init.result.serverInfo.name === "livo-ge", init.result.serverInfo.version);
check("instructions отданы", (init.result.instructions ?? "").length > 500);
notify("notifications/initialized");

const tools = (await rpc("tools/list")).result.tools.map((t) => t.name).sort();
check("набор инструментов",
  tools.join(",") === "count,geo,get_skill,listing,projects,reference,search", tools.join(","));

const skill = await call("get_skill", { name: "apartment-search" });
check("get_skill отдаёт инструкцию", skill.text.includes("от грубого к точному"));

const geo = await json("geo", { city: "Тбилиси" });
check("geo: 6 районов Тбилиси", geo.districts.length === 6, `${geo.districts.length}`);
check("geo: у Ваке-Сабуртало есть микрорайоны",
  geo.districts.some((d) => d.urbans.length > 5));

const sug = await json("geo", { query: "Ваке" });
check("geo(query) отдаёт связку id",
  sug.matches.length > 0 && sug.matches[0].ids.city_id === 1);

// названия резолвятся на любом из трёх языков сайта — один и тот же микрорайон
const [ru, en, ka] = await Promise.all([
  json("count", { deal: "sale", areas: ["Ваке"] }),
  json("count", { deal: "sale", areas: ["Vake"] }),
  json("count", { deal: "sale", areas: ["ვაკე"] }),
]);
check("названия локаций на ka/en/ru дают один id",
  ru.query.areas[0] === en.query.areas[0] && en.query.areas[0] === ka.query.areas[0],
  ru.query.areas[0]);

// ценовой фильтр обязан реально применяться, а не быть проигнорированным
const wide = await json("count", { deal: "sale", areas: ["Ваке"] });
const narrow = await json("count",
  { deal: "sale", areas: ["Ваке"], price_min: 100000, price_max: 200000 });
check("ценовой фильтр применяется", narrow.total < wide.total, `${wide.total} -> ${narrow.total}`);

const s = await json("search", { deal: "sale", areas: ["Ваке"], limit: 15, order: "date_desc" });
check("search отдаёт объекты", s.listings.length === 15, `${s.listings.length}`);
check("search знает свой total", typeof s.total === "number" && s.total > 0, `${s.total}`);
check("applied_filters — эхо API", s.applied_filters?.urbans?.length === 1,
  JSON.stringify(s.applied_filters?.urbans));
check("цены сразу в трёх валютах",
  s.listings.every((l) => l.price.gel && l.price.usd && l.price.eur));
check("возраст объявления известен", s.listings.every((l) => typeof l.age_days === "number"));
check("published посчитан из возраста", s.listings.every((l) => /^\d{4}-\d\d-\d\d$/.test(l.published)));
check("у карточек проставлен promo_tier",
  s.listings.every((l) => l.promo_tier === null || typeof l.promo_tier === "string"),
  s.listings.map((l) => l.promo_tier ?? "-").join(","));
// сортировка работает только ВНУТРИ тира и идёт по updated, а не по публикации
const plain = s.listings.filter((l) => l.promo_tier === null).map((l) => l.updated);
check("date_desc упорядочил обычные объявления по updated",
  plain.length > 1 && plain.every((v, i) => i === 0 || plain[i - 1] >= v),
  `${plain.length} обычных из ${s.listings.length}`);

// несколько удобств объединяются по ИЛИ — сервер обязан об этом предупредить
const orq = await json("count",
  { deal: "rent", areas: ["Сабуртало"], amenities: ["elevator", "conditioner"] });
const one = await json("count", { deal: "rent", areas: ["Сабуртало"], amenities: ["elevator"] });
check("два удобства = ИЛИ, не И", orq.total > one.total, `${one.total} -> ${orq.total}`);
check("про ИЛИ предупреждено", (orq.warning ?? "").includes("ИЛИ"));

// платные тиры закреплены над сортировкой — на широком запросе первая страница
// целиком куплена, и это ровно то, о чём сервер обязан предупреждать
const broad = await json("search", { deal: "sale", city: "Тбилиси", limit: 15, order: "date_desc" });
const RANK = { super_vip: 0, vip_plus: 1, vip: 2, promoted: 3 };
const ranks = broad.listings.map((l) => RANK[l.promo_tier] ?? 4);
check("платные тиры идут строго сверху",
  ranks.every((v, i) => i === 0 || ranks[i - 1] <= v),
  broad.listings.map((l) => l.promo_tier ?? "-").join(","));
check("на широком запросе первая страница платная",
  broad.listings.some((l) => l.promo_tier !== null));

// room_types — словарь, а не количество: 6 комнат это id 7, и проверять это надо
// сквозным запросом, иначе подмена уедет незаметно
const six = await json("search", { deal: "sale", city: "Тбилиси", rooms: [6], limit: 5 });
check("rooms:[6] действительно даёт шестикомнатные",
  six.listings.length > 0 && six.listings.every((l) => l.rooms === 6),
  six.listings.map((l) => l.rooms).join(","));

const det = await json("listing", { id: s.listings[0].id });
check("listing: координаты", Boolean(det.lat && det.lon));
check("listing: настоящая дата публикации", /^\d{4}-\d\d-\d\d/.test(det.published ?? ""), det.published);
check("listing: ссылка ведёт на livo.ge", (det.url ?? "").startsWith("https://livo.ge/"));

const ref = await json("reference", { groups: ["amenities"], estate: "flat" });
check("reference: удобства с устойчивыми ключами",
  ref.amenities.some((x) => x.key === "elevator"));

const pr = await json("projects", { city: "Тбилиси", limit: 2 });
check("projects: есть проекты", pr.projects.length === 2 && pr.total > 0, `${pr.total}`);
check("projects: честно сказано про отсутствие дат", (pr.note ?? "").includes("Дат публикации"));

// неизвестное удобство должно отвергаться, а не уходить в API молча
const bad = await call("count", { deal: "sale", amenities: ["nonsense"] });
check("неизвестное удобство отвергнуто", bad.isError);
// неизвестный тип сделки должен отвергаться схемой
const bad2 = await call("count", { deal: "барахолка" });
check("неизвестный deal отвергнут схемой", bad2.isError);

proc.kill();
console.log(failures ? `\n${failures} проверок упало` : "\nвсе проверки прошли");
process.exit(failures ? 1 : 0);
