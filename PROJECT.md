# Project: ТОЧКА РАЗЛОМА (`shatterpoint-destruction-sim`)

> Эталонный трёхмерный физический симулятор и тактическая инженерная игра разрушения сооружений (TypeScript + Vite + Three.js + Rapier3D WASM).

---

## Architecture

### 1. Обоснование выбранной архитектуры (Вариант 1: Полноценное гибридное 3D-ядро)
На основании инженерного аудита окружения и существующих наработок (включая 2D-прототип на Вороном в `gemini-develop`) утверждён **Вариант 1** — трёхмерный движок разрушения, объединяющий честную пространственную строительную механику твёрдых тел, безщелевое 3D-дробление Вороного, арматурные и пластические связи и системную 3D-термодинамику огня:

1. **Строго детерминированное Headless-ядро (`src/core/` + `src/physics/`)**:
   - Нулевая зависимость от `window`, `document`, `WebGL`, `AudioContext` и `Math.random()`.
   - Физический движок: `@dimforge/rapier3d-deterministic-compat` (`^0.21.0`, Rust/WASM, обёрнут в `src/physics/rapier.ts`) с фиксированным шагом `FIXED_DT = 1 / 60` и детерминированным ГПСЧ `SeededRng` (`Mulberry32`).
   - Позволяет исполнять 100% реальную физику напрямую в `Vitest` (Node.js) за миллисекунды и в браузере при стабильных **60 FPS**.

2. **Трёхфазная строительная механика (`StructuralGraph` + `StressSolver`)**:
   - **Фаза 1 (Покоящийся монолит)**: связанные с фундаментом (`GroundAnchor`) целые блоки объединены в фиксированное или кинематическое (на сейсмоплатформе) составное тело без паразитной гравитационной просадки и дрожания.
   - **Фаза 2 (6-DOF граф напряжений + Multi-Source BFS)**:
     - Потерявшие связь с фундаментом фрагменты здания мгновенно отделяются за $O(V + E)$ как составные динамические 3D-тела (`Detached Compound RigidBody` из выпуклых коллайдеров блоков) с аналитическим центром масс.
     - Внутренние усилия (осевое сжатие/растяжение, поперечный сдвиг, двухосный изгиб, кручение и потеря устойчивости Эйлера) рассчитываются предобусловленным методом сопряжённых градиентов (`PCG` с тёплым стартом) и проверяются асимметричным критерием Мора—Кулона / Ренкина.
   - **Фаза 3 (Специализированный разлом и каскадное «блинное» обрушение)**:
     - **Железобетон (`reinforced_concrete`)**: при расколе бетона активируются упруго-пластичные 3D-тяги стальной арматуры (`RebarTether` через `ImpulseJoint` в Rapier3D), удерживающие глыбы на весу до превышения предела разрыва стали.
     - **Конструкционная сталь (`steel`)**: образует пластические шарниры изгиба (`PlasticHinge`) перед разрывом и теряет до 80% несущей прочности при нагреве в пожаре ($500–850^\circ\text{C}$ по Еврокоду EN 1993-1-2).
     - **Дерево (`wood`)**: анизотропно щепится вдоль волокон, загорается при $T \ge 260^\circ\text{C}$, передаёт огонь конвективно вверх и выгорает.
     - **Кирпич (`brick`)** и **калёное стекло (`glass`)**: разрушаются по растворным швам и лучистым сеткам раскола (включая термошок стекла и слабые воздушные волны).
     - **Вторичный кинетический урон (`Secondary Kinetic Impact`)**: падающие этажи и тяжёлые глыбы через `CONTACT_FORCE_EVENTS` проламывают нижние перекрытия и соседние здания.

3. **3D Анизотропный Вороной, Баллистика, Волны Садовского и Сейсмоплатформа**:
   - Каноническое отсечение выпуклых многогранников полупространствами (`ConvexPolyhedron3D` + `VoronoiFracture3D`) гарантирует водонепроницаемые выпуклые осколки с сохранением объёма/массы (погрешность `< 0.5%`), маркировкой внутренних граней скола `isInteriorCut`, локальным проломом стен `carveLocalBreach3D` и 3D-прутьями арматуры `RebarStub3D`.
   - Сферические ударные волны взрывов с затуханием по закону Садовского, raycast-окклюзией капитальными стенами и цепной детонацией взрывоопасных объектов (`explosive`).
   - Двухосная 3D сейсмоплатформа с раздельной настройкой частоты (`0.5–15.0 Гц`) и амплитуды/магнитуды (`M 3.0–9.5`), вызывающая реальный частотный резонанс зданий разной этажности.

4. **Высокопроизводительный 3D-рендерер, Многослойный Web Audio и 3 Режима на русском языке**:
   - `THREE.InstancedMesh` для конструктивных блоков и микро-щебня + `THREE.BatchedMesh` для уникальных 3D-осколков Вороного + `Frame Budget Governor` (квота расколов на тик и запекание успокоившихся руин) удерживают рендер в пределах `15–40 Draw Calls`.
   - Три режима визуализации: **PBR Реализм** (трещины, копоть, свечение раскалённой стали), **Тепловая карта напряжений**, **Рентген связей и арматуры (X-Ray)**.
   - Многослойный процедурный синтезатор на Web Audio API без внешних медиафайлов (звон стекла, щелчок разрыва арматуры, хруст дерева, сейсмический грохот падающих этажей по массе, гул огня, рокот землетрясения на выбранной частоте Гц, фильтр Bullet-Time).
   - Три полноценных режима в едином русскоязычном продукте (чистый Vanilla CSS в эстетике «Инженерный Сланец, Титан и Сигнальный Янтарь» строго без фиолетовых тонов и клише):
     1) **Кампания миссий** (8 контрактов сноса с бюджетом/арсеналом, контрольной высотой, охраняемыми соседними зданиями и рейтингом 1–3 звезды);
     2) **Свободная Песочница** (спавн 6 типов зданий + конструктор достройки из 5 материалов и бочек, безлимитный арсенал из 6 средств, Bullet-Time, рентген напряжений);
     3) **Физическая Лаборатория-полигон** (4 калиброванных испытательных стенда, живая телеметрия с осциллограммой и инженерные ползунки физических констант).

