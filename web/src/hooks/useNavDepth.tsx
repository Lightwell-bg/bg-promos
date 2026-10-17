import { createContext, useContext, useEffect, useRef, type MutableRefObject, type ReactNode } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

const NavDepthContext = createContext<MutableRefObject<number>>({ current: 0 });

/**
 * Counts in-app history entries: PUSH adds one, REPLACE (language switch, redirects,
 * filter edits) changes nothing, POP removes one. The first entry of a session is depth 0,
 * so "Back" never leaves the app when there is nothing in-app to go back to.
 * Mount once inside the router.
 */
export function NavDepthProvider({ children }: { children: ReactNode }) {
  const depth = useRef(0);
  const location = useLocation();
  const type = useNavigationType();
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (lastKey.current === null) {
      // Initial entry: it is the session start whatever its navigation type says.
      lastKey.current = location.key;
      return;
    }
    if (lastKey.current === location.key) return;
    lastKey.current = location.key;
    if (type === "PUSH") depth.current += 1;
    else if (type === "POP") depth.current = Math.max(0, depth.current - 1);
  }, [location.key, type]);

  return <NavDepthContext.Provider value={depth}>{children}</NavDepthContext.Provider>;
}

/** Returns a function telling whether there is an in-app entry to go back to. */
export function useCanGoBack(): () => boolean {
  const depth = useContext(NavDepthContext);
  return () => depth.current > 0;
}
