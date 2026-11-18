# Инфраструктура сквозного E2E-тестирования (`TEST_INFRA.md`)

> Спецификация независимого контура браузерной верификации проекта **«ТОЧКА РАЗЛОМА» (`shatterpoint-destruction-sim`)** — трёхмерного физического симулятора и инженерно-тактической игры разрушения сооружений (TypeScript + Vite + Three.js + Rapier3D WASM).

---

## 1. Архитектура среды и конфигурация реального браузера

Сквозные тесты исполняются в настоящем системном браузере Chromium с полноценным аппаратно-независимым контекстом `WebGL2`, реальным трёхмерным рендерером Three.js, процедурным синтезатором Web Audio API и скомпилированным физическим ядром Rust/WASM (`@dimforge/rapier3d-deterministic-compat`).

### Ключевые параметры окружения (`playwright.config.ts`)
- **Браузер**: системный бинарный файл `/usr/lib/chromium/chromium` (`Chromium 156.0.8078.79`).
- **Флаги запуска WebGL2**:
  - `--no-sandbox`
  - `--disable-dev-shm-usage`
  - `--use-gl=angle`
  - `--use-angle=swiftshader`
  - `--enable-unsafe-swiftshader`
  *(Обеспечивают честный `WebGL2` рендеринг через `ANGLE + Vulkan 1.3.0 SwiftShader` без аппаратного GPU).*
- **Защита от `UNIX_PATH_MAX = 108`**: запрещено передавать кастомный длинный `--user-data-dir` (> 80 символов), чтобы путь к Unix-сокету `SingletonSocket` не превышал системный лимит ядра Linux и не вызывал `SIGTRAP` (`exit code 133`). Используются штатные изолированные контексты Playwright.
- **Профиль ресурсов (2 CPU ядра VM)**:
  - `workers: 1`, `fullyParallel: false`, `retries: 0` — исключают конкуренцию нескольких процессов SwiftShader за CPU и маскировку нестабильных проверок.
  - `viewport: { width: 1280, height: 720 }`, `deviceScaleFactor: 1`, `locale: 'ru-RU'` — гарантируют предсказуемую нагрузку на растеризатор и точное совпадение 1:1 между экранными координатами проекции `projectWorldPoint(x, y, z)` и кликами `page.mouse.click(x, y)`.
  - Во всех функциональных тестах (кроме проверок переключения графических пресетов в области `R01`) базовый драйвер после загрузки переводит `#quality-select` в режим `performance` для максимальной скорости кадров на программном растеризаторе.
- **Локальный веб-сервер автотестов (`webServer`) и сетевая изоляция превью (`PROJECT.md §6`)**:
  - Команда E2E dev-сервера: `npm run dev` (`vite --host 0.0.0.0 --port 5175 --strictPort`)
  - Базовый адрес E2E: `http://localhost:5175` (`reuseExistingServer: true`, `timeout: 60000`)
  - Production-превью для проверки сборки: `http://localhost:4175` (`npm run preview`)
  - Поэтапное пользовательское живое превью (`F27`: `v0.1 Alpha` → `v0.2 Beta` → `v1.0 Release`): запускается в фоновом демон-режиме (`IsDaemon: true`) строго на выделенном порту **`http://localhost:5180`**, полностью исключая конфликты портов с Playwright (`5175` и `4175`).

---

## 2. Правила Opaque-Box (Чёрный ящик) и Политика Zero-Mock

E2E-пакет выступает независимым приёмочным барьером качества и подчиняется строгим правилам изоляции от внутренней реализации:

1. **Полный запрет импортов из `src/` и нулевая зависимость от `@types/node`**:
   - Файлам внутри `tests/e2e/**` категорически запрещено импортировать любые модули, классы, константы или типы из `src/**`. Разрешены только импорты из `'@playwright/test'` и локальных помощников `tests/e2e/helpers/*` без обращения к `process`, `Buffer`, `__dirname` или `node:*`.
