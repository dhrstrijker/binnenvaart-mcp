/**
 * The tiniest HTTP-JSON client we need. It GETs or POSTs a URL, parses JSON, and
 * fails loudly (with status + url) on a non-2xx response. It times out so a hung
 * upstream can never hang the tool. A bearer token is attached only if provided
 * — EuRIS open data needs none (see docs/adr/0001-open-data-only.md).
 */

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface RequestOptions {
  token?: string;
  timeoutMs?: number;
}

async function requestJson<T>(url: string, init: RequestInit, options: RequestOptions): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(init.headers ?? {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(`HTTP ${response.status}: ${text.slice(0, 180)}`, response.status, url);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** GET a URL and parse the JSON body. */
export async function getJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  return requestJson<T>(url, { method: "GET" }, options);
}

/** POST a JSON body to a URL and parse the JSON response. */
export async function postJson<T>(url: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  return requestJson<T>(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    options,
  );
}
