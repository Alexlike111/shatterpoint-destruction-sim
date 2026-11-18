# Готовность пакета сквозного E2E-тестирования (`TEST_READY.md`)

> Официальный сигнал завершения **Этапа 2 независимого контура E2E-верификации (`E2E Testing Track — Stage 2`)** для проекта **«ТОЧКА РАЗЛОМА» (`shatterpoint-destruction-sim`)**. Пакет прошёл многоступенчатую приёмку (`5/5 PASS`: криминалистический аудит `CLEAN`, два независимых ревью `APPROVE`, два эмпирических состязательных прогона `PASS / CONFIRMED` в системном Chromium 156 с WebGL2 SwiftShader) и полностью готов к финальной вехе приёмки **M5**.

---

## 1. Статус готовности и ключевые показатели

- **Статус**: **READY** (`Gate Result: PASS`)
- **Всего файлов E2E-контура**: **20** (`playwright.config.ts` + `tests/e2e/helpers/shatterpoint-harness.ts` + **18** файлов спецификаций `Tiers 1–4`)
- **Зарегистрировано E2E-тестов (`npx playwright test --list`)**: **`166 tests in 18 files`** (`exit code 0`)
- **Предметных проверок `expect(...)` в спеках**: **`1 528`** + автоматическая пост-проверка `assertZeroRuntimeErrors` (`0` ошибок `pageerror`, `console.error`, `network` и проверка живого контекста `WebGL2`) в каждом из 166 тестов
- **Покрытие канонических DOM-селекторов (`PROJECT.md §5`)**: **`87 / 87` (`100%`)** (`64` базовых + `23` аддитивных селектора расширений `A1–A3`)
- **Покрытие фич (`PROJECT.md`)**: **`27 / 27`** (`F01`–`F26` напрямую функциональными и состязательными проверками в браузере + `F27` изоляцией портов живого превью `:5180` от контура автотестов `:5175` / `:4175`)
- **Типизация и правила Opaque-Box / Zero-Mock**:
  - `tsc --noEmit --strict --noUnusedLocals --noUnusedParameters` с `"types": []` (без `@types/node` и без импортов из `src/**`): **`0` ошибок**
  - Моки, стабы, перехваты сети (`page.route`), `waitForTimeout`, `setTimeout`, `test.skip` / `test.fixme` / `test.only`: **`0` вхождений**

---

## 2. Команды запуска E2E-пакета (для вехи M5)

### Основные команды
```bash
# Полный прогон всех 166 сквозных браузерных тестов (Tiers 1–4)
npm run test:e2e

# Сухая проверка конфигурации и дерева из 166 тестов в 18 файлах
npx playwright test --list

# Единый конвейер модульных/интеграционных (Vitest) и браузерных (Playwright) тестов
npm test
```

### Обязательный поуровневый гейт верификации на вехе M5 (Фаза 1 → Фаза 2)
Уровни запускаются строго последовательно — переход к следующему уровню выполняется только при `100%` зелёном прохождении предыдущего (`0` падений, `0` ретраев):

```bash
# 1. Tier 1 — Изолированные позитивные проверки фич (70 тестов в 6 файлах)
npx playwright test tests/e2e/tier1-features

# 2. Tier 2 — Граничные, экстремальные и негативные сценарии (69 тестов в 6 файлах)
npx playwright test tests/e2e/tier2-boundaries

# 3. Tier 3 — Кросс-фичевые взаимодействия 2–3 подсистем (19 тестов в 4 файлах)
npx playwright test tests/e2e/tier3-combinations

# 4. Tier 4 — Многошаговые пользовательские сессии и персистентность (8 сценариев в 2 файлах)
npx playwright test tests/e2e/tier4-scenarios

# 5. Tier 5 — Состязательное укрепление покрытия (создаётся на Фазе 2 вехи M5)
npx playwright test tests/e2e/tier5-adversarial
```

### Важные параметры среды исполнения (`playwright.config.ts`)
- **Системный браузер**: `/usr/lib/chromium/chromium` (`Chromium 156.0.8078.79`) с флагами `['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']` (`CHROMIUM_WEBGL2_LAUNCH_OPTIONS` в `use` и `projects[0].use`).
- **Лимит сокетов ядра Linux (`UNIX_PATH_MAX = 108`)**: кастомный `--user-data-dir` не используется; при запуске `npx playwright test` **не переопределять** переменную окружения `TMPDIR` на длинный путь (`> 53` байт), чтобы путь к `SingletonSocket` профиля Chromium оставался коротким.
- **Сетевая изоляция портов**: автотесты используют `http://localhost:5175` (`npm run dev`, `reuseExistingServer: true`), не конфликтуя с фоновым демоном пользовательского живого превью на выделенном порту **`http://localhost:5180`** (`F27`).

---

## 3. Сводная таблица пирамиды E2E-тестов (Tiers 1–4)