5. **Параметры сборки, серверов и браузерного тестирования**:
   - Рабочая директория проекта: `/home/antigravity/Alexlike111/shatterpoint-destruction-sim` (ветка `main`).
   - Порты Vite: dev `http://localhost:5175`, preview `http://localhost:4175` (`strictPort: true`, `host: '0.0.0.0'`).
   - Браузер для Playwright E2E: системный `/usr/lib/chromium/chromium` с флагами `['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']` (без переопределения длинного `--user-data-dir`, чтобы не превышать `UNIX_PATH_MAX = 108`).

---

## Feature Inventory

Каждая фича из исходного запроса, ответов интервью пользователя и отчётов этапа Survey привязана к конкретной вехе (непривязанных фич нет):

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F01 | Инфраструктура сборки и тестов | Настройка `package.json`, TypeScript `strict`, Vite (порты `5175`/`4175`), Vitest и адаптера `src/physics/rapier.ts` | M1 | survey_1 |
| F02 | Детерминированное ядро `core` | Типы контрактов, изолированный ГПСЧ `Mulberry32`, 3D-математика полиэдров (Остроградский—Гаусс) и типизированная шина событий | M1 | survey_2 |
| F03 | Физические профили 5 материалов + взрывчатка | Калиброванные СИ-параметры (`reinforced_concrete`, `glass`, `wood`, `steel`, `brick`, `explosive`) и температурные кривые Еврокода | M1 | ORIGINAL_REQUEST, survey_2, survey_3 |
| F04 | 3D Анизотропный Вороной и пролом брешей | Безщелевое отсечение `ConvexPolyhedron3D`, анизотропия по материалам, сохранение объёма `< 0.5%`, `carveLocalBreach3D`, 3D-прутья `RebarStub3D` | M1 | ORIGINAL_REQUEST, survey_1, survey_2 |
| F05 | Граф структурной целостности и острова | `StructuralGraph`, фундаментные опоры `GroundAnchor`, Multi-Source BFS и отрыв несвязанных секций в `Detached Compound RigidBody` | M2 | ORIGINAL_REQUEST, survey_2 |
| F06 | 6-DOF решатель напряжений и каскадный снос | `StressSolver` (сжатие, растяжение, сдвиг, изгиб, кручение, устойчивость Эйлера на PCG) и гравитационное «блинное» обрушение этажей | M2 | ORIGINAL_REQUEST, survey_2 |
| F07 | Арматурные тяжи ЖБ и пластика стали | Упруго-пластичные связи арматуры `RebarTether` (`ImpulseJoint`) для железобетона и пластические шарниры изгиба `PlasticHinge` для стали | M2 | ORIGINAL_REQUEST, survey_2, survey_3 |
| F08 | Вторичный кинетический урон обломков | Разрушение и повреждение нижних перекрытий и соседних зданий падающими тяжёлыми глыбами через `CONTACT_FORCE_EVENTS` | M2 | ORIGINAL_REQUEST, survey_2, survey_3 |
| F09 | Баллистика, ударные волны и цепная детонация | Пробой/рикошет снарядов, 3D ударные волны Садовского с затуханием, raycast-окклюзией стенами и цепным подрывом бочек/цистерн | M2 | ORIGINAL_REQUEST, survey_2, survey_3 |
| F10 | Распространение огня и термическое ослабление | Кондуктивно-конвективный нагрев, горение и выгорание дерева ($T \ge 260^\circ\text{C}$), термошок стекла, проседание раскалённой стали ($500–850^\circ\text{C}$) | M2 | ORIGINAL_REQUEST, survey_2, survey_3 |
| F11 | 3D Сейсмоплатформа (Гц и амплитуда) | Гармонические и стохастические колебания основания с тонкой настройкой частоты (`0.5–15.0 Гц`), амплитуды/магнитуды и резонансом зданий | M2 | ORIGINAL_REQUEST, survey_2, survey_3 |
| F12 | Фасад мира `DestructionWorld` и бюджет 60 FPS | Управление временем (пауза, шаг, Bullet-Time `0.05x..2x`), ползунками физических констант, квотой расколов и запеканием спящих руин | M2 | survey_1, survey_2, survey_3 |
| F13 | 3D PBR-рендерер с батчингом геометрии | `SceneRenderer` (Three.js, мягкие тени, `ACESFilmic`, `UnrealBloomPass`), `InstancedBlockLayer`, `BatchedShardLayer` и пресеты качества | M3 | survey_1, survey_2, survey_3 |
| F14 | Визуализатор напряжений, тепла и арматуры | Переключение режимов `PBR Реализм` (трещины, уголь, свечение каления стали), `Тепловая карта напряжений` и `Рентген связей и арматуры (X-Ray)` | M3 | ORIGINAL_REQUEST, survey_2, survey_3 |
| F15 | Частицы разрушения (VFX) и 3D-камера | Инстансированные клубы пыли обвалов, пламя, дым, искры стали, сфера ударной волны, микро-щебень, тряска и орбитально-свободная камера | M3 | ORIGINAL_REQUEST, survey_2, survey_3 |
| F16 | Многослойный процедурный звук Web Audio | Синтез звона стекла, разрыва арматуры, хруста дерева, грохота обвалов по массе, гула пожара, рокота землетрясения (Гц) и фильтра Bullet-Time | M3 | ORIGINAL_REQUEST, survey_1, survey_3 |
| F17 | Каталог 6 типов зданий и конструктор | Генераторы 6 архитектурных сооружений (ЖБ-башня, виадук, крепость, ангар, деревянный склад, домино) + достройка блоками из 5 материалов и бочек | M4 | ORIGINAL_REQUEST, survey_3 |
| F18 | Интерактивный арсенал из 6 средств | Кинетическая пушка, направленные заряды C4 с таймингом задержки и Детонатором, Фугас/Метеорит, Плазморезак, Термитная кассета, Сейсмогенератор | M4 | ORIGINAL_REQUEST, survey_3 |
| F19 | Режим «Кампания миссий» (8 контрактов) | Контракты сноса с ограниченным бюджетом/боекомплектом, целевым уроном/высотой, охраняемыми соседними зданиями (провал за ущерб!), 1–3 звезды и `localStorage` | M4 | ORIGINAL_REQUEST, survey_3 |
| F20 | Режим «Свободная Песочница» | Свободный спавн зданий рядом, полный арсенал, достройка конструктором, Bullet-Time, пауза/шаг, рентген напряжений и сброс сцены | M4 | ORIGINAL_REQUEST, survey_3 |
| F21 | Режим «Физическая Лаборатория-полигон» | 4 испытательных стенда (Материаловедение/Термика, Баллистика, Ударные волны/Детонация, Сейсмоплатформа), пульт ползунков констант и живая телеметрия | M4 | ORIGINAL_REQUEST, survey_3 |
| F22 | Русскоязычный Vanilla CSS UI и мост E2E | Премиальный интерфейс без фиолетового и клише, уникальные DOM `id` / `data-*` атрибуты и публичный мост `window.__SHATTERPOINT__` | M4 | ORIGINAL_REQUEST, survey_1, survey_3 |
| F23 | Приёмка 100% E2E (Tiers 1–4) и Tier 5 Hardening | Прохождение полного пакета E2E-тестов из `TEST_READY.md`, состязательное укрепление покрытия Tier 5, живое превью и `git push` | M5 | ORIGINAL_REQUEST, Project Pattern |
| F24 | Экономика, Магазин и Мастерская улучшений (A1) | Заработок кредитов в Кампании (+ бонусы за бюджет, комбо и 0% сопутствующего ущерба), покупка доп. боекомплекта и прокачка Ур. 1→5 всех 6 инструментов с `localStorage` (в Песочнице/Лаборатории открыто сразу) | M4 | ORIGINAL_REQUEST (Follow-up 23:30Z) |
| F25 | Сочный Game Feel: тоннаж, комбо и авто-слоу-мо (A2) | Живой счётчик обрушенных тонн и очков разрушения, комбо-множитель цепных реакций (`x1.5`, `x2`, `x3`...), тактические уведомления, контролируемый тумблер авто-слоу-мо разлома и шкала урона с порогами 1–3 звёзд | M4 | ORIGINAL_REQUEST (Follow-up 23:30Z) |
| F26 | Секвенсор подрыва C4, разведка узлов и триггеры (A3) | Индикация самых нагруженных критических опор на рентгене, программируемый секвенсор каскадного подрыва C4 по долям секунды с визуализацией очереди, триггеры уровней (газовые цистерны, подвешенные многотонные грузы/противовесы, опоры домино) | M2, M3, M4 | ORIGINAL_REQUEST (Follow-up 23:30Z) |
| F27 | Поэтапное живое превью (`v0.1 Alpha` → `v0.2 Beta` → `v1.0`) | Фоновый демон-сервер живого превью (`IsDaemon: true`) на выделенном порту `http://localhost:5180` (без конфликта с `5175`/`4175`) после M3A (`v0.1`), M4 (`v0.2`) и M5 (`v1.0`) | M3A, M4, M5 | ORIGINAL_REQUEST (Follow-up 23:30Z) |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | M1: Базовая инфраструктура, контракты `core`, материалы и 3D Вороной | Инициализация пакета и конфигов сборки/Vitest, `src/core/*`, `src/physics/rapier.ts`, `MaterialRegistry.ts`, `ConvexPolyhedron3D.ts`, `VoronoiFracture3D.ts` и модульные тесты `tests/unit/core-voronoi/*` (фичи F01–F04) | none | DONE (`package.json`, `src/core/*`, `rapier.ts`, `MaterialRegistry.ts`, `ConvexPolyhedron3D.ts`, `VoronoiFracture3D.ts`; `tsc = 0`, `28/28` unit tests PASS, Audit `CLEAN`) |
| 2 | M2: Строительная механика, граф напряжений, триггеры-противовесы, термика, взрывы, сейсмика и `DestructionWorld` | Реализация `StructuralGraph.ts`, `StressSolver.ts`, `BallisticsAndBlast.ts`, `ThermalFireSystem.ts`, `SeismicController.ts`, `DestructionWorld.ts` (включая критические опоры, секвенсор задержек C4 и подвешенные грузы-триггеры) и WASM-тестов `tests/unit/physics-world/*` (фичи F05–F12, F26) | M1 | IN_PROGRESS (`teamwork_preview_sub_orch_m2`) |
| 3 | M3: 3D PBR-рендерер, рентген напряжений и критических опор, VFX, камера и процедурный звук | Реализация `src/render/*` (`SceneRenderer`, `InstancedBlockLayer`, `BatchedShardLayer`, `RebarAndJointLayer` с индикацией критических узлов и очереди C4, `CollapseVFXSystem`, `CameraRig`), `src/audio/DestructionSoundEngine.ts` и тестов `tests/unit/render-audio/*` (фичи F13–F16, F26) | M1 | IN_PROGRESS (`teamwork_preview_sub_orch_m3`) |
| 3A | M3A: Релиз `v0.1 Alpha` — интерактивная сборка ядра физики + 3D-рендера и живое превью `:5180` | Ранняя играбельная точка входа (многоэтажное тестовое здание с триггерами, стрельба/C4, 3D Вороной, каскадный обвал, рентген напряжений, процедурный звук), проверка сборки и запуск демон-превью на `http://localhost:5180` для показа пользователю (фича F27) | M2, M3 | PLANNED |
| 4 | M4: Релиз `v0.2 Beta` — 3 режима, Магазин прокачки Ур. 1–5, секвенсор C4, триггеры, Game Feel, русский UI и превью `:5180` | Реализация `src/content/*`, `src/modes/*` (включая `ProgressionStore` Ур. 1–5, комбо/тоннаж, секвенсор C4, триггеры), `src/ui/*`, `src/styles/*`, `src/main.ts`, `index.html`, моста `window.__SHATTERPOINT__`, `tests/integration/*` и обновление превью на `http://localhost:5180` (фичи F17–F22, F24–F27) | M3A | PLANNED |
| 5 | M5: Финальная веха `v1.0 Release` — 100% E2E приёмка (Tiers 1–4) и состязательное укрепление (Tier 5) | Фаза 1: 100% прохождение E2E-тестов `TEST_READY.md` (последовательно Tier 1 → 2 → 3 → 4); Фаза 2: Tier 5 Adversarial Coverage Hardening + учёт возможных правок пользователя + финальное превью `:5180` и `git push` (фичи F23, F27) | M4, TEST_READY.md | PLANNED |

