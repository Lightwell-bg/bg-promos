// Data contract: docs/API.md (v1). Money values are integer EUR cents.

export type ChainId = "lidl" | "kaufland" | "billa";
export const CHAIN_IDS: readonly ChainId[] = ["lidl", "kaufland", "billa"];
export const CHAIN_NAMES: Record<ChainId, string> = {
  lidl: "Lidl",
  kaufland: "Kaufland",
  billa: "BILLA",
};

export type Lang = "bg" | "ru";
export const LANGS: readonly Lang[] = ["bg", "ru"];

export type PriceKind = "regular" | "promo" | "loyalty" | "multibuy";
export type Program = "lidl_plus" | "kaufland_card" | "billa_card" | "billa_app";

export interface PriceCondition {
  kind: PriceKind;
  program: Program | null;
  min_qty: number;
  total_cents: number;
  per_item_cents: number;
  discount_pct: number | null;
  text: string | null;
}

export interface UnitPrice {
  cents: number;
  per: "kg" | "l";
  source: "published" | "computed";
}

export interface Offer {
  id: string;
  chain: ChainId;
  product_ref: string;
  name: string;
  brand: string | null;
  description: string | null;
  category: string;
  chain_category: string | null;
  unit_text: string | null;
  label: string | null;
  image_url: string | null;
  source_url: string;
  source_is_product: boolean;
  valid_from: string | null;
  valid_to: string | null;
  first_seen_at: string;
  prices: PriceCondition[];
  best: PriceCondition | null;
  no_card: PriceCondition | null;
  regular_cents: number | null;
  savings_per_item_cents: number | null;
  unit_price: UnitPrice | null;
  /** How the price is quoted. Missing in old cached catalogs: treat as "piece" (see saleUnitOf). */
  sale_unit: SaleUnit;
  /** Ids of equivalent offers of the same chain (their prices are already merged into this one). */
  alt_ids: string[];
}

export type SaleUnit = "kg" | "l" | "piece";

export interface ChainInfo {
  name: string;
  status: string;
  stale: boolean;
  stale_reason: string | null;
  last_success_at: string | null;
  offers_url: string;
  brochure_url: string;
}

export interface Category {
  id: string;
  bg: string;
  ru: string;
  icon: string;
}

export interface Catalog {
  version: number;
  generated_at: string;
  today: string;
  currency: string;
  chains: Partial<Record<ChainId, ChainInfo>>;
  categories: Category[];
  offers: Offer[];
}

export interface AppConfig {
  ga4_id: string | null;
  contact_email: string;
  operator: string;
  site_url: string;
  brochures: Partial<Record<ChainId, string>>;
  report_enabled: boolean;
  /** Public bot username (no @) for t.me/<bot>?startapp= share links; null = not configured. */
  telegram_bot: string | null;
}

export interface ReportRequest {
  message: string;
  offer_id: string | null;
  page_url: string | null;
  lang: Lang;
  hp: string;
  elapsed_ms: number;
}
