import MiniSearch from "minisearch";
import { lookupRuBg, MAX_PHRASE_WORDS } from "./ruBg";
import type { Catalog, Category, Offer } from "./types";

// ---- normalisation & transliteration -------------------------------------

/** lowercase, ё->е, punctuation -> space, collapsed spaces. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const LAT_TO_CYR: ReadonlyArray<readonly [string, string]> = [
  ["sht", "щ"],
  ["sh", "ш"],
  ["ch", "ч"],
  ["zh", "ж"],
  ["ts", "ц"],
  ["yu", "ю"],
  ["ya", "я"],
  ["a", "а"],
  ["b", "б"],
  ["v", "в"],
  ["g", "г"],
  ["d", "д"],
  ["e", "е"],
  ["z", "з"],
  ["i", "и"],
  ["y", "й"],
  ["j", "й"],
  ["k", "к"],
  ["l", "л"],
  ["m", "м"],
  ["n", "н"],
  ["o", "о"],
  ["p", "п"],
  ["r", "р"],
  ["s", "с"],
  ["t", "т"],
  ["u", "у"],
  ["f", "ф"],
  ["h", "х"],
  ["c", "к"],
  ["w", "в"],
  ["x", "кс"],
  ["q", "к"],
];

const CYR_TO_LAT: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u",
  ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sht", ъ: "a", ь: "", ю: "yu",
  я: "ya", э: "e", ы: "y",
};

/** Latin letters -> Bulgarian Cyrillic ("milka" -> "милка"). Other chars stay. */
export function translitToCyr(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    let matched = false;
    for (const [lat, cyr] of LAT_TO_CYR) {
      if (s.startsWith(lat, i)) {
        out += cyr;
        i += lat.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += s[i];
      i += 1;
    }
  }
  return out;
}

/** Cyrillic letters -> Latin ("милка" -> "milka"). Other chars stay. */
export function translitToLat(s: string): string {
  let out = "";
  for (const ch of s) out += CYR_TO_LAT[ch] ?? ch;
  return out;
}

const HAS_LATIN = /[a-z]/;
const HAS_CYR = /[Ѐ-ӿ]/;

// ---- query expansion -------------------------------------------------------

/** A variant is a list of words that must all match. */
export type Variant = string[];
/** Alternatives (OR) for one piece of the query. */
export type Group = Variant[];

function addVariant(group: Group, v: Variant) {
  const key = v.join(" ");
  if (key && !group.some((g) => g.join(" ") === key)) group.push(v);
}

/** Splits the query into groups; groups are ANDed, variants inside a group ORed. */
export function expandQuery(query: string): Group[] {
  const tokens = normalize(query).split(" ").filter(Boolean);
  const groups: Group[] = [];
  let i = 0;
  while (i < tokens.length) {
    let consumed = 1;
    let synonyms: readonly string[] | undefined;
    for (let len = Math.min(MAX_PHRASE_WORDS, tokens.length - i); len >= 1; len--) {
      const found = lookupRuBg(tokens.slice(i, i + len).join(" "));
      if (found) {
        synonyms = found;
        consumed = len;
        break;
      }
    }
    const original = tokens.slice(i, i + consumed);
    const group: Group = [];
    addVariant(group, original);
    if (consumed === 1) {
      const tok = original[0];
      if (HAS_LATIN.test(tok) && !HAS_CYR.test(tok)) addVariant(group, [translitToCyr(tok)]);
      else if (HAS_CYR.test(tok)) addVariant(group, [translitToLat(tok)]);
    }
    if (synonyms) for (const s of synonyms) addVariant(group, normalize(s).split(" ").filter(Boolean));
    groups.push(group);
    i += consumed;
  }
  return groups;
}

type MiniQuery = string | { combineWith: "AND" | "OR"; queries: MiniQuery[] };

function toMiniQuery(groups: Group[]): MiniQuery {
  const variantQuery = (v: Variant): MiniQuery =>
    v.length === 1 ? v[0] : { combineWith: "AND", queries: v };
  return {
    combineWith: "AND",
    queries: groups.map((g) => ({ combineWith: "OR" as const, queries: g.map(variantQuery) })),
  };
}