- **Параллельный трек E2E-тестирования (`E2E Testing Orchestrator`)**: `IN_PROGRESS` (`teamwork_preview_e2e_orch_r2`; Этап 1 `5/5 PASS`, завершение Этапа 2 Tiers 2–4 + `TEST_READY.md`).

---

## Interface Contracts

### 1. Контракт сборки и скриптов (`package.json`)
Эксклюзивный владелец создания и установки: **M1** (последующие вехи M2–M4 и E2E Track используют установленные пакеты без произвольной перезаписи `package.json`).
- Обязательные `dependencies`:
  - `"three": "^0.170.0"`
  - `"@dimforge/rapier3d-deterministic-compat": "^0.21.0"`
- Обязательные `devDependencies`:
  - `"typescript": "^5.6.3"`
  - `"vite": "^6.0.0"`
  - `"@types/three": "^0.170.0"`
  - `"vitest": "^2.1.8"`
  - `"@playwright/test": "^1.50.0"` (установить актуальную из реестра `^1.x`)
- Обязательные `scripts`:
  - `"dev": "vite --host 0.0.0.0 --port 5175 --strictPort"`
  - `"build": "tsc --noEmit && vite build"`
  - `"preview": "vite preview --host 0.0.0.0 --port 4175 --strictPort"`
  - `"test:unit": "vitest run"`
  - `"test:e2e": "playwright test"`
  - `"test": "vitest run && playwright test"`

