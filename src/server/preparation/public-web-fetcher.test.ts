import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  PinnedPublicWebFetcher,
  isPublicAddress,
  readBoundedHttpsResponse,
  type PinnedHttpsTransport,
  type PublicHostResolver,
  type ResolvedAddress,
} from "./public-web-fetcher.js";

describe("readBoundedHttpsResponse", () => {
  it("installs an error listener before destroying an oversized declared response", async () => {
    const response = new PassThrough() as PassThrough & {
      headers: Record<string, string>;
      statusCode: number;
    };
    response.headers = { "content-length": "2048" };
    response.statusCode = 200;
    const destroy = response.destroy.bind(response);
    const destroySpy = vi.spyOn(response, "destroy").mockImplementation((error?: Error) => {
      expect(response.listenerCount("error")).toBeGreaterThan(0);
      return destroy(error);
    });

    await expect(readBoundedHttpsResponse(response as never, 1_024))
      .rejects.toThrow("response_too_large");
    expect(destroySpy).toHaveBeenCalledOnce();
  });
});

const limits = Object.freeze({
  maxSourceBytes: 1_024,
  maxRedirects: 2,
  requestTimeoutMs: 500,
});

class FakeResolver implements PublicHostResolver {
  public constructor(private readonly values: Readonly<Record<string, readonly ResolvedAddress[]>>) {}

  public async resolve(hostname: string): Promise<readonly ResolvedAddress[]> {
    return this.values[hostname] ?? [];
  }
}

class FakeTransport implements PinnedHttpsTransport {
  public readonly requests: { readonly url: string; readonly address: string }[] = [];

  public constructor(private readonly responses: Readonly<Record<string, {
    readonly status: number;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly body?: string;
  }>>) {}

  public async request(input: Parameters<PinnedHttpsTransport["request"]>[0]) {
    this.requests.push({ url: input.url.toString(), address: input.address.address });
    const response = this.responses[input.url.toString()];
    if (!response) throw new Error("unexpected request");
    return {
      status: response.status,
      headers: response.headers,
      body: Buffer.from(response.body ?? "", "utf8"),
    };
  }
}

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.20.0.1",
    "192.168.1.1",
    "203.0.113.4",
    "::1",
    "fd00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "2002:7f00:1::",
  ])("rejects private or reserved address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => expect(isPublicAddress(address)).toBe(true),
  );
});

describe("PinnedPublicWebFetcher", () => {
  it("pins the validated public address and returns bounded HTML", async () => {
    const transport = new FakeTransport({
      "https://example.com/reading": {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "content-encoding": "identity" },
        body: "<h1>Reading</h1>",
      },
    });
    const fetcher = new PinnedPublicWebFetcher(
      new FakeResolver({ "example.com": [{ address: "93.184.216.34", family: 4 }] }),
      transport,
    );

    const result = await fetcher.fetch("https://example.com/reading#part", limits);

    expect(result).toMatchObject({
      ok: true,
      requestedUrl: "https://example.com/reading",
      finalUrl: "https://example.com/reading",
      mediaType: "html",
    });
    expect(transport.requests).toEqual([
      { url: "https://example.com/reading", address: "93.184.216.34" },
    ]);
  });

  it("fails closed when any DNS answer is private and never reaches transport", async () => {
    const transport = new FakeTransport({});
    const fetcher = new PinnedPublicWebFetcher(
      new FakeResolver({
        "mixed.example": [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }),
      transport,
    );

    await expect(fetcher.fetch("https://mixed.example/source", limits)).resolves.toMatchObject({
      ok: false,
      failureCode: "private_address",
    });
    expect(transport.requests).toEqual([]);
  });

  it("validates and pins every redirect target", async () => {
    const transport = new FakeTransport({
      "https://example.com/start": {
        status: 302,
        headers: { location: "https://cdn.example/final" },
      },
      "https://cdn.example/final": {
        status: 200,
        headers: { "content-type": "application/pdf", "content-encoding": "identity" },
        body: "%PDF-1.7",
      },
    });
    const fetcher = new PinnedPublicWebFetcher(
      new FakeResolver({
        "example.com": [{ address: "93.184.216.34", family: 4 }],
        "cdn.example": [{ address: "1.1.1.1", family: 4 }],
      }),
      transport,
    );

    const result = await fetcher.fetch("https://example.com/start", limits);

    expect(result).toMatchObject({ ok: true, finalUrl: "https://cdn.example/final", mediaType: "pdf" });
    expect(result.redirects).toEqual([
      { from: "https://example.com/start", to: "https://cdn.example/final", status: 302 },
    ]);
    expect(transport.requests.map(({ address }) => address)).toEqual(["93.184.216.34", "1.1.1.1"]);
  });

  it("rejects redirects to HTTP before resolving or requesting them", async () => {
    const transport = new FakeTransport({
      "https://example.com/start": {
        status: 301,
        headers: { location: "http://127.0.0.1/private" },
      },
    });
    const fetcher = new PinnedPublicWebFetcher(
      new FakeResolver({ "example.com": [{ address: "93.184.216.34", family: 4 }] }),
      transport,
    );

    await expect(fetcher.fetch("https://example.com/start", limits)).resolves.toMatchObject({
      ok: false,
      failureCode: "insecure_redirect",
    });
    expect(transport.requests).toHaveLength(1);
  });

  it("rejects unsupported content types without exposing bytes", async () => {
    const fetcher = new PinnedPublicWebFetcher(
      new FakeResolver({ "example.com": [{ address: "93.184.216.34", family: 4 }] }),
      new FakeTransport({
        "https://example.com/video": {
          status: 200,
          headers: { "content-type": "video/mp4", "content-encoding": "identity" },
          body: "not retained",
        },
      }),
    );

    await expect(fetcher.fetch("https://example.com/video", limits)).resolves.toMatchObject({
      ok: false,
      failureCode: "unsupported_media_type",
    });
  });

  it("fails closed when a transport returns more bytes than the source limit", async () => {
    const fetcher = new PinnedPublicWebFetcher(
      new FakeResolver({ "example.com": [{ address: "93.184.216.34", family: 4 }] }),
      new FakeTransport({
        "https://example.com/large": {
          status: 200,
          headers: { "content-type": "text/html", "content-encoding": "identity" },
          body: "x".repeat(limits.maxSourceBytes + 1),
        },
      }),
    );

    await expect(fetcher.fetch("https://example.com/large", limits)).resolves.toMatchObject({
      ok: false,
      failureCode: "response_too_large",
    });
  });
});
