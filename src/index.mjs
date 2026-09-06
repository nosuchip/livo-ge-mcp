#!/usr/bin/env node
/**
 * livo-ge-mcp — MCP-сервер над livo.ge.
 *
 * Прозрачный stateless-прокси: один вызов инструмента = один-несколько живых запросов
 * к бэкенду tnet. Между вызовами кешируются только два справочника (локации и словари,
 * TTL 6 ч) — сами объявления не кешируются никогда. Публичного API у livo.ge нет,
 * контракт восстановлен реверс-инжинирингом; разбор и грабли в docs/API.md.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  AREA_TYPES, BUILDING_STATUS, CURRENCY, Client, DEAL_TYPES, ESTATE_TYPES,
  ORDER, OWNER_TYPES, REFERENCE_GROUPS, ROOM_COUNT_BY_TYPE,
  ROOM_TYPE_BY_COUNT, VERSION,
} from "./client.mjs";
import { amenityCatalog, index as geoIndex, resolveAmenities, resolveAreas, resolveCity, resolveMetro }
  from "./geo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = ["apartment-search", "criteria-coverage"];

const INSTRUCTIONS = `\
livo-ge-mcp — прозрачный прокси над livo.ge (портал недвижимости группы tnet, бывший
myhome.ge; публичного API нет). Один вызов = живая выборка, объявления не кешируются.

Прежде чем собирать многокритериальный поиск, вызови get_skill('apartment-search') —
он раскладывает критерии пользователя по инструментам и задаёт порядок от грубого
к точному. get_skill('criteria-coverage') говорит, на что livo отвечает, а на что нет.

ВСЕГДА сообщай свежесть по age_days и published — они считаются из quantity_of_day,
это настоящий возраст объявления. Поле updated НЕ является датой публикации: livo
проставляет туда любое обновление и платное поднятие, и у объявления 2024 года
updated сплошь и рядом «сегодня». Никогда не выдавай updated за свежесть.

Выдача всегда частичная. Ответ /v1/statements вообще не содержит общего количества —
его даёт отдельный вызов count, и search делает его сам. Всегда сопоставляй returned
с total из того же ответа.

API молча игнорирует неизвестные имена полей и отдаёт неотфильтрованную выдачу, поэтому
search сверяет фильтр с белым списком и падает на опечатке, а не тихо врёт. Дополнительно
он возвращает applied_filters — эхо самого API о том, что он реально разобрал; если там
пусто там, где ты фильтровал, фильтр не применился.

Цены приходят сразу в трёх валютах (GEL, USD, EUR) — конвертировать не нужно. Но фильтр
по цене понимает только GEL и USD; по умолчанию USD.

Сортировка НИКОГДА не применяется ко всей выдаче. Платные тиры закреплены сверху
в порядке super_vip -> vip_plus -> vip, и только под ними идут обычные объявления,
уже отсортированные. У каждой карточки есть promo_tier: null означает обычное
объявление. Первые ~5-10 позиций почти любой страницы — платные, и «самое свежее
сверху» там не работает даже с order='date_desc'. Если пользователю нужна
именно свежесть, смотри на age_days, а не на позицию.

И сама сортировка order='date_*' идёт по last_updated, а не по дате публикации:
объявление 2023 года, поднятое сегодня, встанет выше вчерашнего. Единственный
надёжный признак свежести — age_days.

Списочные фильтры внутри одного поля работают по ИЛИ. Для rooms и building это ожидаемо,
а для amenities — ловушка: [elevator, conditioner] даёт БОЛЬШЕ результатов, чем [elevator]
(проверено счётчиком). «С лифтом И кондиционером» так не выражается — фильтруй по одному
удобству и пересекай результаты сам.

Таксономия livo отдаётся как есть. Названия районов, микрорайонов, станций метро
принимаются на любом из трёх языков сайта (ka/en/ru) и резолвятся в id.

Запросы идут в темпе 1 rps с честным User-Agent. Если сервер ответит 403 или 429,
предохранитель размыкается и остаётся разомкнутым — это сделано намеренно: не повторяй
запрос, скажи пользователю попробовать существенно позже.`;

const client = new Client({
  locale: process.env.LIVO_LOCALE ?? "ru",
  minInterval: Number(process.env.LIVO_MIN_INTERVAL_MS ?? 1000),
});

/* ------------------------------------------------------------------ форматирование */

