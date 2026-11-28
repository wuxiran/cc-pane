/** Magpie 网关实况（只读）。字段与 `cc-panes-core/src/services/magpie_live.rs` 一一对应。 */

export interface MagpieRouteTry {
  model: string;
  effort?: string | null;
  done: boolean;
  status?: number | null;
  fail?: string | null;
  ms?: number | null;
}

export interface MagpieRuleHit {
  n: number;
  useMember?: string | null;
  pick?: string | null;
}

export interface MagpieRoute {
  id: number;
  kind?: string | null;
  asked: string;
  askedEffort?: string | null;
  group?: string | null;
  rule?: MagpieRuleHit | null;
  model?: string | null;
  effort?: string | null;
  served?: string | null;
  tries: MagpieRouteTry[];
  done: boolean;
  status?: number | null;
  error?: string | null;
  ms?: number | null;
  ttftMs?: number | null;
}

export interface MagpieRouteStatus {
  available: boolean;
  sessionKey?: string | null;
  seq: number;
  route?: MagpieRoute | null;
  switchCount: number;
}

export interface MagpieQuotaWindow {
  name: string;
  used: number;
  remaining: number;
  unlimited: boolean;
  resetsAt?: string | null;
  display?: string | null;
  text: boolean;
}

export interface MagpieQuota {
  provider: string;
  name: string;
  kind: string;
  plan?: string | null;
  user?: string | null;
  windows: MagpieQuotaWindow[];
  balance?: string | null;
  error?: string | null;
  alias?: string | null;
  lastServedAt?: string | null;
  last: boolean;
  from?: string | null;
}

export interface MagpieQuotaReport {
  available: boolean;
  quotas: MagpieQuota[];
}

export interface MagpieCatalogEntry {
  id: string;
  label?: string | null;
  contextWindowTokens?: number | null;
}

export interface MagpieCatalog {
  available: boolean;
  groups: MagpieCatalogEntry[];
  models: MagpieCatalogEntry[];
}