### 2. `src/core/types.ts` ↔ Все модули (`physics`, `render`, `audio`, `content`, `modes`, `ui`)
```typescript
export type StructuralMaterialId =
  | 'reinforced_concrete'
  | 'brick'
  | 'glass'
  | 'wood'
  | 'steel'
  | 'explosive';

export type AppMode = 'campaign' | 'sandbox' | 'lab';
export type RenderViewMode = 'pbr' | 'stress' | 'xray';
export type QualityPreset = 'performance' | 'high' | 'ultra';
export type ToolId = 'cannon' | 'c4' | 'bomb' | 'cutter' | 'incendiary' | 'seismic';
export type LabBenchId = 'materials' | 'ballistics' | 'blast' | 'seismic';

export interface Vec3Tuple {
  readonly 0: number;
  readonly 1: number;
  readonly 2: number;
}

export interface MaterialPhysicsProfile {
  id: StructuralMaterialId;
  nameRu: string;
  densityKgM3: number;
  compressiveStrengthMPa: number;
  tensileStrengthMPa: number;
  shearCohesionMPa: number;
  internalFrictionCoeff: number;
  youngsModulusGPa: number;
  brittleness: number;
  plasticYieldRatio: number;       // < 1.0 для стали (пластический шарнир), 1.0 для хрупких
  hasRebarTethers: boolean;        // true для железобетона
  voronoiAnisotropy: [number, number, number];
  flammable: boolean;
  ignitionTempC: number;
  volatile: boolean;               // true для взрывоопасных ёмкостей
  detonationTempC: number;
  detonationEquivalentKgTnt: number;
  thermalConductivity: number;
  friction: number;
  restitution: number;
  baseColorHex: number;
  interiorCutColorHex: number;
}

export interface ConvexFace3D {
  indices: number[];               // CCW снаружи
  normal: [number, number, number];
  isInteriorCut: boolean;
}

export interface ConvexPolyhedron3DData {
  vertices: Float32Array;          // Локальные координаты относительно центроида [x0,y0,z0, ...]
  faces: ConvexFace3D[];
  volumeM3: number;
  centroid: [number, number, number];
  halfExtentsApprox: [number, number, number];
}

export interface RebarStub3D {
  originLocal: [number, number, number];
  directionLocal: [number, number, number];
  lengthM: number;
  bendAngleRad: number;
}

export interface VoronoiShard3D {
  polyhedron: ConvexPolyhedron3DData;
  worldPosition: [number, number, number];
  massKg: number;
  rebarStubs: RebarStub3D[];
}

export interface PhysicsConstantsOverrides {
  gravityMpS2: number;             // По умолчанию 9.81 (0..30)
  jointStrengthMultiplier: number; // По умолчанию 1.0 (0.1..5.0)
  secondaryDamageMultiplier: number; // По умолчанию 1.0 (0.0..3.0)
  blastFalloffMultiplier: number;  // По умолчанию 1.0 (0.25..3.0)
  fireSpreadMultiplier: number;    // По умолчанию 1.0 (0.0..4.0)
  seismicFrequencyHz: number;      // 0.5..15.0 Гц
  seismicAmplitudeM: number;       // 0.05..2.50 м
}

export interface BlockInputSpec {
  id?: string;
  materialId: StructuralMaterialId;
  center: [number, number, number];
  halfExtents: [number, number, number];
  rotationQuat?: [number, number, number, number];
  grounded?: boolean;              // Опирается ли напрямую на фундамент/сейсмоплатформу
  structureGroupTag?: string;      // 'target' | 'protected' | string (для миссий Кампании)
}

export interface RenderBlockInstance {
  nodeId: number;
  materialId: StructuralMaterialId;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  halfExtents: [number, number, number];
  stressUtilization: number;       // 0.0 .. 1.5+
  damageRatio: number;             // 0.0 .. 1.0
  temperatureC: number;            // 20 .. 1200 °C
  charRatio: number;               // 0.0 .. 1.0 (обугливание)
  burning: boolean;
  structureGroupTag: string;
}

export interface RenderShardInstance {
  shardId: number;
  materialId: StructuralMaterialId;
  polyhedron: ConvexPolyhedron3DData;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  temperatureC: number;
  charRatio: number;
  sleeping: boolean;
  rebarStubs: RebarStub3D[];
}

export interface RenderBondOrRebarLine {
  id: number;
  kind: 'bond' | 'rebar' | 'plastic_hinge';
  pointA: [number, number, number];
  pointB: [number, number, number];
  stressUtilization: number;
  axialForceN: number;             // > 0 растяжение, < 0 сжатие
  broken: boolean;
}

export interface PlantedChargeSnapshot {
  chargeId: number;
  position: [number, number, number];
  normal: [number, number, number];
  delaySec: number;
  armed: boolean;
  remainingCountdownSec: number | null;
}

export interface RenderSnapshot {
  tick: number;
  simTimeSec: number;
  platformOffset: [number, number, number];
  blocks: RenderBlockInstance[];
  shards: RenderShardInstance[];
  bondsAndRebars: RenderBondOrRebarLine[];
  plantedCharges: PlantedChargeSnapshot[];
  projectiles: Array<{
    id: number;
    position: [number, number, number];
    radiusM: number;
    velocity: [number, number, number];
    hot: boolean;
  }>;
}

export type SimulationEvent =
  | { type: 'fracture'; position: [number, number, number]; materialId: StructuralMaterialId; energyJ: number; shardCount: number }
  | { type: 'rebar_snap'; position: [number, number, number]; forceN: number }
  | { type: 'steel_yield'; position: [number, number, number]; angleRad: number }
  | { type: 'secondary_impact'; position: [number, number, number]; materialId: StructuralMaterialId; impulseNs: number; massKg: number; targetTag: string }
  | { type: 'explosion'; position: [number, number, number]; radiusM: number; equivalentKgTnt: number; isChainDetonation: boolean }
  | { type: 'fire_ignited'; nodeId: number; position: [number, number, number] }
  | { type: 'seismic_pulse'; frequencyHz: number; amplitudeM: number; groundAccelMpS2: number };

export interface SimulationTelemetry {
  tick: number;
  simTimeSec: number;
  intactBlockCount: number;
  initialBlockCount: number;
  intactJointCount: number;
  initialJointCount: number;
  brokenJointCount: number;
  activeRebarCount: number;
  snappedRebarCount: number;
  plasticHingeCount: number;
  activeShardCount: number;
  bakedRubbleCount: number;
  burningNodeCount: number;
  maxTemperatureC: number;
  maxStressUtilization: number;
  kineticEnergyKJ: number;
  secondaryImpactsCount: number;
  detonatedExplosivesCount: number;
  destructionPct: number;          // 0..100% (по целевым/всем конструкциям)
  targetMaxHeightM: number;        // Текущая верхняя точка целевого сооружения
  protectedDamagePct: number;      // 0..100% урона охраняемым объектам ('protected')
  seismicActive: boolean;
  seismicFrequencyHz: number;
  seismicAmplitudeM: number;
  lastStepCpuMs: number;
}
```

