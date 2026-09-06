# livo.ge - реверс-инжиниринг API (для оформления в MCP)

Разобрано 2026-09-06. Всё ниже проверено живыми запросами, не выведено из кода.
Публичного/документированного API нет. Схема восстановлена из бандлов Next.js
(`livo.ge/_next/static/chunks/*.js`) плюс эмпирическая проверка каждого фильтра
счётчиком.

## 1. Как всё устроено

| | |
|---|---|
| Фронт | Next.js App Router, страница выдачи - `/s`, карточка - `/udzravi-qoneba/...` |
| API объявлений | `https://api-statements.tnet.ge` |
| API локаций | `https://api-locations.tnet.ge` |
| Базовый путь | `/v1/...` для объявлений, `/v2/...` для локаций, `/api/tnet-projects/...` для новостроек |
| Авторизация | **нет**. Ни токена, ни куки |
| Обязательный заголовок | `X-Website-Key: livo` - без него HTTP 403 `{"errors":{"message":["X-Website-Key is required"]}}` |
| Локаль | заголовок `locale: ka \| en \| ru` - переводит **данные** (город, район, состояние, заголовок), не только UI |
| robots.txt | `livo.ge` запрещает только `/admin/login.php`; на обоих API-хостах `Disallow:` пуст |

Livo - витрина группы tnet (myhome.ge, myauto.ge, mymarket.ge …). Данные лежат
на общем бэкенде; принадлежность к витрине задаёт `X-Website-Key`.

Клиент найден в чанке как axios-инстанс:

```js
axios.create({
  baseURL: "https://api-statements.tnet.ge/",
  headers: { "X-Website-Key": "livo" },
  paramsSerializer: e => qs.stringify(e, { arrayFormat: "comma",
    filter: (k, v) => typeof v === "boolean" ? +v : (v != null && v !== "" ? v : undefined) }),
});
// setLanguageHeader -> http.defaults.headers.locale = e
```

Отсюда правила сериализации: **массивы через запятую** (`urbans=38,47`),
**booleans как 1/0**, пустые строки и null не отправляются вовсе.

### X-Website-Key выбирает витрину, и витрины не равны

Один и тот же запрос `count?cities=1&deal_types=1`:

| ключ | total |
|---|---|
| `livo` | 53 698 |
| `myhome` | 94 116 |
| любой неизвестный | 53 698 (падает в дефолт = livo) |

**Livo показывает подмножество инвентаря tnet.** Это устройство портала, и об этом
надо говорить пользователю, если он считает livo полным охватом рынка Грузии.

## 2. Эндпоинты

| Метод | Путь | Что отдаёт |
|---|---|---|
| GET | `/v1/statements` | страница выдачи. **Без общего количества** |
| GET | `/v1/statements/count` | пагинация по тому же фильтру: `total`, `last_page`, … |
| GET | `/v1/statements/{id}` | полная карточка, в т.ч. `created_at` |
| GET | `/v1/statements/similars/{id}` | похожие (подбор livo, критерии не публикуются) |
| GET | `/v1/statements/statement-parameters` | все справочники одним ответом, **4.5 МБ** |
| GET | `/api/tnet-projects/listing` | новостройки (проекты застройщиков) |
| GET | `/api/tnet-projects/{uuid}` | карточка проекта |
| GET | `{locations}/v2/cities` | город → район → микрорайон → улицы, **4.1 МБ** |
| GET | `{locations}/v2/suggestions?q=` | автодополнение, отдаёт готовую связку id |
| GET | `{locations}/v2/streets/grouped` | улицы по `cities`/`districts`/`urbans` |
| POST | `/v1/statements/phone/show` | полный телефон (в выдаче он замаскирован) |

Ответ всегда обёрнут: `{"result": true, "data": …}`. При прикладной ошибке приходит
HTTP 200 с `result:false` и `errors`.

## 3. Параметры фильтра

Полный список снят с nuqs-парсера URL страницы `/s` - имена параметров URL и API
совпадают один в один.

```
q  page  per_page
deal_types  real_estate_types  rent_types  daily_rent_types
cities  districts  urbans  streets  metro_station_ids
currency_id  price_from  price_to  price_types  square_price_from  square_price_to
area_types  area_from  area_to
floor_from  floor_to  height_from  height_to
statuses  conditions  project_types
room_types  bedroom_types  bathroom_types  living_room_types
storeroom_types  parking_types  heating_types  hot_water_types
material_types  door_window_types
parameters  owner_type  users
has_balcony  has_loggia  has_porch  loggia_area
with_3d  has_cadastral_code  can_exchanged  is_super_vip
order_by  sequence  sorting
```