| Уровень (Tier) | Директория | Файлов | Тестов (норма `TEST_INFRA.md`) | Ключевой фокус верификации |
|---|---|---|---|---|
| **Tier 1: Features** | `tests/e2e/tier1-features/` | `6` | **`70`** (`>= 68`, все `R01–R12 >= 5`) | Изолированная работоспособность всех 26 функциональных фич, 87 DOM-селекторов, WebGL2, русского UI (`No Purple`) и моста `window.__SHATTERPOINT__` |
| **Tier 2: Boundaries** | `tests/e2e/tier2-boundaries/` | `6` | **`69`** (`>= 60`, все `R01–R12 >= 5`) | Экстремумы ползунков (`0g`, `30g`), выстрелы в небо, пустой детонатор C4, потолок Ур. 5, отказы при дефиците кредитов, провалы `collateral` / `budget_exhausted`, отсутствие `NaN`/`Infinity` |
| **Tier 3: Combinations** | `tests/e2e/tier3-combinations/` | `4` | **`19`** (`>= 18`) | Кросс-фичевые связки: ЖБ-арматура + X-Ray + вторичный каскад, огонь + ослабление стали + цепная детонация, сейсмический резонанс + Bullet-Time, прокачка Ур. 5 + секвенсор C4 + триггеры |
| **Tier 4: Scenarios** | `tests/e2e/tier4-scenarios/` | `2` | **`8`** (`>= 8`) | Реалистичные сквозные сессии: карьера в Кампании с Мастерской и `reload()` (`localStorage`), полный цикл «Лаборатория → Песочница → Снос → Сброс» |
| **ИТОГО (Stage 2)** | `tests/e2e/` | **`18`** | **`166`** (`>= 154`) | Полный приёмочный барьер для вехи **M5** (плюс `Tier 5` на Фазе 2 M5) |

### Реестр всех 18 файлов спецификаций
1. `tests/e2e/tier1-features/01-boot-and-modes.spec.ts` (`R01`, `R02` — 11 тестов)
2. `tests/e2e/tier1-features/02-sandbox-and-materials.spec.ts` (`R03`, `R04` — 12 тестов)
3. `tests/e2e/tier1-features/03-arsenal-tools.spec.ts` (`R05`, `R06` — 12 тестов)
4. `tests/e2e/tier1-features/04-time-xray-telemetry.spec.ts` (`R07`, `R08` — 11 тестов)
5. `tests/e2e/tier1-features/05-lab-and-campaign.spec.ts` (`R09`, `R10` — 12 тестов)
6. `tests/e2e/tier1-features/06-progression-juice-sequencer.spec.ts` (`R11`, `R12` — 12 тестов)
7. `tests/e2e/tier2-boundaries/01-boot-and-modes.bounds.spec.ts` (`R01`, `R02` — 11 тестов)
8. `tests/e2e/tier2-boundaries/02-sandbox-and-materials.bounds.spec.ts` (`R03`, `R04` — 11 тестов)
9. `tests/e2e/tier2-boundaries/03-arsenal-tools.bounds.spec.ts` (`R05`, `R06` — 12 тестов)
10. `tests/e2e/tier2-boundaries/04-time-xray-telemetry.bounds.spec.ts` (`R07`, `R08` — 11 тестов)
11. `tests/e2e/tier2-boundaries/05-lab-and-campaign.bounds.spec.ts` (`R09`, `R10` — 12 тестов)
12. `tests/e2e/tier2-boundaries/06-progression-juice-sequencer.bounds.spec.ts` (`R11`, `R12` — 12 тестов)
13. `tests/e2e/tier3-combinations/01-structural-rebar-cascade.comb.spec.ts` (5 тестов)
14. `tests/e2e/tier3-combinations/02-thermal-steel-chainblast.comb.spec.ts` (5 тестов)
15. `tests/e2e/tier3-combinations/03-seismic-bullettime-xray.comb.spec.ts` (4 теста)
16. `tests/e2e/tier3-combinations/04-upgrades-sequencer-triggers.comb.spec.ts` (5 тестов)
17. `tests/e2e/tier4-scenarios/01-campaign-and-persistence.scen.spec.ts` (4 сценария)
18. `tests/e2e/tier4-scenarios/02-lab-and-sandbox-workflows.scen.spec.ts` (4 сценария)

---

## 4. Feature Checklist — Покрытие всех фич `F01`–`F27` и областей `R01`–`R12`