### 3. `DestructionWorld` (`M2`) ↔ Игровые режимы (`M4`) и тесты
Класс `DestructionWorld` в `src/physics/DestructionWorld.ts` экспортирует:
- `static async create(options?: { seed?: number; constants?: Partial<PhysicsConstantsOverrides> }): Promise<DestructionWorld>`
- `clearScene(): void`
- `spawnStructure(blocks: BlockInputSpec[]): number[]` (возвращает массив `nodeId` и автоматически строит `StructuralGraph` по пятнам контакта смежных блоков и `grounded` опорам)
- `step(substeps?: number): SimulationEvent[]` (продвигает физику на `FIXED_DT = 1/60`, возвращает события за тик)
- `fireProjectile(params: { origin: [number, number, number]; direction: [number, number, number]; speedMpS: number; massKg: number; radiusM?: number }): number`
- `plantC4(params: { worldPoint: [number, number, number]; normal: [number, number, number]; targetNodeId?: number; delaySec: number; yieldKgTnt?: number }): number`
- `removeC4(chargeId: number): boolean`
- `detonateAllC4(): void`
- `triggerBlast(params: { center: [number, number, number]; yieldKgTnt: number; incendiary?: boolean }): void`
- `applyPlasmaCut(params: { origin: [number, number, number]; direction: [number, number, number]; maxRangeM: number; powerKw?: number; dtSec: number }): void`
- `igniteArea(params: { center: [number, number, number]; radiusM: number; temperatureC?: number }): void`
- `triggerEarthquake(params: { frequencyHz: number; amplitudeM: number; durationSec: number }): void`
- `stopEarthquake(): void`
- `updateConstants(partial: Partial<PhysicsConstantsOverrides>): void`
- `getConstants(): PhysicsConstantsOverrides`
- `raycastScene(origin: [number, number, number], direction: [number, number, number], maxDistM?: number): { hit: boolean; point: [number, number, number]; normal: [number, number, number]; nodeId?: number; shardId?: number; distanceM: number }`
- `updateC4Delay(chargeId: number, delaySec: number): boolean` (для программируемого секвенсора каскадного подрыва C4 по долям секунды)
- `spawnSuspendedCounterweight(params: { anchorNodeId?: number; anchorPoint: [number, number, number]; weightCenter: [number, number, number]; halfExtents: [number, number, number]; massKg: number; tetherBreakForceN?: number }): number` (подвешенный многотонный груз/противовес на разрываемом креплении — при обрыве обрушивается вниз и пробивает перекрытия)
- `getCriticalLoadBearingNodeIds(topK?: number): number[]` (список наиболее нагруженных ключевых несущих опор для тактической разведки на рентгене)
- `getCollapsedMassKg(): number` (суммарная обрушенная/оторванная от исходного каркаса масса конструкций в кг для живого счётчика тоннажа)
- `getRenderSnapshot(): RenderSnapshot`
- `getTelemetry(): SimulationTelemetry`
- `dispose(): void`

