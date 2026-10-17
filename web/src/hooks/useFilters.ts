import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { parseFilters, serializeFilters, type Filters } from "../domain/filters";

/** Filters & sort live in the URL query so a filtered catalog can be shared. */
export function useFilters(): [Filters, (f: Filters) => void] {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  const setFilters = useCallback(
    (f: Filters) => setParams(serializeFilters(f), { replace: true }),
    [setParams],
  );
  return [filters, setFilters];
}
