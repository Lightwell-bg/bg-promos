/**
 * Service-worker handler for page navigations (registered via workbox runtimeCaching).
 *
 * IMPORTANT: workbox serialises this function with toString() into sw.js, so it must be
 * fully self-contained: no imports, no references to module-level values, no helpers.
 *
 * Races the network against a 4 s timeout. The precached app shell (/index.html) is
 * returned on timeout, network error or an HTTP status >= 500; any other response
 * (including 3xx/4xx) is returned as is. Pages are never cached at runtime: stale
 * prerendered HTML would reference hashed assets that a newer deploy deleted.
 */
export const navigationHandler = async ({ request }: { request: Request }): Promise<Response> => {
  // Precache keys carry a ?__WB_REVISION__ suffix, hence ignoreSearch.
  const shell = () => caches.match("/index.html", { ignoreSearch: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("navigation timeout")), 4000);
    });
    const response = await Promise.race([fetch(request), timeout]);
    if (response.status >= 500) {
      const fallback = await shell();
      if (fallback) return fallback;
    }
    return response;
  } catch (err) {
    const fallback = await shell();
    if (fallback) return fallback;
    throw err;
  } finally {
    clearTimeout(timer);
  }
};