### 4. `SceneRenderer` & `DestructionSoundEngine` (`M3`) ↔ Оболочка приложения (`M3A` / `M4`)
- `SceneRenderer` (`src/render/SceneRenderer.ts`):
  - Конструктор принимает `{ canvas?: HTMLCanvasElement; quality?: QualityPreset; headless?: boolean }` (при `headless: true` или отсутствии WebGL-контекста безопасно работает в no-op режиме без падений в Node/Vitest).
  - `syncSnapshot(snapshot: RenderSnapshot): void`
  - `setCriticalNodes(nodeIds: number[]): void` (наглядная индикация самых нагруженных критических несущих опор в режимах `stress` и `xray`)
  - `consumeEvents(events: SimulationEvent[]): void` (спавнит клубы пыли, искры, вспышки взрыва, ударную сферу и тряску камеры)
  - `setViewMode(mode: RenderViewMode): void`
  - `setQualityPreset(preset: QualityPreset): void`
  - `renderFrame(dtRealSec: number): void`
  - `screenPointToRay(ndcX: number, ndcY: number): { origin: [number, number, number]; direction: [number, number, number] }`
  - `projectWorldToScreen(worldPos: [number, number, number]): { x: number; y: number; visible: boolean }`
  - `focusOnBounds(center: [number, number, number], radiusM: number): void`
  - `getDrawCallsCount(): number`
  - `dispose(): void`
- `DestructionSoundEngine` (`src/audio/DestructionSoundEngine.ts`):
  - Безопасен без `window.AudioContext` (graceful no-op в headless).
  - `unlock(): void`, `setMuted(muted: boolean): void`, `setTimeScale(scale: number): void`
  - `consumeEvents(events: SimulationEvent[], telemetry: SimulationTelemetry): void`
  - `dispose(): void`

