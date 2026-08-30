import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import type {
  PreparationFailureCode,
  PreparationRedirectView,
} from "../../shared/preparation.js";

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface PublicHostResolver {
  resolve(hostname: string): Promise<readonly ResolvedAddress[]>;
}

export interface PinnedHttpsResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Uint8Array;
}

export interface PinnedHttpsTransport {
  request(input: Readonly<{
    url: URL;
    address: ResolvedAddress;
    timeoutMs: number;
    maxBytes: number;
    signal?: AbortSignal;
  }>): Promise<PinnedHttpsResponse>;
}

export interface PublicWebFetchLimits {
  readonly maxSourceBytes: number;
  readonly maxRedirects: number;
  readonly requestTimeoutMs: number;
  readonly signal?: AbortSignal;
}

export type PublicWebFetchResult =
  | {
      readonly ok: true;
      readonly requestedUrl: string;
      readonly finalUrl: string;
      readonly mediaType: "html" | "pdf";
      readonly bytes: Uint8Array;
      readonly contentHash: string;
      readonly redirects: readonly PreparationRedirectView[];
    }
  | {
      readonly ok: false;
      readonly requestedUrl: string;
      readonly finalUrl: string | null;
      readonly failureCode: PreparationFailureCode;
      readonly detail: string;
      readonly redirects: readonly PreparationRedirectView[];
    };

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class PublicWebFetchAbortedError extends Error {
  public constructor() {
    super("preparation_aborted");
    this.name = "AbortError";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PublicWebFetchAbortedError();
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new PublicWebFetchAbortedError());
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function ipv4Parts(address: string): readonly [number, number, number, number] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts as [number, number, number, number]
    : null;
}

function normalizedIpv6(address: string): string {
  return address.toLowerCase().split("%")[0] ?? "";
}

