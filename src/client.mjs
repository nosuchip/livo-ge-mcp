/**
 * Клиент livo.ge.
 *
 * Публичного API у livo.ge нет; контракт восстановлен реверс-инжинирингом бандлов
 * Next.js и проверен живыми запросами — см. docs/API.md. Зависимостей нет:
 * нативный fetch (Node 20+).
 *
 * Livo — витрина группы tnet (myhome.ge, myauto.ge, ss.ge …). Данные лежат не на
 * livo.ge, а на общем бэкенде tnet; принадлежность к витрине задаёт заголовок
 * X-Website-Key: livo. Без него отвечает тот же бэкенд, но выдача уже не livo.
 */

export const STATEMENTS_API = "https://api-statements.tnet.ge";
export const LOCATIONS_API = "https://api-locations.tnet.ge";
export const SITE = "https://livo.ge";

export const VERSION = "1.0.0";
/** Честный User-Agent: сервер не выдаёт себя за браузер. Проверено — API отдаёт
 *  данные без подделки UA, так что маскироваться незачем. */
export const USER_AGENT = `livo-ge-mcp/${VERSION} (+https://github.com/nosuchip/livo-ge-mcp)`;

export const WEBSITE_KEY = "livo";
export const LOCALES = ["ka", "en", "ru"];

/** id сделок. 10 (WILL_BE_LEASED) объявлен во фронте, но живых объявлений не даёт. */
export const DEAL_TYPES = { sale: 1, rent: 2, lease: 3, daily: 7, will_be_leased: 10 };
export const ESTATE_TYPES = {
  flat: 1, house: 2, cottage: 3, land: 4, commercial: 5, hotel: 6,
};
export const CURRENCY = { GEL: 1, USD: 2 };
/** В ценах карточки есть и третий ключ — "3" (EUR). В фильтре EUR не принимается. */
export const PRICE_CURRENCY_KEYS = { 1: "gel", 2: "usd", 3: "eur" };
export const AREA_TYPES = { m2: 1, ha: 2 };
export const OWNER_TYPES = ["physical", "broker", "agency", "developer"];
/** statuses в фильтре — это состояние постройки, а не статус объявления. */
export const BUILDING_STATUS = { old: 1, new: 2, under_construction: 3 };

/**
 * room_types — это СЛОВАРЬ, а не число комнат: id 1..5 совпадают с количеством,
 * дальше расходятся (id 6 отсутствует вовсе), 7 = «6 комнат», 11 = «10+».
 * Наивное room_types=6 отфильтрует не то, что просили. Снято живьём со
 * /v1/statements/statement-parameters 2026-09-06.
 * bedroom_types, в отличие от них, 1:1 с количеством спален.
 */
export const ROOM_TYPE_BY_COUNT = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 7, 7: 8, 8: 9, 9: 10, 10: 11 };
export const ROOM_COUNT_BY_TYPE = Object.fromEntries(
  Object.entries(ROOM_TYPE_BY_COUNT).map(([count, id]) => [id, Number(count)]),
);

export const ORDER = {
  price_asc: { order_by: "price", sequence: "asc", sorting: 1 },
  price_desc: { order_by: "price", sequence: "desc", sorting: 2 },
  date_asc: { order_by: "date", sequence: "asc", sorting: 3 },
  date_desc: { order_by: "date", sequence: "desc", sorting: 4 },
};

/** Куски человекочитаемого URL объявления: {deal}-{estate}-...-{id}. Слаг косметический
 *  (livo отдаёт 200 на любой), но подставлять мусор незачем. */
const DEAL_SLUG = { 1: "iyideba", 2: "qiravdeba", 3: "giravdeba", 7: "qiravdeba-dghiurad", 10: "giravdeba" };
const ESTATE_SLUG = {
  1: "bina", 2: "kerdzo-saxli", 3: "agaraki", 4: "miwis-nakveti",
  5: "komertsiuli-farti", 6: "sastumro",
};

/**
 * Имена, которые /v1/statements реально понимает. Всё прочее он молча игнорирует
 * и отдаёт НЕотфильтрованную выдачу — то есть опечатка в имени поля выглядит как
 * успешный узкий поиск. Проверено: count с полем nonsense_field возвращает ровно
 * столько же, сколько без него.
 */