| Фича | Наименование (`PROJECT.md`) | Области `R` | Покрывающие спеки (`tests/e2e/...`) | Статус в `TEST_READY` |
|---|---|---|---|---|
| **F01** | Инфраструктура сборки и тестов | `R01` | `tier1/01`, `tier2/01`, `tier4/01..02` | `[x]` Готово |
| **F02** | Детерминированное ядро `core` | `R01`, `R03`, `R07` | `tier1/01, 02, 04`, `tier2/01, 04` | `[x]` Готово |
| **F03** | Физические профили 5 материалов + взрывчатка | `R04`, `R09` | `tier1/02, 05`, `tier2/02, 05`, `tier3/01, 02`, `tier4/02` | `[x]` Готово |
| **F04** | 3D Анизотропный Вороной и пролом брешей | `R03`, `R04`, `R05` | `tier1/02, 03`, `tier2/02, 03`, `tier3/01`, `tier4/01, 02` | `[x]` Готово |
| **F05** | Граф структурной целостности и острова | `R03`, `R08`, `R12` | `tier1/02, 04, 06`, `tier2/02`, `tier3/01, 04`, `tier4/01, 02` | `[x]` Готово |
| **F06** | 6-DOF решатель напряжений и каскадный снос | `R03`, `R08`, `R12` | `tier1/02, 04`, `tier2/02, 04`, `tier3/01, 03, 04`, `tier4/01` | `[x]` Готово |
| **F07** | Арматурные тяжи ЖБ и пластика стали | `R04`, `R08` | `tier1/02, 04`, `tier2/02, 04`, `tier3/01, 02`, `tier4/02` | `[x]` Готово |
| **F08** | Вторичный кинетический урон обломков | `R05`, `R10`, `R12` | `tier1/03, 05, 06`, `tier2/05`, `tier3/01, 04`, `tier4/01, 02` | `[x]` Готово |
| **F09** | Баллистика, ударные волны и цепная детонация | `R05`, `R09`, `R12` | `tier1/03, 05`, `tier2/03, 05`, `tier3/01, 02, 04`, `tier4/01, 02` | `[x]` Готово |
| **F10** | Распространение огня и термическое ослабление | `R06`, `R09` | `tier1/03, 05`, `tier2/03, 05`, `tier3/02`, `tier4/02` | `[x]` Готово |
| **F11** | 3D Сейсмоплатформа (Гц и амплитуда) | `R06`, `R09` | `tier1/03, 05`, `tier2/03, 05`, `tier3/03`, `tier4/02` | `[x]` Готово |
| **F12** | Фасад мира `DestructionWorld` и бюджет 60 FPS | `R02`, `R07`, `R09` | `tier1/01, 04, 05`, `tier2/01, 02, 04, 05`, `tier3/03`, `tier4/02` | `[x]` Готово |
| **F13** | 3D PBR-рендерер с батчингом геометрии | `R01` | `tier1/01`, `tier2/01`, `tier3/01..04`, `tier4/01..02` | `[x]` Готово |
| **F14** | Визуализатор напряжений, тепла и арматуры | `R08`, `R12` | `tier1/04, 06`, `tier2/04`, `tier3/01, 03, 04`, `tier4/01, 02` | `[x]` Готово |
| **F15** | Частицы разрушения (VFX) и 3D-камера | `R02`, `R05` | `tier1/01, 03`, `tier2/01`, `tier4/02` | `[x]` Готово |
| **F16** | Многослойный процедурный звук Web Audio | `R02`, `R07` | `tier1/01, 04`, `tier2/01, 04`, `tier4/02` | `[x]` Готово |
| **F17** | Каталог 6 типов зданий и конструктор | `R03`, `R04` | `tier1/02`, `tier2/02`, `tier3/01, 02`, `tier4/02` | `[x]` Готово |
| **F18** | Интерактивный арсенал из 6 средств | `R05`, `R06`, `R12` | `tier1/03, 06`, `tier2/03, 06`, `tier3/01..04`, `tier4/01, 02` | `[x]` Готово |
| **F19** | Режим «Кампания миссий» (8 контрактов) | `R10`, `R11` | `tier1/05`, `tier2/05`, `tier3/04`, `tier4/01` | `[x]` Готово |
| **F20** | Режим «Свободная Песочница» | `R03`, `R04`, `R07`, `R11` | `tier1/02, 06`, `tier2/02, 06`, `tier3/01..04`, `tier4/02` | `[x]` Готово |
| **F21** | Режим «Физическая Лаборатория-полигон» | `R09` | `tier1/05`, `tier2/05`, `tier3/03`, `tier4/02` | `[x]` Готово |
| **F22** | Русскоязычный Vanilla CSS UI и мост E2E | `R01`, `R02`, `R08`, `R10`, `R11` | `tier1/01, 04, 05, 06`, `tier2/01, 04, 06`, `tier4/01, 02` | `[x]` Готово |
| **F23** | Приёмка 100% E2E (Tiers 1–4) и Tier 5 Hardening | `R01`–`R12` | Все 18 файлов `Tiers 1–4` (`166` тестов) + `tier5-adversarial/` (M5) | `[x]` Готово к M5 |
| **F24** | Экономика, Магазин и Мастерская улучшений (A1) | `R11` | `tier1/06`, `tier2/06`, `tier3/04`, `tier4/01, 02` | `[x]` Готово |
| **F25** | Сочный Game Feel: тоннаж, комбо и авто-слоу-мо (A2) | `R11` | `tier1/06`, `tier2/06`, `tier3/01, 02, 04`, `tier4/01, 02` | `[x]` Готово |
| **F26** | Секвенсор подрыва C4, разведка узлов и триггеры (A3) | `R12` | `tier1/06`, `tier2/06`, `tier3/01, 02, 04`, `tier4/01, 02` | `[x]` Готово |
| **F27** | Поэтапное живое превью (`v0.1 Alpha` → `v0.2 Beta` → `v1.0`) | Инфраструктура / `R01` | `playwright.config.ts` (`:5175` изолирован от демон-превью `:5180`) | `[x]` Изолировано |