2. **Абсолютный запрет моков и стабов (Zero-Mock Policy)**:
   - Запрещено подменять или перехватывать `WebGL2RenderingContext`, `THREE`, WASM-модуль Rapier3D, `requestAnimationFrame`, `AudioContext`, `localStorage` или сетевые запросы (`page.route`) искусственными заглушками. Каждое обрушение, взрыв, пожар, пластический изгиб стали и землетрясение обязаны рассчитываться реальным физическим движком в браузере.
3. **Взаимодействие исключительно через пользовательский интерфейс**:
   - Все управляющие воздействия выполняются только действиями пользователя: кликами по DOM-элементам (`#mode-*`, `#tool-*`, `#contract-*`, `#lab-bench-*`, `#time-*`, `#view-*`), выбором значений `<select>`, изменением ползунков `<input type="range">`, реальными событиями мыши (`page.mouse.click`, `down/move/up`, правой кнопкой `button: 'right'`, колесом `page.mouse.wheel`) по канвасу `#sim-canvas` и навигацией браузера (`page.goto`, `page.reload`).
   - Запрещено вызывать внутренние методы движка через `page.evaluate(...)` для прямого спавна блоков, нанесения урона, подрыва или изменения состояния миссии в обход UI.
4. **Строго Read-Only использование диагностического моста `window.__SHATTERPOINT__`**:
   - Публичный контракт `window.__SHATTERPOINT__` (`PROJECT.md`, раздел `Interface Contracts §5`) разрешено вызывать **только для чтения**:
     - `window.__SHATTERPOINT__.getTelemetry()` — чтение объективных физических метрик симуляции и статуса миссии;
     - `window.__SHATTERPOINT__.projectWorldPoint(x, y, z)` — вычисление 2D-координат `{ x, y, visible }` на канвасе для последующего честного клика мышью `page.mouse.click(pt.x, pt.y)`.
5. **Автоматический контроль чистоты консоли и WebGL2 в каждом тесте**:
   - Каждый тест обязан собирать события `pageerror`, сообщения `console` уровня `error`, сбои загрузки модулей/WASM и проверять живость контекста `WebGL2` (`!gl.isContextLost()`). Наличие хотя бы одной необработанной ошибки JS/WASM или потери WebGL-контекста приводит к немедленному падению теста.
6. **Событийная, тиковая и кадровая синхронизация вместо фиксированных задержек**:
   - Категорически запрещено использовать `waitForTimeout`, `setTimeout` и `addInitScript` в тестах и драйвере. Ожидание физических процессов и замер масштаба времени строятся строго через `requestAnimationFrame` (`waitForAnimationFrames`), `expect.poll(...)` и опрос продвижения тика `#app-root[data-sim-tick]` и целевых физических показателей телеметрии.

---

## 3. Канонический контракт DOM-селекторов и телеметрии (`PROJECT.md §5`)