Каждый из них проверен счётчиком: `count(cities=1, deal_types=1, real_estate_types=1)`
= 43 941, и добавление любого фильтра это число меняет.

### Перечисления

```
deal_types        1 sale, 2 rent, 3 lease, 7 daily, 10 will_be_leased (живых нет)
real_estate_types 1 flat, 2 house, 3 cottage, 4 land, 5 commercial, 6 hotel
statuses          1 old building, 2 new building, 3 under construction
                  (+ 4,5,6,7,18,30 - категории земли и коммерции)
currency_id       1 GEL, 2 USD                       (EUR в фильтре НЕТ)
area_types        1 m², 2 га
price_types       1 полная цена, 2 цена за м²
owner_type        physical | broker | agency | developer   (строки, не id)
order_by          price | date        sequence  asc | desc
sorting           1 price↑, 2 price↓, 3 date↑, 4 date↓ (дублирует пару выше)
```

Остальные словари (`conditions`, `project_types`, `heating_types`, `material_types`,
`parameters` …) - только id, берутся из `/v1/statements/statement-parameters`.
Часть словарей там - объект, ключ = `real_estate_type_id`.

У удобств (`parameters`) есть устойчивый английский ключ `svg_file_name`
(`elevator`, `conditioner`, `guard`, `swimming-pool-open`, `pets-allowed` …) -
он не меняется от `locale` и годится как канонический идентификатор.

## 4. Грабли

### 4.1. Неизвестные параметры игнорируются молча

```
count(cities=1, deal_types=1, real_estate_types=1)                      -> 43941
count(cities=1, deal_types=1, real_estate_types=1, nonsense_field=42)   -> 43941
```

Опечатка в имени поля не даёт ни ошибки, ни предупреждения - просто выдача
оказывается неотфильтрованной. Поэтому клиент сверяет фильтр с белым списком
и падает сам.

### 4.2. Выдача не знает своего размера

`/v1/statements` не содержит ни `total`, ни `last_page` - только массив.
Количество даёт **отдельный** запрос `/v1/statements/count` с тем же фильтром.

### 4.3. `seo.filters` - эхо разбора

И `/v1/statements`, и `/api/tnet-projects/listing` возвращают `seo.filters` -
то, что API реально разобрал из query:

```json
"seo": {"filters": {"cities": [1], "urbans": [38], "deal_types": [1],
                    "real_estate_types": [1], "room_types": [2,3], "districts": [], …}}
```

Полезно как канал проверки: если фильтровал по району, а в эхе пусто - не применилось.
Эхо покрывает только локацию, типы и комнаты; цену, площадь и удобства оно не отражает.

### 4.4. `last_updated` - не дата публикации

Главная ловушка источника.

| id | `created_at` | `quantity_of_day` | `last_updated` |
|---|---|---|---|
| 18826955 | 2024-07-22 | 776 | **2026-09-06** |
| 24616406 | 2026-05-02 | 127 | **2026-09-06** |
| 25915509 | 2026-09-01 | 5 | 2026-09-01 |

`last_updated` меняется от любой правки и от платного поднятия, поэтому у объявления
двухлетней давности он сплошь и рядом "сегодня".

Настоящий возраст даёт **`quantity_of_day`** - разница в календарных днях между
сегодня и датой публикации. Проверено на выборке: сходится с `created_at` из карточки
объявления день в день. Дата публикации = `сегодня - quantity_of_day`.

`created_at` приходит только в `/v1/statements/{id}`; в выдаче его нет.

### 4.5. Сортировка не применяется ко всей выдаче

Платные тиры закреплены **над** сортировкой, и это не обходится параметрами.
Батуми, `order_by=date`, первые 12 карточек:

| # | sequence=asc | sequence=desc |
|---|---|---|
| 1 | `super_vip`, upd 09-04 | `super_vip`, upd 09-04 |
| 2-3 | `vip_plus`, upd 09-05 / 09-06 | `vip_plus`, upd 09-06 / 09-05 |
| 4-7 | `vip`, upd 09-05…09-06 | `vip`, upd 09-06…09-05 |
| 8+ | обычные, upd 2025-09-18 → … | обычные, upd 09-06 12:28 → … |

Порядок тиров: `is_super_vip` → `is_vip_plus` → `is_vip` → обычные, и только внутри
каждого тира работает заданная сортировка. Первые 5-10 позиций почти любой страницы
куплены.