### 5. Внешний контракт приложения для E2E-трека (DOM `id`, `data-*` и `window.__SHATTERPOINT__`)
Обязательные базовые элементы DOM в браузере (100% неизменные для `Tier 1`, реализуются в **M4**, тестируются независимым **E2E Testing Track**):
- Оболочка и режимы: `#app-root` (`data-ready="true"`, `data-active-mode="campaign|sandbox|lab"`, `data-paused="true|false"`, `data-time-scale="<num>"`, `data-render-mode="pbr|stress|xray"`, `data-sim-tick="<int>"`), `#sim-canvas`, `#mode-campaign-btn`, `#mode-sandbox-btn`, `#mode-lab-btn`.
- Арсенал: `#tool-cannon`, `#tool-c4`, `#tool-bomb`, `#tool-cutter`, `#tool-incendiary`, `#tool-seismic`, `#detonate-c4-btn`, `#c4-delay-select` (`data-active-tool="<id>"`, `data-planted-c4="<N>"` на `#app-root`).
- Время, камера и рентген: `#time-pause-btn`, `#time-step-btn`, `#time-bullet-btn`, `#time-scale-select`, `#view-pbr-btn`, `#view-stress-btn`, `#view-xray-btn`, `#scene-reset-btn`, `#quality-select`, `#audio-mute-btn`.
- Свободная Песочница: `#sandbox-spawn-select`, `#sandbox-spawn-btn`, `#sandbox-build-toggle`, `#mat-reinforced_concrete`, `#mat-glass`, `#mat-wood`, `#mat-steel`, `#mat-brick`, `#mat-explosive`.
- Физическая Лаборатория-полигон: `#lab-bench-materials`, `#lab-bench-ballistics`, `#lab-bench-blast`, `#lab-bench-seismic`, `#slider-gravity`, `#slider-joint-strength`, `#slider-secondary-dmg`, `#slider-blast-falloff`, `#slider-fire-rate`, `#slider-quake-freq-hz`, `#slider-quake-amp`, `#btn-trigger-quake`.
- Телеметрия: `#telemetry-destruction-pct`, `#telemetry-intact-joints`, `#telemetry-rebar-links`, `#telemetry-burning-nodes`, `#telemetry-max-temp-c`, `#telemetry-kinetic-kj`, `#telemetry-fps` (у каждого `data-value="<float>"`).
- Кампания миссий: `#contract-01` .. `#contract-08`, `#mission-budget-remaining`, `#mission-target-progress`, `#mission-collateral-pct`, `#mission-result-panel` (`data-mission-status="planning|running|victory|defeat"`, `data-fail-reason="none|collateral|budget_exhausted"`, `data-stars="0|1|2|3"`), `#mission-stars`.

Аддитивные элементы DOM и поля моста для расширений **A1–A3** (100% обратно-совместимы с `Tier 1`, проверяются в `Tiers 2–4`):
- **Магазин и Мастерская улучшений (A1)**:
  - `#wallet-credits` (`data-value="<int>"` — заработанные средства игрока);
  - `#open-workshop-btn`, `#workshop-modal` (`data-open="true|false"`), `#close-workshop-btn`, `#buy-extra-ammo-btn`;
  - Кнопки многоуровневой прокачки (Ур. 1 → Ур. 5) с сохранением в `localStorage`: `#upgrade-cannon-btn`, `#upgrade-c4-btn`, `#upgrade-bomb-btn`, `#upgrade-cutter-btn`, `#upgrade-incendiary-btn`, `#upgrade-seismic-btn` (у каждой `data-level="1|2|3|4|5"` и `data-cost="<int>"`);
  - В Песочнице и Лаборатории все 6 инструментов открыты сразу (уровень прокачки для тестов можно также свободно выбрать через `#sandbox-upgrade-level-select`), а стартовые миссии Кампании полностью проходимы базовым снаряжением Ур. 1.
- **Game Feel, тоннаж, комбо и авто-слоу-мо (A2)**:
  - `#hud-collapsed-tons` (`data-value="<float>"` — обрушенная масса в тоннах);
  - `#hud-destruction-score` (`data-value="<int>"` — стоимость разрушений / счёт);
  - `#hud-combo-badge` (`data-multiplier="<float>"`, например `1`, `1.5`, `2`, `3`);
  - `#tactical-feed` (`data-last-event="<string>"` — лента инженерных уведомлений: «Срез несущей колонны!», «Разрыв арматуры!», «Каскадный обвал!», «Цепная детонация!»);
  - `#auto-slowmo-toggle` (на `#app-root` атрибут `data-auto-slowmo="true|false"` — контролируемое кратковременное кинематографичное авто-слоу-мо ключевого разлома, НЕ перезаписывающее базовый пользовательский атрибут `data-time-scale` и не нарушающее счёт тиков в E2E);
  - `#damage-progress-bar` с отметками порогов победы и звёзд `#star-threshold-1`, `#star-threshold-2`, `#star-threshold-3`.
- **Секвенсор C4 и интерактивные триггеры (A3)**:
  - `#c4-sequencer-panel`, `#c4-sequencer-list` (`data-queue-count="<N>"` — визуализация очереди подрыва по долям секунды `0.00 с`, `+0.25 с`, `+0.50 с`, `+1.00 с` с редактированием задержки зарядов).
- **Диагностический мост `window.__SHATTERPOINT__`**:
  - `getTelemetry(): SimulationTelemetry & { mode: AppMode; missionStatus: string; collateralPct: number; stars: number; fps: number; drawCalls: number; walletCredits: number; toolLevels: Record<ToolId, number>; collapsedMassTons: number; destructionScore: number; comboMultiplier: number; criticalNodesCount: number; c4SequenceQueue: Array<{ chargeId: number; delaySec: number }>; activeTriggersCount: number }`
  - `projectWorldPoint(x: number, y: number, z: number): { x: number; y: number; visible: boolean }`

### 6. Сетевое разделение портов автотестов и живого пользовательского превью
- Автотесты Playwright (`playwright.config.ts`): используют `http://localhost:5175` (`npm run dev`) или `http://localhost:4175` (`npm run preview`).
- Поэтапное живое превью для пользователя (`v0.1 Alpha` → `v0.2 Beta` → `v1.0 Release`): запускается в фоновом демон-режиме (`IsDaemon: true`) строго на выделенном порту **`http://localhost:5180`** (`npx vite --host 0.0.0.0 --port 5180 --strictPort` или `npx vite preview --host 0.0.0.0 --port 5180 --strictPort`), исключая малейшие конфликты портов при параллельном прогоне E2E!