| Подсистема | Обязательные DOM-селекторы и атрибуты |
|---|---|
| **Корневая оболочка и холст** | `#app-root` (`data-ready="true"`, `data-active-mode="campaign\|sandbox\|lab"`, `data-paused="true\|false"`, `data-time-scale="<num>"`, `data-render-mode="pbr\|stress\|xray"`, `data-sim-tick="<int>"`, `data-active-tool="<id>"`, `data-planted-c4="<N>"`, `data-auto-slowmo="true\|false"`, а также опциональные диагностические атрибуты `data-audio-muted`, `data-active-bench`, `data-active-contract`, `data-build-mode`, `data-active-material`), `#sim-canvas` |
| **Переключатели 3 режимов** | `#mode-campaign-btn`, `#mode-sandbox-btn`, `#mode-lab-btn` |
| **Арсенал (6 средств + C4)** | `#tool-cannon`, `#tool-c4`, `#tool-bomb`, `#tool-cutter`, `#tool-incendiary`, `#tool-seismic`, `#detonate-c4-btn`, `#c4-delay-select` |
| **Время, рендер, сцена и звук** | `#time-pause-btn`, `#time-step-btn`, `#time-bullet-btn`, `#time-scale-select`, `#view-pbr-btn`, `#view-stress-btn`, `#view-xray-btn`, `#scene-reset-btn`, `#quality-select`, `#audio-mute-btn` |
| **Свободная Песочница и материалы** | `#sandbox-spawn-select`, `#sandbox-spawn-btn`, `#sandbox-build-toggle`, `#mat-reinforced_concrete`, `#mat-glass`, `#mat-wood`, `#mat-steel`, `#mat-brick`, `#mat-explosive` |
| **Физическая Лаборатория-полигон** | `#lab-bench-materials`, `#lab-bench-ballistics`, `#lab-bench-blast`, `#lab-bench-seismic`, `#slider-gravity`, `#slider-joint-strength`, `#slider-secondary-dmg`, `#slider-blast-falloff`, `#slider-fire-rate`, `#slider-quake-freq-hz`, `#slider-quake-amp`, `#btn-trigger-quake` |
| **Индикаторы телеметрии (`data-value`)** | `#telemetry-destruction-pct`, `#telemetry-intact-joints`, `#telemetry-rebar-links`, `#telemetry-burning-nodes`, `#telemetry-max-temp-c`, `#telemetry-kinetic-kj`, `#telemetry-fps` |
| **Кампания миссий (8 контрактов)** | `#contract-01` .. `#contract-08`, `#mission-budget-remaining`, `#mission-target-progress`, `#mission-collateral-pct`, `#mission-result-panel` (`data-mission-status="planning\|running\|victory\|defeat"`, `data-fail-reason="none\|collateral\|budget_exhausted"`, `data-stars="0\|1\|2\|3"`), `#mission-stars` |
| **Магазин и Мастерская (`F24` / `R11`)** | `#wallet-credits` (`data-value="<int>"`), `#open-workshop-btn`, `#workshop-modal` (`data-open="true\|false"`), `#close-workshop-btn`, `#buy-extra-ammo-btn`, `#upgrade-cannon-btn`, `#upgrade-c4-btn`, `#upgrade-bomb-btn`, `#upgrade-cutter-btn`, `#upgrade-incendiary-btn`, `#upgrade-seismic-btn` (`data-level="1\|2\|3\|4\|5"`, `data-cost="<int>"`), `#sandbox-upgrade-level-select` |
| **Game Feel HUD и авто-слоу-мо (`F25` / `R11`)** | `#hud-collapsed-tons` (`data-value="<float>"`), `#hud-destruction-score` (`data-value="<int>"`), `#hud-combo-badge` (`data-multiplier="<float>"`), `#tactical-feed` (`data-last-event="<string>"`), `#auto-slowmo-toggle` (`#app-root[data-auto-slowmo="true\|false"]` без перезаписи `data-time-scale`), `#damage-progress-bar`, `#star-threshold-1`, `#star-threshold-2`, `#star-threshold-3` |
| **Секвенсор C4 и триггеры (`F26` / `R12`)** | `#c4-sequencer-panel`, `#c4-sequencer-list` (`data-queue-count="<N>"`) |
| **Диагностический мост Read-Only** | `window.__SHATTERPOINT__.getTelemetry()` (базовая `SimulationTelemetry` + `mode`, `missionStatus`, `collateralPct`, `stars`, `fps`, `drawCalls`, `walletCredits`, `toolLevels`, `collapsedMassTons`, `destructionScore`, `comboMultiplier`, `criticalNodesCount`, `c4SequenceQueue`, `activeTriggersCount`), `window.__SHATTERPOINT__.projectWorldPoint(x, y, z)` |

---

## 4. Структура директории `tests/e2e/` по 5 уровням (Tiers 1–5)

