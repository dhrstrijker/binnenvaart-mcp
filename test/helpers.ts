import { vi } from "vitest";

/** A handler that maps an outgoing request URL to a JSON-able response body. */
type FetchHandler = (url: string, init?: RequestInit) => unknown;

/**
 * Replace global fetch with a stub that returns `handler(url)` as the JSON body.
 * Restored automatically before each test (vitest `unstubGlobals`).
 */
export function mockFetch(handler: FetchHandler): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const body = handler(String(input), init);
      return {
        ok: true,
        status: 200,
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      } as unknown as Response;
    }),
  );
}

/** Stub fetch to return a single payload for every request. */
export function mockJson(payload: unknown): void {
  mockFetch(() => payload);
}

/** A route for mockRoutes: match a substring of the URL, reply with status+body. */
interface Route {
  match: string;
  status?: number; // defaults to 200
  body?: unknown; // defaults to {}
}

/**
 * Stub fetch with per-URL routing and status codes. Use this (over mockFetch)
 * when a test needs a non-2xx response — e.g. a 404 so the source throws an
 * HttpError and exercises a fallback. The first route whose `match` is contained
 * in the URL wins; an unmatched URL gets 200 `{}`.
 */
export function mockRoutes(routes: Route[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const route = routes.find((r) => url.includes(r.match));
      const status = route?.status ?? 200;
      const body = route?.body ?? {};
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      } as unknown as Response;
    }),
  );
}

/** Stub fetch to reject as if the network were down. */
export function mockNetworkError(message = "network down"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error(message);
    }),
  );
}