// ---- index -----------------------------------------------------------------

interface Doc {
  id: string;
  name: string;
  brand: string;
  cats: string;
  chain_category: string;
}

export interface SearchIndex {
  mini: MiniSearch<Doc>;
  offers: Map<string, Offer>;
  categories: Category[];
  brands: string[];
}

const SEARCH_OPTIONS = {
  prefix: true,
  fuzzy: (term: string) => (term.length >= 4 ? 0.2 : false),
  boost: { name: 3, brand: 2, cats: 1, chain_category: 1 },
} as const;

const cache = new WeakMap<Catalog, SearchIndex>();

/** Builds the MiniSearch index (memoised per catalog object). */
export function buildSearchIndex(catalog: Catalog): SearchIndex {
  const hit = cache.get(catalog);
  if (hit) return hit;
  const catById = new Map(catalog.categories.map((c) => [c.id, c]));
  const mini = new MiniSearch<Doc>({
    fields: ["name", "brand", "cats", "chain_category"],
    idField: "id",
    processTerm: (term) => normalize(term).replace(/ /g, "") || null,
  });
  const brands = new Map<string, string>();
  const docs: Doc[] = catalog.offers.map((o) => {
    const c = catById.get(o.category);
    if (o.brand) brands.set(normalize(o.brand), o.brand);
    return {
      id: o.id,
      name: o.name,
      brand: o.brand ?? "",
      cats: c ? `${c.bg} ${c.ru}` : "",
      chain_category: o.chain_category ?? "",
    };
  });
  mini.addAll(docs);
  const index: SearchIndex = {
    mini,
    offers: new Map(catalog.offers.map((o) => [o.id, o])),
    categories: catalog.categories,
    brands: [...brands.values()].sort((a, b) => a.localeCompare(b)),
  };
  cache.set(catalog, index);
  return index;
}

/** Offers matching the query, best first. Empty query -> []. */
export function searchOffers(index: SearchIndex, query: string): Offer[] {
  const groups = expandQuery(query);
  if (!groups.length) return [];
  const results = index.mini.search(toMiniQuery(groups) as never, SEARCH_OPTIONS as never);
  const out: Offer[] = [];
  for (const r of results) {
    const o = index.offers.get(String(r.id));
    if (o) out.push(o);
  }
  return out;
}

export interface Suggestions {
  terms: string[];
  categories: Category[];
  brands: string[];
}

/** Autocomplete: words from the index, matching categories and brands. */
export function suggest(index: SearchIndex, query: string, limit = 6): Suggestions {
  const norm = normalize(query);
  if (!norm) return { terms: [], categories: [], brands: [] };
  const groups = expandQuery(norm);
  const probes = [norm];
  if (groups.length === 1) {
    for (const v of groups[0].slice(1, 3)) probes.push(v.join(" "));
  }
  const terms: string[] = [];
  for (const p of probes) {
    for (const s of index.mini.autoSuggest(p, {
      prefix: true,
      fuzzy: (t: string) => (t.length >= 4 ? 0.2 : false),
      combineWith: "AND",
    })) {
      if (!terms.includes(s.suggestion)) terms.push(s.suggestion);
    }
  }
  const needles = new Set<string>([norm]);
  if (HAS_LATIN.test(norm) && !HAS_CYR.test(norm)) needles.add(translitToCyr(norm));
  else if (HAS_CYR.test(norm)) needles.add(translitToLat(norm));
  const matches = (label: string) => {
    const l = normalize(label);
    for (const n of needles) {
      if (l.startsWith(n) || l.includes(` ${n}`)) return true;
    }
    return false;
  };
  const categories = index.categories.filter((c) => matches(c.bg) || matches(c.ru)).slice(0, 3);
  const brands = index.brands.filter(matches).slice(0, 4);
  return { terms: terms.slice(0, limit), categories, brands };
}