```text
tests/e2e/
├── helpers/
│   └── shatterpoint-harness.ts                              # Opaque-Box драйвер, фикстуры ошибок/WebGL2, проекция 3D->2D, Мастерская и секвенсор C4
├── tier1-features/                                          # Tier 1: Изолированные позитивные тесты фич (>= 5 на R01..R12, 70 тестов >= 68)
│   ├── 01-boot-and-modes.spec.ts                            # R01 + R02 (11 тестов)
│   ├── 02-sandbox-and-materials.spec.ts                     # R03 + R04 (12 тестов)
│   ├── 03-arsenal-tools.spec.ts                             # R05 + R06 (12 тестов)
│   ├── 04-time-xray-telemetry.spec.ts                       # R07 + R08 (11 тестов)
│   ├── 05-lab-and-campaign.spec.ts                          # R09 + R10 (12 тестов)
│   └── 06-progression-juice-sequencer.spec.ts               # R11 + R12 (12 тестов)
├── tier2-boundaries/                                        # Tier 2: Граничные, экстремальные и негативные кейсы (>= 5 на R01..R12, >= 60 всего)
│   ├── 01-boot-and-modes.bounds.spec.ts                     # R01 + R02 (11 тестов)
│   ├── 02-sandbox-and-materials.bounds.spec.ts              # R03 + R04 (11 тестов)
│   ├── 03-arsenal-tools.bounds.spec.ts                      # R05 + R06 (12 тестов)
│   ├── 04-time-xray-telemetry.bounds.spec.ts                # R07 + R08 (>= 10 тестов)
│   ├── 05-lab-and-campaign.bounds.spec.ts                   # R09 + R10 (>= 10 тестов)
│   └── 06-progression-juice-sequencer.bounds.spec.ts        # R11 + R12 (>= 10 тестов)
├── tier3-combinations/                                      # Tier 3: Кросс-фичевые взаимодействия 2–3 подсистем (>= 18 тестов в 4 файлах)
│   ├── 01-structural-rebar-cascade.comb.spec.ts             # Опоры + арматура ЖБ + рентген X-Ray + вторичный каскад и тоннаж (>= 5 тестов)
│   ├── 02-thermal-steel-chainblast.comb.spec.ts             # Огонь + термическое ослабление стали + цепной взрыв и комбо (>= 5 тестов)
│   ├── 03-seismic-bullettime-xray.comb.spec.ts              # Сейсмика Гц + Bullet-Time + рентген X-Ray + константы (>= 4 теста)
│   └── 04-upgrades-sequencer-triggers.comb.spec.ts          # Прокачка Ур. 1→5 + разведка X-Ray + секвенсор C4 + триггеры (>= 5 тестов)
├── tier4-scenarios/                                         # Tier 4: Реалистичные многошаговые пользовательские сессии (>= 8 сценариев в 2 файлах)
│   ├── 01-campaign-and-persistence.scen.spec.ts             # Карьера инженера: контракты, Мастерская Ур. 1→5, секвенсор C4, триггеры, localStorage (>= 4 теста)
│   └── 02-lab-and-sandbox-workflows.scen.spec.ts            # Полный цикл Лаборатория -> Песочница Ур. 5 -> авто-слоу-мо/X-Ray -> сброс (>= 4 теста)
└── tier5-adversarial/                                       # Tier 5: Состязательное укрепление покрытия (создаётся на финальной вехе M5)
```

---

## 5. Полная матрица покрытия фич `F01`–`F27` и функциональных областей `R01`–`R12`

### 5.1. Трассировка всех 27 фич `PROJECT.md` (`F01`–`F27`) к областям `R01`–`R12`

