/**
 * Резолв локаций.
 *
 * В отличие от ss.ge, у livo фильтр по району существует (districts), поэтому
 * разворачивать район в микрорайоны не нужно — но названия всё равно надо
 * превращать в id. Справочник /v2/cities отдаёт каждое имя сразу на трёх языках,
 * поэтому «Ваке», "Vake" и «ვაკე» резолвятся одинаково независимо от locale.
 */
import { LivoError } from "./client.mjs";

const norm = (s) => String(s).trim().toLowerCase();
const isId = (v) => typeof v === "number" || /^\d+$/.test(String(v));

/** Все написания одного узла: display_name на трёх языках + slug. */
function aliases(node) {
  const out = new Set();
  if (node.display_name) out.add(norm(node.display_name));
  if (node.slug) out.add(norm(node.slug));
  for (const t of Object.values(node.translations ?? {}))
    if (t?.display_name) out.add(norm(t.display_name));
  return out;
}

/** Плоские индексы по дереву городов. Строится один раз на процесс. */
export async function index(client) {
  if (client._geoIndex) return client._geoIndex;
  const cities = await client.cities();
  const idx = { cities: [], districts: [], urbans: [] };
  for (const c of cities) {
    idx.cities.push({ id: c.id, name: c.display_name, aliases: aliases(c) });
    for (const d of c.districts ?? []) {
      idx.districts.push({
        id: d.id, name: d.display_name, city_id: c.id, city: c.display_name, aliases: aliases(d),
      });
      for (const u of d.urbans ?? []) {
        idx.urbans.push({
          id: u.id, name: u.display_name, district_id: d.id, district: d.display_name,
          city_id: c.id, city: c.display_name, streets: u.streets_count ?? 0, aliases: aliases(u),
        });
      }
    }
  }
  client._geoIndex = idx;
  return idx;
}

function pick(pool, raw, kind, hint = "geo()") {
  if (isId(raw)) {
    const id = Number(raw);
    const hit = pool.find((x) => x.id === id);
    if (!hit) throw new LivoError(`${kind} с id ${id} не найден`);
    return [hit];
  }
  const needle = norm(raw);
  const exact = pool.filter((x) => x.aliases.has(needle));
  if (exact.length) return exact;
  const part = pool.filter((x) => [...x.aliases].some((a) => a.includes(needle)));
  if (!part.length)
    throw new LivoError(
      `${kind} "${raw}" не найден. Посмотри доступные через ${hint}. ` +
        `Названия принимаются на любом из трёх языков сайта.`,
    );
  return part;
}

export async function resolveCity(client, city) {
  const idx = await index(client);
  const hits = pick(idx.cities, city, "город");
  if (hits.length > 1)
    throw new LivoError(
      `"${city}" подходит нескольким городам: ${hits.map((h) => `${h.name} (${h.id})`).join(", ")}. ` +
        `Уточни название или передай id.`,
    );
  return { id: hits[0].id, name: hits[0].name };
}

/**
 * Названия/id районов и микрорайонов -> id. Возвращает их РАЗДЕЛЬНО: у livo
 * districts и urbans — два независимых параметра, и смешивать их нельзя.
 * Если ограничен город, поиск идёт только внутри него.
 */
export async function resolveAreas(client, names, cityId = null) {
  const idx = await index(client);
  const districts = cityId ? idx.districts.filter((d) => d.city_id === cityId) : idx.districts;
  const urbans = cityId ? idx.urbans.filter((u) => u.city_id === cityId) : idx.urbans;

  const dIds = [];
  const uIds = [];
  const labels = [];
  for (const raw of names) {
    let hits = null;
    let kind = null;
    // микрорайон приоритетнее: «Ваке» — и район (Ваке-Сабуртало), и микрорайон
    try {
      hits = pick(urbans, raw, "микрорайон");
      kind = "urban";
    } catch {
      hits = pick(districts, raw, "район");
      kind = "district";
    }
    for (const h of hits) {
      (kind === "urban" ? uIds : dIds).push(h.id);
      labels.push(`${h.name} (${kind === "urban" ? "мкр" : "район"} ${h.id}, ${h.city})`);
    }
  }
  return { districts: [...new Set(dIds)], urbans: [...new Set(uIds)], labels };
}

/** Метро по названию или id. Станции есть только в Тбилиси. */
export async function resolveMetro(client, names) {
  const p = await client.parameters();
  const pool = (p.metro_stations ?? []).map((m) => ({
    id: m.id, name: m.display_name, aliases: new Set([norm(m.display_name), norm(m.slug ?? "")]),
  }));
  const ids = [];
  const labels = [];
  for (const raw of names) {
    for (const h of pick(pool, raw, "станция метро", "reference(['metro_stations'])")) {
      ids.push(h.id);
      labels.push(`${h.name} (${h.id})`);
    }
  }
  return { ids: [...new Set(ids)], labels };
}

/**
 * Удобства (фильтр parameters) по стабильному английскому ключу или id.
 * display_name переводится вместе с locale, поэтому опорой служит svg_file_name —
 * он одинаков на всех языках.
 */
export async function resolveAmenities(client, names) {
  const p = await client.parameters();
  const byId = new Map();
  for (const group of Object.values(p.statement_parameters ?? {}))
    for (const x of group)
      if (!byId.has(x.id))
        byId.set(x.id, {
          id: x.id, name: x.display_name, key: x.svg_file_name, type: x.type,
          aliases: new Set([norm(x.svg_file_name ?? ""), norm(x.display_name ?? "")]),
        });
  const pool = [...byId.values()];
  const ids = [];
  const labels = [];
  for (const raw of names) {
    for (const h of pick(pool, raw, "удобство", "reference(['amenities'])")) {
      ids.push(h.id);
      labels.push(`${h.key} (${h.id})`);
    }
  }
  return { ids: [...new Set(ids)], labels };
}

/** Полный список ключей удобств — для reference() и для сообщений об ошибке. */
export async function amenityCatalog(client) {
  const p = await client.parameters();
  const out = new Map();
  for (const [estateId, group] of Object.entries(p.statement_parameters ?? {}))
    for (const x of group) {
      const rec = out.get(x.id) ?? {
        id: x.id, key: x.svg_file_name, name: x.display_name, type: x.type,
        deal_types: x.deal_types, estate_types: [],
      };
      rec.estate_types.push(Number(estateId));
      out.set(x.id, rec);
    }
  return [...out.values()].sort((a, b) => a.id - b.id);
}