const DEAL_BY_ID = Object.fromEntries(Object.entries(DEAL_TYPES).map(([k, v]) => [v, k]));
const ESTATE_BY_ID = Object.fromEntries(Object.entries(ESTATE_TYPES).map(([k, v]) => [v, k]));
const STATUS_BY_ID = Object.fromEntries(Object.entries(BUILDING_STATUS).map(([k, v]) => [v, k]));

/** Дата публикации из quantity_of_day: это разница в календарных днях с сегодняшним
 *  числом. Проверено на выборке — сходится с created_at из карточки объявления. */
function publishedFromAge(days) {
  if (typeof days !== "number") return null;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

const money = (p) =>
  p
    ? {
        gel: p["1"]?.price_total ?? null,
        usd: p["2"]?.price_total ?? null,
        eur: p["3"]?.price_total ?? null,
        per_m2_usd: p["2"]?.price_square ?? null,
        per_m2_gel: p["1"]?.price_square ?? null,
      }
    : null;

/** Единая форма карточки выдачи. */
function card(it, locale) {
  return {
    id: it.id,
    title: it.dynamic_title ?? null,
    url: Client.urlOf(it, locale),
    deal: DEAL_BY_ID[it.deal_type_id] ?? it.deal_type_id,
    estate: ESTATE_BY_ID[it.real_estate_type_id] ?? it.real_estate_type_id,
    building: STATUS_BY_ID[it.status_id] ?? it.status_id,
    price: money(it.price),
    price_negotiable: it.price_negotiable ?? null,
    area_m2: it.area ?? null,
    rooms: it.room != null ? Number(it.room) : null,
    bedrooms: it.bedroom != null ? Number(it.bedroom) : null,
    floor: it.floor ?? null,
    floors_total: it.total_floors ?? null,
    city: it.city_name ?? null,
    district: it.district_name ?? null,
    urban: it.urban_name ?? null,
    address: it.address?.trim() || null,
    lat: it.lat ?? null,
    lon: it.lng ?? null,
    age_days: it.quantity_of_day ?? null,
    published: publishedFromAge(it.quantity_of_day), // расчёт из age_days
    updated: it.last_updated ?? null, // НЕ дата публикации: правки и платные поднятия
    owner_type: it.user_type?.type ?? null,
    user_id: it.user_id ?? null,
    images: Array.isArray(it.images) ? it.images.length : null,
    promo_tier: promoTier(it), // null = обычное объявление, оно и отсортировано честно
  };
}

/** Платные тиры закреплены НАД сортировкой: super_vip, затем vip_plus, затем vip,
 *  и только потом обычные объявления, уже по заданному порядку. Проверено на
 *  order_by=date с обоими sequence. */
function promoTier(it) {
  if (it.is_super_vip) return "super_vip";
  if (it.is_vip_plus) return "vip_plus";
  if (it.is_vip) return "vip";
  if (it.is_promoted) return "promoted";
  return null;
}

const FRESHNESS_NOTE =
  "age_days и published — настоящий возраст объявления (из quantity_of_day, сверено " +
  "с created_at). updated — дата последней правки или платного поднятия, НЕ публикации: " +
  "у старых объявлений она регулярно «сегодня». Не выдавай updated за свежесть. " +
  "promo_tier != null — платно продвинутое объявление: оно стоит выше по деньгам, " +
  "а не по релевантности или свежести.";

/** Несколько удобств API объединяет по ИЛИ; молча это выглядит как «нашлось больше». */
const orWarning = (a) =>
  a.amenities?.length > 1
    ? `Указано ${a.amenities.length} удобств — API объединяет их по ИЛИ, а не по И: ` +
      `в выдачу попадут объявления, где есть хотя бы одно из них.`
    : undefined;

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] });
const fail = (e) => ({
  content: [{ type: "text", text: `Ошибка: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

/* ------------------------------------------------------------------------- фильтр */

const filterShape = {
  deal: z.enum(["sale", "rent", "lease", "daily"]).describe("тип сделки"),
  estate: z
    .enum(["flat", "house", "cottage", "land", "commercial", "hotel"])
    .default("flat")
    .describe("тип недвижимости"),
  city: z
    .union([z.string(), z.number()])
    .default("Тбилиси")
    .describe("город: название на любом из ka/en/ru или id. Пустая строка — вся Грузия"),
  areas: z
    .array(z.union([z.string(), z.number()]))
    .optional()
    .describe(
      "районы и микрорайоны вперемешку, по названию или id. Микрорайон имеет приоритет " +
        "при совпадении имени (напр. «Ваке» — это микрорайон, а не район Ваке-Сабуртало)",
    ),
  metro: z.array(z.union([z.string(), z.number()])).optional().describe("станции метро (только Тбилиси)"),
  streets: z.array(z.number().int()).optional().describe("id улиц; названия — через geo()"),
  rooms: z
    .array(z.number().int().min(1).max(10))
    .optional()
    .describe("число комнат, напр. [2,3]; 10 означает «10 и больше»"),
  bedrooms: z.array(z.number().int()).optional().describe("число спален"),
  price_min: z.number().optional().describe("нижняя граница цены"),
  price_max: z.number().optional().describe("верхняя граница цены"),
  currency: z.enum(["USD", "GEL"]).default("USD").describe("валюта ценового фильтра; EUR не поддержан"),
  price_per_m2: z
    .boolean()
    .default(false)
    .describe("трактовать price_min/price_max как цену за м² (отдельный параметр API)"),
  area_min: z.number().optional().describe("площадь от"),
  area_max: z.number().optional().describe("площадь до"),
  area_unit: z.enum(["m2", "ha"]).default("m2").describe("единица площади; ha — только для участков"),
  floor_min: z.number().int().optional().describe("этаж от"),
  floor_max: z.number().int().optional().describe("этаж до"),
  building: z
    .array(z.enum(["old", "new", "under_construction"]))
    .optional()
    .describe("состояние постройки: старая / новостройка / строящаяся"),
  conditions: z.array(z.number().int()).optional().describe("состояние ремонта, id из reference('conditions')"),
  project_types: z.array(z.number().int()).optional().describe("тип проекта дома, id из reference('project_types')"),
  heating_types: z.array(z.number().int()).optional().describe("отопление, id из reference"),
  hot_water_types: z.array(z.number().int()).optional().describe("горячая вода, id из reference"),
  parking_types: z.array(z.number().int()).optional().describe("парковка, id из reference"),
  material_types: z.array(z.number().int()).optional().describe("материал стен, id из reference"),
  bathroom_types: z.array(z.number().int()).optional().describe("санузлы, id из reference"),
  storeroom_types: z.array(z.number().int()).optional().describe("кладовая, id из reference"),
  living_room_types: z.array(z.number().int()).optional().describe("гостиная, id из reference"),
  door_window_types: z.array(z.number().int()).optional().describe("двери/окна, id из reference"),
  amenities: z
    .array(z.union([z.string(), z.number()]))
    .optional()
    .describe(
      "удобства по устойчивому ключу или id: elevator, furniture-equipment, conditioner, " +
        "internet, guard, storeroom, swimming-pool-open, pets-allowed … список — reference('amenities'). " +
        "ВНИМАНИЕ: несколько удобств API объединяет по ИЛИ, а не по И — [elevator, conditioner] " +
        "даёт больше результатов, чем [elevator]. Нужен И — фильтруй по одному и пересекай сам",
    ),
  owner: z
    .array(z.enum(OWNER_TYPES))
    .optional()
    .describe("кто подал: physical (собственник), broker, agency, developer"),
  has_balcony: z.boolean().optional().describe("есть балкон"),
  has_loggia: z.boolean().optional().describe("есть лоджия"),
  has_porch: z.boolean().optional().describe("есть веранда"),
  with_3d: z.boolean().optional().describe("есть 3D-тур (таких единицы)"),
  has_cadastral_code: z.boolean().optional().describe("указан кадастровый код"),
  can_exchanged: z.boolean().optional().describe("возможен обмен"),
  q: z.string().optional().describe("свободный текст: ищет по заголовку/описанию"),
};

/** Собирает query API из человеческих критериев и объясняет, что получилось. */
async function buildFilter(a) {
  const f = {
    deal_types: DEAL_TYPES[a.deal],
    real_estate_types: ESTATE_TYPES[a.estate ?? "flat"],
    q: a.q,
  };
  const echo = { deal: a.deal, estate: a.estate ?? "flat" };

  let cityId = null;
  if (a.city !== "" && a.city != null) {
    const c = await resolveCity(client, a.city);
    cityId = c.id;
    f.cities = c.id;
    echo.city = `${c.name} (${c.id})`;
  } else {
    echo.city = "вся Грузия";
  }

  if (a.areas?.length) {
    const r = await resolveAreas(client, a.areas, cityId);
    if (r.districts.length) f.districts = r.districts;
    if (r.urbans.length) f.urbans = r.urbans;
    echo.areas = r.labels;
  }
  if (a.metro?.length) {
    const r = await resolveMetro(client, a.metro);
    f.metro_station_ids = r.ids;
    echo.metro = r.labels;
  }
  if (a.amenities?.length) {
    const r = await resolveAmenities(client, a.amenities);
    f.parameters = r.ids;
    echo.amenities = r.labels;
  }
  if (a.streets?.length) f.streets = a.streets;
  // room_types — словарь, а не количество: выше 5 id расходятся с числом комнат
  if (a.rooms?.length) f.room_types = a.rooms.map((n) => ROOM_TYPE_BY_COUNT[n]);
  if (a.bedrooms?.length) f.bedroom_types = a.bedrooms;
  if (a.building?.length) f.statuses = a.building.map((k) => BUILDING_STATUS[k]);
  if (a.owner?.length) f.owner_type = a.owner;

  for (const k of [
    "conditions", "project_types", "heating_types", "hot_water_types", "parking_types",
    "material_types", "bathroom_types", "storeroom_types", "living_room_types",
    "door_window_types",
  ])
    if (a[k]?.length) f[k] = a[k];

  for (const k of ["has_balcony", "has_loggia", "has_porch", "with_3d", "has_cadastral_code", "can_exchanged"])
    if (a[k] !== undefined) f[k] = a[k];

  if (a.price_min != null || a.price_max != null) {
    f.currency_id = CURRENCY[a.currency ?? "USD"];
    if (a.price_per_m2) {
      f.square_price_from = a.price_min;
      f.square_price_to = a.price_max;
    } else {
      f.price_from = a.price_min;
      f.price_to = a.price_max;
    }
    echo.price = `${a.price_min ?? "…"}–${a.price_max ?? "…"} ${a.currency ?? "USD"}` +
      (a.price_per_m2 ? " за м²" : "");
  }
  if (a.area_min != null || a.area_max != null) {
    f.area_types = AREA_TYPES[a.area_unit ?? "m2"];
    f.area_from = a.area_min;
    f.area_to = a.area_max;
  }
  if (a.floor_min != null) f.floor_from = a.floor_min;
  if (a.floor_max != null) f.floor_to = a.floor_max;

  return { filter: Client.buildFilter(f), echo };
}

/* ---------------------------------------------------------------------- сервер */

const server = new McpServer({ name: "livo-ge", version: VERSION }, { instructions: INSTRUCTIONS });

server.registerTool(
  "get_skill",
  {
    title: "Инструкция по работе с источником",
    description:
      "Возвращает инструкцию. 'apartment-search' — как разложить критерии пользователя " +
      "по инструментам и в каком порядке идти. 'criteria-coverage' — на что livo.ge " +
      "отвечает, на что отвечает приблизительно, и чего не знает вовсе. " +
      "Вызывай перед сборкой многокритериального поиска.",
    inputSchema: { name: z.enum(SKILLS).describe("имя инструкции") },
  },
  async ({ name }) => {
    try {
      return {
        content: [{ type: "text", text: await readFile(join(HERE, "skills", `${name}.md`), "utf8") }],
      };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "count",
  {
    title: "Счётчики по фильтру",
    description:
      "Считает результаты по фильтру, не выкачивая их — один дешёвый запрос. " +
      "Годится, чтобы проверить осмысленность критериев и сравнить варианты фильтра " +
      "между собой. Возвращает total — полное число объявлений под фильтр.",
    inputSchema: filterShape,
  },
  async (a) => {
    try {
      const { filter, echo } = await buildFilter(a);
      const c = await client.count(filter);
      return ok({
        query: echo,
        warning: orWarning(a),
        total: c.total,
        note:
          "total — число объявлений, а не квартир: одно жильё нередко висит несколькими. " +
          "Счётчик считает и платно продвинутые объявления, и обычные.",
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "search",
  {
    title: "Поиск объявлений",
    description:
      "Ищет объявления на livo.ge. Возвращает частичную выдачу — сравнивай returned с total. " +
      "Цены отдаются сразу в GEL, USD и EUR. age_days/published — настоящий возраст " +
      "объявления; updated — правка или платное поднятие, не публикация. " +
      "applied_filters — эхо самого API о том, что он разобрал из фильтра.",
    inputSchema: {
      ...filterShape,
      order: z
        .enum(["date_desc", "date_asc", "price_asc", "price_desc"])
        .optional()
        .describe(
          "сортировка. Работает ТОЛЬКО внутри платных тиров: super_vip, vip_plus и vip " +
            "закреплены сверху в любом случае (см. promo_tier у карточек). " +
            "date_* сортирует по last_updated, а не по дате публикации — " +
            "для настоящей свежести смотри age_days",
        ),
      limit: z.number().int().min(1).max(100).default(20).describe("сколько объявлений вернуть"),
      page: z.number().int().min(1).default(1).describe("страница выдачи размером limit"),
    },
  },
  async (a) => {
    try {
      const { filter, echo } = await buildFilter(a);
      if (a.order) Object.assign(filter, ORDER[a.order]);
      // ответ /v1/statements не содержит общего количества — за ним отдельный запрос
      const { items, echo: applied } = await client.search(filter, { page: a.page, per_page: a.limit });
      const counts = await client.count(filter);
      return ok({
        query: { ...echo, order: a.order ?? "по умолчанию (порядок самого livo)" },
        warning: orWarning(a),
        total: counts.total,
        page: a.page,
        returned: items.length,
        applied_filters: applied,
        freshness: FRESHNESS_NOTE,
        listings: items.map((it) => card(it, client.locale)),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "listing",
  {
    title: "Карточка объявления",
    description:
      "Полная карточка: описание, удобства, координаты, этажность, состояние, кадастр, " +
      "просмотры, телефон (частично скрыт). Здесь есть created_at — настоящая дата " +
      "публикации, единственное место, где она приходит явно.",
    inputSchema: {
      id: z.number().int().describe("id объявления (поле id из search)"),
      with_similars: z.boolean().default(false).describe("добавить похожие объявления (подбор livo)"),
    },
  },
  async ({ id, with_similars }) => {
    try {
      const d = await client.listing(id);
      const params = (d.parameters ?? []).map((p) => p.svg_file_name ?? p.display_name ?? p.id);
      const out = {
        id: d.id,
        title: d.dynamic_title ?? null,
        url: Client.urlOf(d, client.locale),
        description: d.comment ?? null,
        deal: DEAL_BY_ID[d.deal_type_id] ?? d.deal_type_id,
        estate: ESTATE_BY_ID[d.real_estate_type_id] ?? d.real_estate_type_id,
        building: STATUS_BY_ID[d.status_id] ?? d.status_id,
        price: money(d.price),
        price_negotiable: d.price_negotiable ?? null,
        area_m2: d.area ?? null,
        yard_area: d.yard_area ?? null,
        rooms: ROOM_COUNT_BY_TYPE[d.room_type_id] ?? d.room_type_id ?? null,
        bedrooms: d.bedroom_type_id ?? null, // bedroom_types 1:1 с количеством
        floor: d.floor ?? null,
        floors_total: d.total_floors ?? null,
        ceiling_height: d.height || null,
        condition: d.condition ?? null,
        address: {
          city: d.city_name ?? null,
          district: d.district_name ?? null,
          urban: d.urban_name ?? null,
          street: d.address?.trim() || null,
          street_id: d.street_id ?? null,
        },
        lat: d.lat ?? null,
        lon: d.lng ?? null,
        cadastral_code: d.rs_code ?? null,
        amenities: params,
        views: d.views ?? null,
        owner_type: d.user_type?.type ?? null,
        owner_name: d.owner_name ?? null,
        phone: d.user_phone_number ?? null, // livo отдаёт его частично замаскированным
        user_id: d.user_id ?? null,
        user_statements_count: d.user_statements_count ?? null,
        project_uuid: d.project_uuid ?? null,
        images: (d.images ?? []).map((i) => i.large),
        published: d.created_at ?? null, // настоящая дата публикации
        updated: d.last_updated ?? null, // правка или платное поднятие, НЕ публикация
        is_active: d.is_active ?? null,
        freshness_note: FRESHNESS_NOTE,
      };
      if (with_similars)
        out.similars = (await client.similars(id, { per_page: 10 })).map((it) => card(it, client.locale));
      return ok(out);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "geo",
  {
    title: "Справочник локаций",
    description:
      "Города, районы и микрорайоны с id. search() принимает названия и резолвит их сам; " +
      "этот инструмент — посмотреть доступное или снять неоднозначность. С параметром " +
      "query работает как автодополнение сайта и возвращает готовую связку city/district/urban.",
    inputSchema: {
      city: z
        .union([z.string(), z.number()])
        .optional()
        .describe("город: вернуть его районы и микрорайоны. Без него — список городов"),
      query: z.string().optional().describe("свободный текст: автодополнение локаций livo"),
    },
  },
  async ({ city, query }) => {
    try {
      if (query) {
        const s = await client.suggest(query);
        return ok({
          query,
          matches: (s ?? []).map((x) => ({
            path: x.locations,
            level: x.find_point,
            ids: x.identifiers,
            lat: x.lat,
            lon: x.lng,
          })),
        });
      }
      const idx = await geoIndex(client);
      if (!city)
        return ok({
          cities: idx.cities.map((c) => ({
            id: c.id,
            name: c.name,
            districts: idx.districts.filter((d) => d.city_id === c.id).length,
          })),
          note: "Названия принимаются на любом из трёх языков сайта (ka/en/ru).",
        });
      const c = await resolveCity(client, city);
      const districts = idx.districts.filter((d) => d.city_id === c.id);
      return ok({
        city: c.name,
        city_id: c.id,
        districts: districts.map((d) => ({
          district_id: d.id,
          district: d.name,
          urbans: idx.urbans
            .filter((u) => u.district_id === d.id)
            .map((u) => ({ id: u.id, name: u.name, streets: u.streets })),
        })),
        note:
          "districts и urbans — два независимых параметра фильтра, не смешивай их. " +
          "Таксономия livo отдана как есть.",
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "reference",
  {
    title: "Справочники значений",
    description:
      "Словари id -> название для фильтров, которые принимают только id: conditions, " +
      "project_types, heating_types, material_types, metro_stations, amenities и др. " +
      "Большинство словарей разбиты по типу недвижимости — укажи estate, чтобы получить " +
      "только применимые значения. Названия приходят на языке сервера (LIVO_LOCALE).",
    inputSchema: {
      groups: z
        .array(z.enum([...REFERENCE_GROUPS, "amenities"]))
        .describe(
        "какие словари вернуть; 'amenities' — удобства с устойчивыми ключами. " +
          "Локации сюда не входят — за ними geo()",
      ),
      estate: z
        .enum(["flat", "house", "cottage", "land", "commercial", "hotel"])
        .optional()
        .describe("оставить только значения, применимые к этому типу недвижимости"),
    },
  },
  async ({ groups, estate }) => {
    try {
      const out = {};
      const estateId = estate ? ESTATE_TYPES[estate] : null;
      for (const g of groups) {
        if (g === "amenities") {
          let list = await amenityCatalog(client);
          if (estateId) list = list.filter((x) => x.estate_types.includes(estateId));
          out.amenities = list.map(({ estate_types, ...rest }) => rest);
          continue;
        }
        const p = await client.parameters();
        let v = p[g];
        // часть словарей — объект, ключ = id типа недвижимости
        if (v && !Array.isArray(v) && estateId != null) v = v[String(estateId)] ?? {};
        out[g] = v ?? null;
      }
      return ok(out);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "projects",
  {
    title: "Новостройки (проекты застройщиков)",
    description:
      "Проекты застройщиков — отдельный набор данных livo, не подмножество объявлений. " +
      "min_price приходит диапазоном и в трёх валютах. С параметром uuid возвращает " +
      "карточку одного проекта.",
    inputSchema: {
      uuid: z.string().optional().describe("uuid проекта — вернуть одну карточку"),
      city: z.union([z.string(), z.number()]).optional().describe("город: название или id"),
      areas: z
        .array(z.union([z.string(), z.number()]))
        .optional()
        .describe("районы и микрорайоны по названию или id"),
      limit: z.number().int().min(1).max(50).default(20).describe("сколько проектов вернуть"),
      page: z.number().int().min(1).default(1).describe("страница"),
    },
  },
  async ({ uuid, city, areas, limit, page }) => {
    try {
      if (uuid) return ok(await client.project(uuid));
      const params = { page, per_page: limit };
      const echo = {};
      let cityId = null;
      if (city != null && city !== "") {
        const c = await resolveCity(client, city);
        cityId = c.id;
        params.cities = c.id;
        echo.city = `${c.name} (${c.id})`;
      }
      if (areas?.length) {
        const r = await resolveAreas(client, areas, cityId);
        if (r.districts.length) params.districts = r.districts;
        if (r.urbans.length) params.urbans = r.urbans;
        echo.areas = r.labels;
      }
      const d = await client.projects(params);
      return ok({
        query: echo,
        total: d.total,
        page: d.current_page,
        returned: (d.data ?? []).length,
        applied_filters: d.seo?.filters ?? null,
        projects: (d.data ?? []).map((p) => ({
          uuid: p.uuid,
          name: p.display_name,
          url: `https://livo.ge/proeqti/${p.slug}`,
          city: p.city,
          district: p.district,
          urban: p.urban,
          street: p.street,
          building_status: p.building_status,
          sale_terms: p.sale_terms,
          developer: p.developer?.name ?? null,
          min_price: p.min_price ?? null,
          statements: p.grouped_statements ?? null,
        })),
        note:
          "Дат публикации и обновления у проектов нет вовсе — оценить свежесть цен " +
          "по этому источнику нельзя. min_price — диапазон, ключи 1/2/3 = GEL/USD/EUR.",
      });
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