| Фича | Наименование в `PROJECT.md` | Покрывающие области `R` | Наблюдаемый E2E-инвариант в реальном браузере |
|---|---|---|---|
| **F01** | Инфраструктура сборки и тестов | `R01` | Сервер на порту `5175` отдаёт приложение, WASM Rapier3D инициализируется, `#app-root[data-ready="true"]`, `0` ошибок консоли |
| **F02** | Детерминированное ядро `core` | `R01`, `R03`, `R07` | Монотонное приращение `data-sim-tick`, воспроизводимая геометрия сооружений и стабильный баланс объёма/энергии |
| **F03** | Физические профили 5 материалов + взрывчатка | `R04`, `R09` | Различимое поведение `reinforced_concrete`, `glass`, `wood`, `steel`, `brick`, `explosive` в конструкторе и на стенде материалов |
| **F04** | 3D Анизотропный Вороной и пролом брешей | `R03`, `R04`, `R05` | Появление `activeShardCount > 0` при ударе/взрыве без исчезновения соседних целых блоков и без NaN в координатах |
| **F05** | Граф структурной целостности и острова | `R03`, `R08`, `R12` | Покоящееся здание на фундаменте (`destructionPct === 0`), отрыв верхних секций при разрушении нижних опор (`brokenJointCount > 0`) |
| **F06** | 6-DOF решатель напряжений и каскадный снос | `R03`, `R08`, `R12` | Ненулевой `maxStressUtilization` под собственным весом/нагрузкой и каскадное снижение `targetMaxHeightM` при подрыве несущих колонн |
| **F07** | Арматурные тяжи ЖБ и пластика стали | `R04`, `R08` | Рост `activeRebarCount` / `snappedRebarCount` при расколе ЖБ и появление `plasticHingeCount > 0` при перегрузке/нагреве стали |
| **F08** | Вторичный кинетический урон обломков | `R05`, `R10`, `R12` | Увеличение `secondaryImpactsCount > 0` при падении верхних ярусов/противовесов/башен домино и фиксация ущерба соседним зданиям (`protectedDamagePct`) |
| **F09** | Баллистика, ударные волны и цепная детонация | `R05`, `R09`, `R12` | Пробой снарядом `#tool-cannon`, затухание волны `#tool-bomb` с расстоянием/стеной и каскадный рост `detonatedExplosivesCount >= 1` |
| **F10** | Распространение огня и термическое ослабление | `R06`, `R09` | Воспламенение дерева (`burningNodeCount > 0`, `maxTemperatureC >= 260`), передача огня вверх и проседание нагретой стальной балки |
| **F11** | 3D Сейсмоплатформа (Гц и амплитуда) | `R06`, `R09` | Включение `seismicActive === true`, соответствие `seismicFrequencyHz` и `seismicAmplitudeM` ползункам и резонансное разрушение зданий |
| **F12** | Фасад мира `DestructionWorld` и бюджет 60 FPS | `R02`, `R07`, `R09` | Пауза, пошаговый тик `+1`, Bullet-Time `0.05x..2x`, живое применение ползунков констант, запекание руин (`bakedRubbleCount`) и стабильный FPS |
| **F13** | 3D PBR-рендерер с батчингом геометрии | `R01` | Активный `WebGL2` контекст на `#sim-canvas`, непустой отрендеренный кадр, переключение `#quality-select` (`performance`, `high`, `ultra`) и контроль `drawCalls` |
| **F14** | Визуализатор напряжений, тепла и арматуры | `R08`, `R12` | Переключение `#view-pbr-btn`, `#view-stress-btn`, `#view-xray-btn` с обновлением `data-render-mode="pbr\|stress\|xray"` и визуальным различием кадра |
| **F15** | Частицы разрушения (VFX) и 3D-камера | `R02`, `R05` | Орбитальное вращение, панорамирование и зум камеры на `#sim-canvas` (с изменением экранной проекции `projectWorldPoint`), VFX без просадок и ошибок |
| **F16** | Многослойный процедурный звук Web Audio | `R02`, `R07` | Переключение `#audio-mute-btn`, разблокировка по клику пользователя и смена масштаба времени без ошибок `AudioContext` |
| **F17** | Каталог 6 типов зданий и конструктор | `R03`, `R04` | Спавн всех 6 чертежей зданий в Песочнице и ручная достройка блоками всех 5 конструкционных материалов + бочек `explosive` |
| **F18** | Интерактивный арсенал из 6 средств | `R05`, `R06`, `R12` | Работоспособность каждого из 6 инструментов (`cannon`, `c4` с секвенсором задержек и детонатором, `bomb`, `cutter`, `incendiary`, `seismic`) |
| **F19** | Режим «Кампания миссий» (8 контрактов) | `R10`, `R11` | Выбор всех 8 контрактов `#contract-01`..`#contract-08`, контроль бюджета, целевого сноса, штрафа за `protected`, расчёт 1–3 звёзд и сохранение в `localStorage` |
| **F20** | Режим «Свободная Песочница» | `R03`, `R04`, `R07`, `R11` | Свободный спавн нескольких сооружений, достройка, открытый арсенал с выбором Ур. 1–5, Bullet-Time, рентген напряжений и `#scene-reset-btn` |
| **F21** | Режим «Физическая Лаборатория-полигон» | `R09` | 4 калиброванных стенда (`materials`, `ballistics`, `blast`, `seismic`), 7 инженерных ползунков констант и живая телеметрия |
| **F22** | Русскоязычный Vanilla CSS UI и мост E2E | `R01`, `R02`, `R08`, `R10`, `R11` | 100% кириллический интерфейс, отсутствие фиолетовой палитры (`No Purple`), наличие всех обязательных DOM `id`/`data-*` и моста `window.__SHATTERPOINT__` |
| **F23** | Приёмка 100% E2E (Tiers 1–4) и Tier 5 Hardening | `R01`–`R12` | 100% зелёное прохождение всех 18 файлов уровней Tiers 1–4 (`>= 154` теста) без единого фейла/ретрая и состязательное расширение Tier 5 на вехе M5 |
| **F24** | Экономика, Магазин и Мастерская улучшений (A1) | `R11` | Начисление `#wallet-credits`, открытие `#workshop-modal`, покупка `#buy-extra-ammo-btn`, прокачка `#upgrade-*-btn` Ур. `1→5` с `localStorage` и `#sandbox-upgrade-level-select` в Песочнице |
| **F25** | Сочный Game Feel: тоннаж, комбо и авто-слоу-мо (A2) | `R11` | Живой тоннаж `#hud-collapsed-tons`, счёт `#hud-destruction-score`, комбо `#hud-combo-badge`, лента `#tactical-feed`, контролируемый `#auto-slowmo-toggle` и пороги `#star-threshold-1..3` |
| **F26** | Секвенсор подрыва C4, разведка узлов и триггеры (A3) | `R12` | Индикация критических опор (`criticalNodesCount > 0`), программируемая очередь `#c4-sequencer-list[data-queue-count]` (`c4SequenceQueue`) и интерактивные триггеры (`activeTriggersCount`) |
| **F27** | Поэтапное живое превью (`v0.1 Alpha` → `v0.2 Beta` → `v1.0`) | Инфраструктура / `R01` | Фоновый демон живого превью (`IsDaemon: true`) на выделенном порту `:5180` без конфликта с портами автотестов `:5175` и `:4175` |