export const FILTER_FIELDS = new Set([
  "q", "page", "per_page",
  "deal_types", "real_estate_types", "rent_types", "daily_rent_types",
  "cities", "districts", "urbans", "streets", "metro_station_ids",
  "currency_id", "price_from", "price_to", "price_types",
  "square_price_from", "square_price_to",
  "area_types", "area_from", "area_to",
  "floor_from", "floor_to", "height_from", "height_to",
  "statuses", "conditions", "project_types",
  "room_types", "bedroom_types", "bathroom_types", "living_room_types",
  "storeroom_types", "parking_types", "heating_types", "hot_water_types",
  "material_types", "door_window_types",
  "parameters", "owner_type", "users",
  "has_balcony", "has_loggia", "has_porch", "loggia_area",
  "with_3d", "has_cadastral_code", "can_exchanged", "is_super_vip",
  "order_by", "sequence", "sorting",
]);

/** Группы справочника /v1/statements/statement-parameters. cities там весит 4.6 МБ —
 *  за локациями ходи в geo(), а не сюда. */
export const REFERENCE_GROUPS = [
  "currencies", "room_types", "durations", "statuses", "conditions", "bedroom_types",
  "bathroom_types", "project_types", "hot_water_types", "heating_types", "parking_types",
  "storeroom_types", "living_room_types", "door_window_types", "material_types",
  "deal_types", "daily_rent_types", "statement_parameters", "build_years", "area_types",
  "lease_types", "lease_contract_types", "rent_types", "real_estate_types",
  "metro_stations", "parking_space_types", "basement_type_id",
]; // группы cities здесь намеренно нет: 4.6 МБ локаций, за ними geo()

export class LivoError extends Error {}

/** Открывается на 403/429 и держится открытым: если нас притормозили,
 *  правильная реакция — перестать долбиться, а не ретраить. */
export class CircuitOpenError extends LivoError {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Сериализация параметров ровно как у сайта: qs с arrayFormat "comma",
 * booleans -> 1/0, пустые строки и null выбрасываются.
 */
export function serializeParams(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      usp.set(k, v.join(","));
    } else if (typeof v === "boolean") {
      usp.set(k, v ? "1" : "0");
    } else {
      usp.set(k, String(v));
    }
  }
  return usp.toString();
}

export class Client {
  /**
   * @param {object} [opts]
   * @param {string} [opts.locale]       ka | en | ru — заголовок locale переводит ДАННЫЕ
   * @param {number} [opts.minInterval]  мс между запросами; глобальный темп
   */
  constructor({ locale = "ru", minInterval = 1000 } = {}) {
    if (!LOCALES.includes(locale)) throw new LivoError(`locale должен быть одним из ${LOCALES}`);
    this.locale = locale;
    this.minInterval = minInterval;
    this._queue = Promise.resolve(); // сериализует запросы, чтобы темп был глобальным
    this._lastCall = 0;
    this._circuitOpen = null;
    this._cities = null;
    this._citiesAt = 0;
    this._params = null;
    this._paramsAt = 0;
  }

