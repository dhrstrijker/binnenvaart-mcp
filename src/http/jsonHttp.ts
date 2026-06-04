/**
 * The tiniest HTTP-JSON client we need. One job: GET a URL, parse JSON, and
 * fail loudly (with status + url) on a non-2xx response. It times out so a hung
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

export async function getJson<T>(
  url: string,
  options: { token?: string; timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
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