### 5.2. Матрица распределения функциональных областей `R01`–`R12` по уровням Tiers 1–4

| Область | Описание функциональной области | Tier 1: Позитивные фичи (`>= 5` / область) | Tier 2: Границы и негатив (`>= 5` / область) | Tier 3: Комбинации (`>= 18` всего) | Tier 4: Сквозные сессии (`>= 8` всего) |
|---|---|---|---|---|---|
| **R01** | Инициализация, WebGL2, пресеты качества и русский UI (`No Purple`) | Загрузка `data-ready`, WebGL2, кириллица, аудит цветов без фиолетового, пресеты `performance`/`high`/`ultra` | Быстрое переключение пресетов под нагрузкой, ресайз окна, контроль потолка `drawCalls`, отсутствие англоязычных заглушек и `NaN`, двойной `reload` | Участвует как базовый контроль рендера во всех `01..04-*.comb.spec.ts` | Полный цикл сессий без деградации FPS и без единой ошибки консоли |
| **R02** | Навигация по 3 режимам, 3D-камера, сброс сцены и Web Audio | Переходы `campaign`/`sandbox`/`lab`, орбита и зум камеры, `#scene-reset-btn`, `#audio-mute-btn` | Многократное быстрое переключение режимов во время взрыва/пожара, экстремальный зум/углы камеры, идемпотентный тройной сброс и mute/unmute | Смена ракурса и сброс между комбинированными испытаниями | Переход между всеми 3 режимами в рамках единой исследовательской сессии (`02-lab-and-sandbox-workflows.scen.spec.ts`) |
| **R03** | Песочница: 6 архитектурных сооружений и структурное равновесие | Статический покой на фундаменте, спавн всех 6 чертежей зданий, отрыв секции и гравитационный обвал при сносе опор | Выстрел мимо в небо, мульти-спавн с квотой осколков, устойчивость арки/крепости, слабый удар по парапету, очистка мульти-спавна | `01-structural-rebar-cascade.comb.spec.ts`: каскад домино + снос опор башни + ударная волна | Постройка и направленный снос высотного объекта в `02-lab-and-sandbox-workflows.scen.spec.ts` |
| **R04** | Конструктор достройки и физика 5 материалов + взрывчатки | Тоггл конструктора, укладка всех 6 типов блоков, арматура ЖБ, хрупкое стекло, горючее дерево, пластика стали, кирпич и бочка | Переключение конструктора без клика, отказ укладки в небо, выход при выборе оружия, сталь vs стекло Ур. 1, разнесённые бочки | `01..02-*.comb.spec.ts`: композитные узлы ЖБ+сталь+дерево+бочки | Ручное усиление/минирование конструкции блоками в `02-lab-and-sandbox-workflows.scen.spec.ts` |
| **R05** | Арсенал: Кинетическая пушка, C4 с задержкой и Фугас/Метеорит | Выстрел пушки, закладка C4, выбор задержки `#c4-delay-select`, подрыв `#detonate-c4-btn`, ударная волна `#tool-bomb` и вторичный урон | Нажатие `#detonate-c4-btn` при `0` зарядов, клик C4/пушки/фугаса в небо, затухание Садовского, экранирование стеной, полное снятие C4 ПКМ | `01..02, 04-*.comb.spec.ts`: серия C4 с каскадными задержками + цепная детонация бочек | Пошаговое минирование ярусов здания в Кампании (`01-campaign-and-persistence.scen.spec.ts`) |
| **R06** | Арсенал: Плазморезак, Термитная кассета и Сейсмогенератор | Резка узлов `#tool-cutter`, поджог дерева `#tool-incendiary`, термическое ослабление стали, запуск землетрясения `#tool-seismic` | Луч резака и термит в небо, негорючесть ЖБ/кирпича против дерева, авто-завершение и сброс землетрясения, тушение пожара при сбросе | `02-thermal-steel-chainblast.comb.spec.ts`, `03-seismic-bullettime-xray.comb.spec.ts` | Комбинированный термическо-сейсмический тест на полигоне (`02-lab-and-sandbox-workflows.scen.spec.ts`) |
| **R07** | Управление временем: Пауза, Пошаговый тик и Bullet-Time | Пауза (`data-paused="true"`), заморозка тика, одиночный шаг `#time-step-btn` (`+1` тик), Bullet-Time и `#time-scale-select` | Пакетная серия 5 шагов `#time-step-btn`, крайние масштабы `0.05x` и `2x`, Bullet-Time на паузе без срыва паузы, согласованность при сбросе | `03-seismic-bullettime-xray.comb.spec.ts`: Bullet-Time и пошаговый разбор в момент разрыва арматуры | Замедленная инспекция фазы обрушения в `01..02-*.scen.spec.ts` |
| **R08** | Инженерный визуализатор (`PBR`, `Stress`, `X-Ray`) и телеметрия | Режимы `pbr`, `stress`, `xray`, обновление всех 7 DOM-метрик `data-value` и синхронность с `window.__SHATTERPOINT__.getTelemetry()` | Переключение `pbr`/`stress`/`xray` на паузе и в пике взрыва, проверка отсутствия `NaN`/`Infinity`/отрицательных значений в `35+` метриках | `01, 03, 04-*.comb.spec.ts`: рентген арматуры, напряжений и критических опор | Инженерная диагностика слабых опор перед закладкой зарядов в `01-campaign-and-persistence.scen.spec.ts` |
| **R09** | Физическая Лаборатория: 4 стенда и 7 ползунков констант | Переключение 4 стендов (`materials`, `ballistics`, `blast`, `seismic`), реакция симуляции на изменение ползунков гравитации, прочности, огня и Гц/амплитуды | Экстремумы ползунков (`gravity = 0` невесомость vs `30`, `secondaryDamage = 0`, `fireRate = 0`, границы частоты `0.5..15 Гц`), сброс стенда | `03-seismic-bullettime-xray.comb.spec.ts`: вариация физических констант на калибровочных стендах | Серия сравнительных лабораторных экспериментов в `02-lab-and-sandbox-workflows.scen.spec.ts` |
| **R10** | Кампания миссий: 8 контрактов, бюджет, охраняемые зоны и `localStorage` | Загрузка всех `#contract-01`..`#contract-08`, расходование бюджета, выполнение целевого сноса, получение звёзд и сохранение в `localStorage` | Провал при повреждении охраняемого здания (`collateral`), провал при исчерпании бюджета (`budget_exhausted`), перезапуск миссии и `reload` | `04-upgrades-sequencer-triggers.comb.spec.ts`: направленный завал мимо охраняемого здания | Полное прохождение контрактов с переигровкой и проверкой `reload` (`01-campaign-and-persistence.scen.spec.ts`) |
| **R11** | Экономика, Магазин, Мастерская Ур. 1→5 и Game Feel (`F24`, `F25`) | Заработок `#wallet-credits`, прокачка Ур. `1→2` с `localStorage`, `#buy-extra-ammo-btn`, `#sandbox-upgrade-level-select`, тоннаж/комбо/лента, `#auto-slowmo-toggle` и пороги звёзд | Отказ покупки при дефиците кредитов, потолок прокачки Ур. `5`, отключение `#auto-slowmo-toggle`, границы комбо и тоннажа при сбросе сцены | `01, 02, 04-*.comb.spec.ts`: оружие Ур. 5 + тоннаж + комбо цепных реакций + тактическая лента | Полный экономический цикл заработка и прокачки в Мастерской с `reload()` (`01-campaign-and-persistence.scen.spec.ts`) |
| **R12** | Секвенсор подрыва C4, разведка узлов и объекты-триггеры (`F26`) | Критические опоры (`criticalNodesCount > 0`), очередь `#c4-sequencer-list[data-queue-count]`, редактирование задержек, направленный завал, триггеры-резервуары/противовесы/домино | Пустой секвенсор (`queue-count="0"`), очистка очереди при снятии C4 ПКМ и `#scene-reset-btn`, граничные тайминги и защита от повторного срабатывания триггеров | `04-upgrades-sequencer-triggers.comb.spec.ts`: разведка X-Ray + секвенсор по долям секунды + подвешенный противовес | Тактическое планирование каскадного подрыва и триггеров на миссиях и полигоне (`01..02-*.scen.spec.ts`) |