  /** Все запросы идут через одну очередь — темп соблюдается глобально, а не на вызов. */
  _paced(fn) {
    const run = this._queue.then(async () => {
      const gap = this.minInterval - (Date.now() - this._lastCall);
      if (gap > 0) await sleep(gap);
      try {
        return await fn();
      } finally {
        this._lastCall = Date.now();
      }
    });
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async _call(base, path, params = {}) {
    if (this._circuitOpen)
      throw new CircuitOpenError(
        `livo.ge ответил ${this._circuitOpen.status} и предохранитель разомкнут. ` +
          `Это не сетевой сбой — нас притормозили. Не повторяй запрос, ` +
          `скажи пользователю попробовать существенно позже.`,
      );

    const qs = serializeParams(params);
    const url = base + path + (qs ? `?${qs}` : "");

    const res = await this._paced(() =>
      fetch(url, {
        headers: {
          "X-Website-Key": WEBSITE_KEY, // без него бэкенд отдаёт выдачу другой витрины tnet
          locale: this.locale,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(60_000),
      }),
    );

    if (!res.ok) {
      // 403 бэкенд отдаёт и на отсутствующий X-Website-Key — это конфиг, а не блокировка,
      // и размыкать из-за него предохранитель нельзя
      if (res.status === 403) {
        const text = await res.text();
        if (text.includes("X-Website-Key"))
          throw new LivoError(`GET ${path} -> HTTP 403: ${text.slice(0, 200)}`);
        this._circuitOpen = { status: 403, at: Date.now() };
        throw new CircuitOpenError(
          `livo.ge ответил 403. Предохранитель разомкнут и останется таким: ` +
            `повторять запросы нельзя, попробовать стоит сильно позже.`,
        );
      }
      if (res.status === 429) {
        this._circuitOpen = { status: 429, at: Date.now() };
        throw new CircuitOpenError(
          `livo.ge ответил 429. Предохранитель разомкнут и останется таким: ` +
            `повторять запросы нельзя, попробовать стоит сильно позже.`,
        );
      }
      const text = (await res.text()).slice(0, 400);
      throw new LivoError(`GET ${path} -> HTTP ${res.status}: ${text}`);
    }
    const body = await res.json();
    // Обёртка {result, data}; result:false — прикладная ошибка при HTTP 200
    if (body && body.result === false)
      throw new LivoError(`GET ${path}: API вернул result:false — ${JSON.stringify(body).slice(0, 300)}`);
    return body?.data ?? body;
  }

  /**
   * Собирает и проверяет query. Ловит ошибку, которую сам API не ловит:
   * неизвестное имя поля молча игнорируется, и запрос выглядит отфильтрованным,
   * не будучи им.
   */
  static buildFilter(input) {
    const f = {};
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v) && !v.length) continue;
      f[k] = v;
    }
    const unknown = Object.keys(f).filter((k) => !FILTER_FIELDS.has(k));
    if (unknown.length)
      throw new LivoError(
        `API молча проигнорирует эти поля и вернёт неотфильтрованный результат: ` +
          `${unknown.join(", ")}.`,
      );
    if (("price_from" in f || "price_to" in f || "square_price_from" in f ||
         "square_price_to" in f) && !("currency_id" in f))
      f.currency_id = CURRENCY.USD; // иначе цена трактуется в лари
    return f;
  }

  /**
   * Страница выдачи. Ответ НЕ содержит общего количества — за ним отдельный
   * запрос в count(). Отдаёт также seo.filters — эхо того, что API реально
   * разобрал из фильтра.
   */
  async search(filter, { page = 1, per_page = 20 } = {}) {
    const d = await this._call(STATEMENTS_API, "/v1/statements", { ...filter, page, per_page });
    return { items: d?.data ?? [], echo: d?.seo?.filters ?? null };
  }

  /** Пагинация целиком: total, last_page, per_page. Один дешёвый запрос. */
  async count(filter) {
    return this._call(STATEMENTS_API, "/v1/statements/count", { ...filter, per_page: 1 });
  }

  /** Полная карточка. Единственное место, где есть created_at — настоящая дата публикации. */
  async listing(id) {
    const d = await this._call(STATEMENTS_API, `/v1/statements/${id}`);
    return d?.statement ?? d;
  }

  /** Похожие объявления — подбор самого livo, критерии подбора не публикуются. */
  async similars(id, { page = 1, per_page = 10 } = {}) {
    const d = await this._call(STATEMENTS_API, `/v1/statements/similars/${id}`, { page, per_page });
    return d?.data ?? [];
  }

  /** Новостройки. Отдельный набор данных, не подмножество объявлений. */
  async projects(params = {}) {
    return this._call(STATEMENTS_API, "/api/tnet-projects/listing", params);
  }

  async project(uuid) {
    return this._call(STATEMENTS_API, `/api/tnet-projects/${uuid}`);
  }

  /** Справочники: id -> название. ~4.6 МБ из-за группы cities, кешируем на процесс. */
  async parameters() {
    if (this._params && Date.now() - this._paramsAt < 6 * 60 * 60 * 1000) return this._params;
    this._params = await this._call(STATEMENTS_API, "/v1/statements/statement-parameters");
    this._paramsAt = Date.now();
    return this._params;
  }

  /** Город -> район -> микрорайон -> сгруппированные улицы. ~4 МБ, кешируем на процесс. */
  async cities() {
    if (this._cities && Date.now() - this._citiesAt < 6 * 60 * 60 * 1000) return this._cities;
    this._cities = await this._call(LOCATIONS_API, "/v2/cities");
    this._citiesAt = Date.now();
    return this._cities;
  }

  /** Автодополнение локаций: возвращает готовую связку city_id/district_id/urban_id. */
  async suggest(q) {
    return this._call(LOCATIONS_API, "/v2/suggestions", { q });
  }

  /** Ссылка на объявление. Слаг косметический, значение имеет только id. */
  static urlOf(item, locale = "ka") {
    const middle =
      item.middle_slug ??
      `${DEAL_SLUG[item.deal_type_id] ?? "iyideba"}-${ESTATE_SLUG[item.real_estate_type_id] ?? "bina"}`;
    const slug = item.href_lang?.[locale] ?? item.dynamic_slug ?? "obieqti";
    const prefix = locale === "ka" ? "" : `/${locale}`;
    return `${SITE}${prefix}/udzravi-qoneba/${encodeURIComponent(middle)}/${encodeURIComponent(slug)}-${item.id}`;
  }
}