---

## Code Layout

Корень проекта: `/home/antigravity/Alexlike111/shatterpoint-destruction-sim`
Строгое разграничение владения файлами между вехами и треками:

```text
/home/antigravity/Alexlike111/shatterpoint-destruction-sim/
├── PROJECT.md                          # [Project Orchestrator] Глобальная спецификация проекта
├── TEST_INFRA.md                       # [E2E Testing Orchestrator] Спецификация E2E-инфраструктуры
├── TEST_READY.md                       # [E2E Testing Orchestrator] Сигнал готовности E2E-пакета
├── package.json                        # [M1] Зависимости и канонические скрипты сборки/тестов
├── package-lock.json                   # [M1] Зафиксированное дерево пакетов npm
├── tsconfig.json                       # [M1] Строгий конфиг TypeScript (ES2022, strict: true)
├── vite.config.ts                      # [M1] Конфиг Vite (порты 5175 / 4175, чанки three/rapier)
├── vitest.config.ts                    # [M1] Конфиг Vitest (включает только tests/unit/** и tests/integration/**)
├── playwright.config.ts                # [E2E Testing Orchestrator] Конфиг Playwright (/usr/lib/chromium/chromium + SwiftShader WebGL2)
├── .gitignore                          # [M1] Исключение node_modules, dist, playwright-report, test-results, .agents
├── index.html                          # [M3A -> M4] Русскоязычная HTML5-оболочка приложения
├── src/
│   ├── core/                           # [M1] Чистые типы, RNG, математика 3D-полиэдров, шина событий
│   │   ├── types.ts
│   │   ├── rng.ts
│   │   ├── math3d.ts
│   │   └── events.ts
│   ├── physics/
│   │   ├── rapier.ts                   # [M1] Единый загрузчик WASM @dimforge/rapier3d-deterministic-compat
│   │   ├── MaterialRegistry.ts         # [M1] СИ-профили 5 материалов + взрывчатка + кривые Еврокода
│   │   ├── ConvexPolyhedron3D.ts       # [M1] Выпуклый многогранник и каноническое отсечение полупространством
│   │   ├── VoronoiFracture3D.ts        # [M1] 3D анизотропный Вороной, carveLocalBreach3D, RebarStub3D
│   │   ├── StructuralGraph.ts          # [M2] Граф узлов и связей, GroundAnchor, Multi-Source BFS островов
│   │   ├── StressSolver.ts             # [M2] 6-DOF жёсткость балок, предобусловленный PCG, Мор-Кулон и Эйлер
│   │   ├── BallisticsAndBlast.ts       # [M2] Снаряды, ударные волны Садовского, raycast-окклюзия, цепной взрыв
│   │   ├── ThermalFireSystem.ts        # [M2] Теплопередача, конвекция огня вверх, выгорание дерева, ослабление стали
│   │   ├── SeismicController.ts        # [M2] Двухосная сейсмоплатформа (Гц, амплитуда, резонанс)
│   │   └── DestructionWorld.ts         # [M2] Главный фасад физического ядра, арматура RebarTether, пластика стали, противовесы
│   ├── render/                         # [M3] 3D WebGL2 рендерер на Three.js (15-40 Draw Calls)
│   │   ├── SceneRenderer.ts
│   │   ├── InstancedBlockLayer.ts
│   │   ├── BatchedShardLayer.ts
│   │   ├── RebarAndJointLayer.ts
│   │   ├── CollapseVFXSystem.ts
│   │   └── CameraRig.ts
│   ├── audio/                          # [M3] Многослойный процедурный синтезатор Web Audio API
│   │   └── DestructionSoundEngine.ts
│   ├── content/                        # [M4] Чертежи 6 зданий + триггеры, 8 контрактов Кампании, 4 стенда Лаборатории
│   │   ├── BuildingBlueprints.ts
│   │   ├── CampaignMissions.ts
│   │   └── LabBenches.ts
│   ├── modes/                          # [M4] Прокачка Ур. 1-5, комбо/тоннаж, секвенсор C4, контроллеры 3 режимов
│   │   ├── ProgressionStore.ts
│   │   ├── ArsenalController.ts
│   │   ├── CampaignManager.ts
│   │   ├── SandboxController.ts
│   │   └── PhysicsLabController.ts
│   ├── ui/                             # [M4] Русскоязычный UI, Мастерская улучшений, секвенсор C4, телеметрия
│   │   └── AppUIController.ts
│   ├── styles/                         # [M3A -> M4] Чистый Vanilla CSS (без фиолетового и клише)
│   │   └── index.css
│   └── main.ts                         # [M3A -> M4] Главная точка входа и мост window.__SHATTERPOINT__
└── tests/
    ├── unit/
    │   ├── core-voronoi/               # [M1] Юнит-тесты RNG, полиэдров, материалов и 3D Вороного
    │   ├── physics-world/              # [M2] Безмоковые WASM-тесты строительной механики, триггеров, огня, взрывов и сейсмики
    │   └── render-audio/               # [M3] Юнит-тесты батчинга снимков рендера, камеры и звукового движка
    ├── integration/                    # [M3A -> M4] Интеграционные тесты ядра, прокачки Ур. 1-5, 3 режимов, 8 миссий и стендов
    └── e2e/                            # [E2E Testing Orchestrator + M5 Tier 5] Сквозные браузерные тесты Tiers 1-5
```