---

## 6. Команды запуска и регламент поуровневой приёмки

### Основные команды
```bash
# Полный прогон всех E2E-тестов
npm run test:e2e

# Проверка синтаксиса, конфигурации и дерева тестов без открытия браузера
npx playwright test --list

# Полный тестовый конвейер проекта (модульные/интеграционные Vitest + браузерные Playwright)
npm test
```

### Поуровневый гейт верификации (обязательный порядок прогона на вехе M5)
На финальной вехе приёмки уровни запускаются строго последовательно — переход к следующему уровню разрешён только при `100%` прохождении предыдущего (`0` падений, `0` ретраев):

```bash
# Уровень 1: Изолированные позитивные фичи (70 тестов >= 68, 6 файлов)
npx playwright test tests/e2e/tier1-features

# Уровень 2: Граничные и негативные сценарии (>= 60 тестов, 6 файлов)
npx playwright test tests/e2e/tier2-boundaries

# Уровень 3: Кросс-фичевые комбинации (>= 18 тестов, 4 файла)
npx playwright test tests/e2e/tier3-combinations

# Уровень 4: Пользовательские сквозные сценарии (>= 8 тестов, 2 файла)
npx playwright test tests/e2e/tier4-scenarios

# Уровень 5: Состязательное укрепление покрытия (создаётся на Фазе 2 вехи M5)
npx playwright test tests/e2e/tier5-adversarial
```

### Точечная отладка отдельного файла или области
```bash
npx playwright test tests/e2e/tier1-features/01-boot-and-modes.spec.ts
npx playwright test -g "R10"
```