**Кроме того, `order_by=date` сортирует по `last_updated`, а не по дате публикации.**
Объявление 2023 года, поднятое сегодня, встанет выше вчерашнего: в тесте по Ваке
`sequence=desc` дал подряд `age_days` = 0, **4**, 0, 0, 0 - вторая позиция это
`vip_plus` четырёхдневной давности, поднятый только что.

Единственный надёжный признак свежести - `quantity_of_day`.

### 4.6. Списочные фильтры - ИЛИ, и для удобств это ловушка

```
count(deal_types=2, real_estate_types=1, cities=1, urbans=47)                  -> 35681
count(…, parameters=6)              # лифт                                     -> 13832
count(…, parameters=6,4)            # лифт + кондиционер                       -> 18806
```

Больше, а не меньше. Для `room_types` такое поведение ожидаемо, а для `parameters`
нет: "с лифтом И кондиционером" через этот API одним запросом не выражается.

### 4.7. `room_types` - словарь, а не количество комнат

```
id  1  2  3  4  5  7  8  9  10  11
шт  1  2  3  4  5  6  7  8   9  10+
```

id 6 отсутствует вовсе, дальше пятёрки id и число комнат расходятся. Наивное
`room_types=6` отфильтрует семикомнатные. `bedroom_types`, наоборот, 1:1
с количеством спален (1…10, где 10 = "10+"). В карточке выдачи поля `room`
и `bedroom` - уже человеческие значения, а в `/v1/statements/{id}` лежат
`room_type_id` / `bedroom_type_id`, то есть id словаря.

### 4.8. Цена

`price_from`/`price_to` трактуются в валюте `currency_id`, **по умолчанию GEL**.
Цена за метр - это отдельная пара `square_price_from`/`square_price_to`, а не
`price_types` при той же паре. В ответе цена приходит сразу в трёх валютах:

```json
"price": {"1": {...GEL}, "2": {...USD}, "3": {...EUR}}
```

EUR есть только в выдаче; фильтровать по нему нельзя.

### 4.9. Локации: микрорайоны есть практически только у Тбилиси

126 городов, 3041 район, **76 микрорайонов** - из них 75 в Тбилиси. За пределами
Тбилиси "районы" - это сёла и посёлки муниципалитета, и фильтровать надо через
`districts`, а не `urbans`. id районов и микрорайонов глобально уникальны, так что
город можно не передавать (но лучше передавать).

`/v2/cities` весит 4.1 МБ, потому что тащит в себе все сгруппированные улицы.
Группа `cities` внутри `statement-parameters` - ещё 4.6 МБ того же самого.

### 4.10. Прочее

* `per_page` не ограничен сверху в разумных пределах: 200 отдаёт 200 объектов.
* Слаг в URL карточки косметический - `https://livo.ge/udzravi-qoneba/x/y-25962557`
  отдаёт 200. Значение имеет только id. Формат:
  `/{locale?}/udzravi-qoneba/{middle_slug}/{href_lang[locale]}-{id}`,
  где `middle_slug` = `{iyideba|qiravdeba|giravdeba|qiravdeba-dghiurad}-{bina|kerdzo-saxli|agaraki|miwis-nakveti|komertsiuli-farti|sastumro}`.
* Телефон в выдаче замаскирован (`568963***`); полный отдаёт POST `/v1/statements/phone/show`.
  Этот эндпоинт в MCP намеренно не заворачивается.
* У новостроек (`/api/tnet-projects/listing`) **нет никаких дат** - ни публикации,
  ни обновления цен. Свежесть цен по этому источнику оценить нельзя. Имена проектов
  и застройщиков приходят по-грузински независимо от `locale`.
* `has_cadastral_code=1` почти ничего не отсекает (43 939 из 43 941) - поле есть
  почти у всех, фильтр практически бесполезен.
* `with_3d=1` по Тбилиси даёт единицы объявлений.

## 5. Темп и вежливость

Авторизации нет, лимитов в ответах не видно, `Retry-After` не встречался.
Обёртка держит 1 запрос/секунду глобально, ходит с честным User-Agent
(`livo-ge-mcp/1.0.0 (+…)`) и не притворяется браузером - проверено, что API
отдаёт данные и без подделки UA. На 403 (кроме "X-Website-Key is required",
это ошибка конфигурации) и на 429 предохранитель размыкается и остаётся
разомкнутым: ретраить блокировку - худшее, что можно сделать.
