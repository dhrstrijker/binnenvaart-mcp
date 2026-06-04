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

/** Stub fetch to reject as if the network were down. */
export function mockNetworkError(message = "network down"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error(message);
    }),
  );
}
