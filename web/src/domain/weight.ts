/** Weight number with a comma decimal and without trailing zeros: 250 -> "0,25", 1000 -> "1", 1300 -> "1,3". */
export function formatKg(grams: number): string {
  const kg = Math.round(grams) / 1000;
  return String(kg).replace(".", ",");
}

/** 250 -> "0,25 кг" (unit is the localized short label, e.g. "кг" or "л"). */
export function formatWeight(grams: number, unit: string): string {
  return `${formatKg(grams)} ${unit}`;
}
