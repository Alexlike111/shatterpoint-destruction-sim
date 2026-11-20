import type { ToolId } from '../core/types';

/**
 * Хранилище экономической прогрессии, прокачки арсенала (Ур. 1 -> Ур. 5) и рекордов Кампании
 * с надёжной сериализацией в localStorage («ТОЧКА РАЗЛОМА», F19 + F24).
 */

export type ToolUpgradeLevel = 1 | 2 | 3 | 4 | 5;

export interface ContractProgressRecord {
  completed: boolean;
  bestStars: 0 | 1 | 2 | 3;
  bestDestructionPct: number;
}

export interface ProgressionState {
  walletCredits: number;
  toolLevels: Record<ToolId, ToolUpgradeLevel>;
  extraAmmoPacks: number;
  contracts: Record<string, ContractProgressRecord>;
}

const STORAGE_KEY = 'shatterpoint_progression_v1';

const ALL_TOOLS: readonly ToolId[] = [
  'cannon',
  'c4',
  'bomb',
  'cutter',
  'incendiary',
  'seismic',
];

/** Базовые цены перехода с уровня L на L+1 для каждого инструмента. */
const UPGRADE_COSTS_BY_TOOL: Readonly<Record<ToolId, readonly [number, number, number, number]>> = {
  cannon: [240, 480, 820, 1280],
  c4: [260, 520, 880, 1360],
  cutter: [250, 500, 850, 1320],
  incendiary: [270, 540, 900, 1400],
  bomb: [300, 600, 980, 1500],
  seismic: [320, 640, 1050, 1600],
};

export const EXTRA_AMMO_PACK_COST = 300;
export const EXTRA_AMMO_BUDGET_BONUS = 400;

function createDefaultState(): ProgressionState {
  return {
    walletCredits: 0,
    toolLevels: {
      cannon: 1,
      c4: 1,
      bomb: 1,
      cutter: 1,
      incendiary: 1,
      seismic: 1,
    },
    extraAmmoPacks: 0,
    contracts: {},
  };
}

function clampLevel(val: unknown): ToolUpgradeLevel {
  const n = Number(val);
  if (!Number.isFinite(n)) return 1;
  const r = Math.min(5, Math.max(1, Math.trunc(n)));
  return r as ToolUpgradeLevel;
}

export class ProgressionStore {
  private state: ProgressionState;

  constructor() {
    this.state = this.loadFromStorage();
  }

  public getState(): Readonly<ProgressionState> {
    return this.state;
  }

  public getWalletCredits(): number {
    return this.state.walletCredits;
  }

  public getToolLevel(tool: ToolId): ToolUpgradeLevel {
    return this.state.toolLevels[tool] ?? 1;
  }

  public getToolLevelsCopy(): Record<ToolId, ToolUpgradeLevel> {
    return { ...this.state.toolLevels };
  }

  public getExtraAmmoPacks(): number {
    return this.state.extraAmmoPacks;
  }

  public getUpgradeCost(tool: ToolId): number {
    const lvl = this.getToolLevel(tool);
    if (lvl >= 5) return 0;
    return UPGRADE_COSTS_BY_TOOL[tool][lvl - 1] ?? 500;
  }

  public canUpgradeTool(tool: ToolId): boolean {
    const lvl = this.getToolLevel(tool);
    if (lvl >= 5) return false;
    const cost = this.getUpgradeCost(tool);
    return this.state.walletCredits >= cost;
  }

  public upgradeTool(tool: ToolId): boolean {
    if (!this.canUpgradeTool(tool)) return false;
    const cost = this.getUpgradeCost(tool);
    const nextLvl = Math.min(5, this.getToolLevel(tool) + 1) as ToolUpgradeLevel;
    this.state.walletCredits = Math.max(0, Math.trunc(this.state.walletCredits - cost));
    this.state.toolLevels[tool] = nextLvl;
    this.saveToStorage();
    return true;
  }

  public canBuyExtraAmmo(): boolean {
    return this.state.walletCredits >= EXTRA_AMMO_PACK_COST;
  }

  public buyExtraAmmoPack(): boolean {
    if (!this.canBuyExtraAmmo()) return false;
    this.state.walletCredits = Math.max(
      0,
      Math.trunc(this.state.walletCredits - EXTRA_AMMO_PACK_COST),
    );
    this.state.extraAmmoPacks += 1;
    this.saveToStorage();
    return true;
  }

  public recordContractVictory(params: {
    contractId: string;
    stars: 1 | 2 | 3;
    destructionPct: number;
    baseRewardCredits: number;
    budgetSavedBonus: number;
    comboBonus: number;
  }): number {
    const prev = this.state.contracts[params.contractId];
    const starBonus = (params.stars - 1) * 120;
    const earned = Math.max(
      100,
      Math.round(
        params.baseRewardCredits + starBonus + params.budgetSavedBonus + params.comboBonus,
      ),
    );

    this.state.walletCredits = Math.trunc(this.state.walletCredits + earned);
    const bestStars = Math.max(prev?.bestStars ?? 0, params.stars) as 0 | 1 | 2 | 3;
    const bestDestructionPct = Math.max(prev?.bestDestructionPct ?? 0, params.destructionPct);

    this.state.contracts[params.contractId] = {
      completed: true,
      bestStars,
      bestDestructionPct,
    };
    this.saveToStorage();
    return earned;
  }

  public getContractRecord(contractId: string): ContractProgressRecord {
    return (
      this.state.contracts[contractId] ?? {
        completed: false,
        bestStars: 0,
        bestDestructionPct: 0,
      }
    );
  }

  private loadFromStorage(): ProgressionState {
    const fallback = createDefaultState();
    if (typeof window === 'undefined' || !window.localStorage) {
      return fallback;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<ProgressionState>;
      const walletCredits =
        typeof parsed.walletCredits === 'number' && Number.isFinite(parsed.walletCredits)
          ? Math.max(0, Math.trunc(parsed.walletCredits))
          : 0;
      const extraAmmoPacks =
        typeof parsed.extraAmmoPacks === 'number' && Number.isFinite(parsed.extraAmmoPacks)
          ? Math.max(0, Math.trunc(parsed.extraAmmoPacks))
          : 0;

      const toolLevels = { ...fallback.toolLevels };
      if (parsed.toolLevels && typeof parsed.toolLevels === 'object') {
        for (const t of ALL_TOOLS) {
          toolLevels[t] = clampLevel((parsed.toolLevels as Record<string, unknown>)[t]);
        }
      }

      const contracts: Record<string, ContractProgressRecord> = {};
      if (parsed.contracts && typeof parsed.contracts === 'object') {
        for (const [cid, rec] of Object.entries(parsed.contracts)) {
          if (rec && typeof rec === 'object') {
            const r = rec as Partial<ContractProgressRecord>;
            const starsNum = Number(r.bestStars ?? 0);
            const safeStars = (
              Number.isFinite(starsNum) ? Math.min(3, Math.max(0, Math.trunc(starsNum))) : 0
            ) as 0 | 1 | 2 | 3;
            contracts[cid] = {
              completed: Boolean(r.completed),
              bestStars: safeStars,
              bestDestructionPct:
                typeof r.bestDestructionPct === 'number' && Number.isFinite(r.bestDestructionPct)
                  ? Math.max(0, Math.min(100, r.bestDestructionPct))
                  : 0,
            };
          }
        }
      }

      return {
        walletCredits,
        toolLevels,
        extraAmmoPacks,
        contracts,
      };
    } catch {
      return fallback;
    }
  }

  private saveToStorage(): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Игнорируем переполнение или блокировку приватного хранилища
    }
  }
}