function ipv6Value(address: string): bigint | null {
  let value = normalizedIpv6(address);
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const dotted = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u.exec(value)?.[1];
  if (dotted !== undefined) {
    const parts = ipv4Parts(dotted);
    if (parts === null) return null;
    const replacement = `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
    value = value.slice(0, -dotted.length) + replacement;
  }
  if (!/^[\da-f:]+$/u.test(value) || value.split("::").length > 2) return null;
  const [leftRaw, rightRaw] = value.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const omitted = value.includes("::") ? 8 - left.length - right.length : 0;
  if (omitted < 0 || (!value.includes("::") && left.length !== 8)) return null;
  const segments = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
  if (segments.length !== 8 || segments.some((segment) => segment.length > 4)) return null;
  let result = 0n;
  for (const segment of segments) {
    const parsed = Number.parseInt(segment || "0", 16);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) return null;
    result = (result << 16n) | BigInt(parsed);
  }
  return result;
}

function ipv6Prefix(value: bigint, bits: number): bigint {
  return value >> BigInt(128 - bits);
}

/** Conservative public-address check. Documentation/reserved ranges fail closed. */
export function isPublicAddress(address: string): boolean {
  const ipv4 = ipv4Parts(address);
  if (ipv4) {
    const [a, b, c] = ipv4;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }

  if (isIP(address) !== 6) return false;
  const value = ipv6Value(address);
  if (value === null || value <= 1n) return false;
  if (ipv6Prefix(value, 7) === 0x7en) return false; // fc00::/7 unique-local
  if (ipv6Prefix(value, 10) === 0x3fan) return false; // fe80::/10 link-local
  if (ipv6Prefix(value, 8) === 0xffn) return false; // ff00::/8 multicast
  if (ipv6Prefix(value, 32) === 0x20010db8n) return false; // documentation
  if (ipv6Prefix(value, 32) === 0x20010000n) return false; // Teredo/special
  if (ipv6Prefix(value, 16) === 0x2002n) return false; // 6to4 embeds IPv4
  if (ipv6Prefix(value, 16) === 0x100n) return false; // discard-only/special
  if (ipv6Prefix(value, 96) === 0xffffn) {
    const embedded = Number(value & 0xffff_ffffn);
    return isPublicAddress([
      (embedded >>> 24) & 0xff,
      (embedded >>> 16) & 0xff,
      (embedded >>> 8) & 0xff,
      embedded & 0xff,
    ].join("."));
  }
  // Deprecated IPv4-compatible addresses can otherwise tunnel a private v4.
  if (ipv6Prefix(value, 96) === 0n) return false;
  return true;
}

function canonicalHttpsUrl(value: string, base?: URL): URL | null {
  let parsed: URL;
  try {
    parsed = base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:"
    || (parsed.port !== "" && parsed.port !== "443")
    || parsed.username !== ""
    || parsed.password !== ""
  ) {
    return null;
  }
  parsed.hash = "";
  return parsed;
}

function normalizedHostname(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function mediaType(value: string | undefined): "html" | "pdf" | null {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "text/html" || normalized === "application/xhtml+xml") return "html";
  if (normalized === "application/pdf") return "pdf";
  return null;
}

export class NodePublicHostResolver implements PublicHostResolver {
  public async resolve(hostname: string): Promise<readonly ResolvedAddress[]> {
    const host = normalizedHostname(hostname);
    if (isIP(host) === 4) return [{ address: host, family: 4 }];
    if (isIP(host) === 6) return [{ address: host, family: 6 }];
    const results = await lookup(host, { all: true, verbatim: true });
    return results
      .filter((result): result is { address: string; family: 4 | 6 } => result.family === 4 || result.family === 6)
      .map(({ address, family }) => ({ address, family }));
  }
}

/**
 * Collect one response after installing its terminal error handler. The order
 * matters: destroying an oversized IncomingMessage with an Error before a
 * listener exists would emit an uncaught process-level `error` event.
 */
export function readBoundedHttpsResponse(
  response: IncomingMessage,
  maxBytes: number,
): Promise<PinnedHttpsResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    response.once("error", reject);

    const declaredLength = Number(response.headers["content-length"] ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      response.destroy(new Error("response_too_large"));
      return;
    }
    response.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) {
        response.destroy(new Error("response_too_large"));
        return;
      }
      chunks.push(bytes);
    });
    response.once("end", () => {
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
      }
      resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
    });
  });
}

export class NodePinnedHttpsTransport implements PinnedHttpsTransport {
  public request(input: Readonly<{
    url: URL;
    address: ResolvedAddress;
    timeoutMs: number;
    maxBytes: number;
    signal?: AbortSignal;
  }>): Promise<PinnedHttpsResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let activeResponse: IncomingMessage | null = null;
      const request = httpsRequest({
        protocol: "https:",
        hostname: input.address.address,
        family: input.address.family,
        port: 443,
        path: `${input.url.pathname}${input.url.search}`,
        method: "GET",
        // URL.hostname retains brackets for IPv6 literals in Node. TLS expects
        // the unbracketed host name while the HTTP Host header keeps the URL
        // authority form.
        servername: normalizedHostname(input.url.hostname),
        rejectUnauthorized: true,
        headers: {
          host: input.url.host,
          accept: "text/html, application/xhtml+xml, application/pdf;q=0.9",
          "accept-encoding": "identity",
          "user-agent": "AISB-Learning-Companion/0.1 reference-cache",
        },
      });
      const finish = <T>(callback: (value: T) => void, value: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        callback(value);
      };
      const abort = () => {
        const error = new PublicWebFetchAbortedError();
        if (activeResponse !== null) activeResponse.destroy(error);
        request.destroy(error);
      };
      const timer = setTimeout(() => {
        request.destroy(new Error("request_timeout"));
      }, input.timeoutMs);
      timer.unref?.();

      request.once("response", (response) => {
        activeResponse = response;
        void readBoundedHttpsResponse(response, input.maxBytes).then(
          (value) => finish(resolve, value),
          (error: unknown) => finish(reject, error),
        );
      });
      request.once("error", (error) => {
        finish(reject, error);
      });
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
      else request.end();
    });
  }
}

export class PinnedPublicWebFetcher {
  public constructor(
    private readonly resolver: PublicHostResolver = new NodePublicHostResolver(),
    private readonly transport: PinnedHttpsTransport = new NodePinnedHttpsTransport(),
  ) {}

  public async fetch(urlValue: string, limits: PublicWebFetchLimits): Promise<PublicWebFetchResult> {
    const requested = canonicalHttpsUrl(urlValue);
    if (requested === null) {
      return this.failure(urlValue, null, "insecure_redirect", "Only credential-free HTTPS URLs on port 443 are allowed.", []);
    }

    const visited = new Set<string>();
    const redirects: PreparationRedirectView[] = [];
    let current = requested;
    for (;;) {
      throwIfAborted(limits.signal);
      const currentValue = current.toString();
      if (visited.has(currentValue)) {
        return this.failure(requested.toString(), currentValue, "redirect_loop", "The source redirected in a loop.", redirects);
      }
      visited.add(currentValue);

      let addresses: readonly ResolvedAddress[];
      try {
        addresses = await withAbort(this.resolver.resolve(current.hostname), limits.signal);
      } catch (error) {
        if (error instanceof PublicWebFetchAbortedError) throw error;
        return this.failure(requested.toString(), currentValue, "dns_unavailable", "The public host could not be resolved.", redirects);
      }
      if (addresses.length === 0) {
        return this.failure(requested.toString(), currentValue, "dns_unavailable", "The public host returned no usable addresses.", redirects);
      }
      if (addresses.some(({ address }) => !isPublicAddress(address))) {
        return this.failure(requested.toString(), currentValue, "private_address", "The source resolved to a private or reserved address.", redirects);
      }
      const address = [...addresses].sort((left, right) => left.address.localeCompare(right.address))[0]!;

      let response: PinnedHttpsResponse;
      try {
        response = await this.transport.request({
          url: current,
          address,
          timeoutMs: limits.requestTimeoutMs,
          maxBytes: limits.maxSourceBytes,
          ...(limits.signal === undefined ? {} : { signal: limits.signal }),
        });
      } catch (error) {
        if (error instanceof PublicWebFetchAbortedError || limits.signal?.aborted) {
          throw new PublicWebFetchAbortedError();
        }
        const code = error instanceof Error && error.message === "request_timeout"
          ? "request_timeout"
          : error instanceof Error && error.message === "response_too_large"
            ? "response_too_large"
            : "network_error";
        const detail = code === "request_timeout"
          ? "The source did not respond within the bounded request time."
          : code === "response_too_large"
            ? "The source exceeded the per-resource byte limit."
            : "The public HTTPS request failed.";
        return this.failure(requested.toString(), currentValue, code, detail, redirects);
      }
      throwIfAborted(limits.signal);

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.location;
        if (!location) {
          return this.failure(requested.toString(), currentValue, "invalid_response", "The redirect omitted its destination.", redirects);
        }
        if (redirects.length >= limits.maxRedirects) {
          return this.failure(requested.toString(), currentValue, "redirect_limit", "The source exceeded the redirect limit.", redirects);
        }
        const next = canonicalHttpsUrl(location, current);
        if (next === null) {
          return this.failure(requested.toString(), currentValue, "insecure_redirect", "The source redirected outside bounded HTTPS.", redirects);
        }
        redirects.push({
          from: currentValue,
          to: next.toString(),
          status: response.status as 301 | 302 | 303 | 307 | 308,
        });
        current = next;
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        return this.failure(requested.toString(), currentValue, "http_error", `The source returned HTTP ${response.status}.`, redirects);
      }
      if ((response.headers["content-encoding"] ?? "identity").toLowerCase() !== "identity") {
        return this.failure(requested.toString(), currentValue, "invalid_response", "Compressed responses are not accepted by this bounded fetcher.", redirects);
      }
      const kind = mediaType(response.headers["content-type"]);
      if (kind === null) {
        return this.failure(requested.toString(), currentValue, "unsupported_media_type", "Only public HTML and PDF sources are cached in this version.", redirects);
      }
      if (response.body.byteLength > limits.maxSourceBytes) {
        return this.failure(requested.toString(), currentValue, "response_too_large", "The source exceeded the per-resource byte limit.", redirects);
      }
      return Object.freeze({
        ok: true as const,
        requestedUrl: requested.toString(),
        finalUrl: currentValue,
        mediaType: kind,
        bytes: response.body,
        contentHash: `sha256:${createHash("sha256").update(response.body).digest("hex")}`,
        redirects: Object.freeze(redirects.map((redirect) => Object.freeze({ ...redirect }))),
      });
    }
  }

  private failure(
    requestedUrl: string,
    finalUrl: string | null,
    failureCode: PreparationFailureCode,
    detail: string,
    redirects: readonly PreparationRedirectView[],
  ): PublicWebFetchResult {
    return Object.freeze({
      ok: false as const,
      requestedUrl,
      finalUrl,
      failureCode,
      detail,
      redirects: Object.freeze(redirects.map((redirect) => Object.freeze({ ...redirect }))),
    });
  }
}
