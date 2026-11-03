import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { fetchWebPage, htmlToText, isPrivateAddress } from "./web-fetch.js";

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The local test server is 127.0.0.1, only 10.x is considered as the intranet. */
const onlyTenIsPrivate = (address: string) => address.startsWith("10.");

describe("isPrivateAddress", () => {
  it("拦本机、内网、链路本地和 IPv4 映射地址，放行公网地址", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "140.82.112.3", "2606:4700::1111"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("fetchWebPage", () => {
  it("拒绝非 http 协议、带账号密码的网址和本机地址", async () => {
    await expect(fetchWebPage("file:///etc/passwd")).rejects.toThrow("Can only fetch http or https URLs");
    await expect(fetchWebPage("https://user:pass@example.com/")).rejects.toThrow("URLs cannot include username or password");
    await expect(fetchWebPage("not a url")).rejects.toThrow("不是合法的网址");
    await expect(fetchWebPage("http://127.0.0.1:1/")).rejects.toThrow("Cannot access local or intranet address");
    await expect(fetchWebPage("http://[::1]:1/")).rejects.toThrow("Cannot access local or intranet address");
  });

  it("域名解析到本机时在连接前拒绝", async () => {
    const base = await serve((_req, res) => res.end("should not be reached"));
    const port = new URL(base).port;
    await expect(fetchWebPage(`http://localhost:${port}/`)).rejects.toThrow("Cannot access localhost or internal network address");
  });

  it("读取网页正文并解压 gzip", async () => {
    const html = "<html><head><title>Docs &amp; Guide</title></head><body><nav>menu</nav><main><h1>Intro</h1>" +
      `<p>${"Read this paragraph. ".repeat(12)}</p><a href="/next">Next page</a></main></body></html>`;
    const base = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
      res.end(gzipSync(html));
    });
    const page = await fetchWebPage(`${base}/docs`, { isBlockedAddress: onlyTenIsPrivate });
    expect(page.title).toBe("Docs & Guide");
    expect(page.text).toContain("# Intro");
    expect(page.text).toContain(`[Next page](${base}/next)`);
    expect(page.text).not.toContain("menu");
    expect(page.truncated).toBe(false);
  });

  it("重定向的每一跳都重新校验地址", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/hop") {
        res.writeHead(302, { location: "/final" }).end();
      } else if (req.url === "/final") {
        res.writeHead(200, { "content-type": "text/plain" }).end("arrived");
      } else {
        res.writeHead(302, { location: "http://10.0.0.1/admin" }).end();
      }
    });
    await expect(fetchWebPage(`${base}/hop`, { isBlockedAddress: onlyTenIsPrivate })).resolves.toMatchObject({
      url: `${base}/final`, text: "arrived",
    });
    await expect(fetchWebPage(`${base}/evil`, { isBlockedAddress: onlyTenIsPrivate })).rejects.toThrow("不能访问本机或内网地址");
  });

  it("错误状态码和非文本内容给出可读的原因", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/missing") res.writeHead(404).end("nope");
      else res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([0x89, 0x50]));
    });
    await expect(fetchWebPage(`${base}/missing`, { isBlockedAddress: onlyTenIsPrivate })).rejects.toThrow("网页返回 HTTP 404");
    await expect(fetchWebPage(`${base}/logo.png`, { isBlockedAddress: onlyTenIsPrivate })).rejects.toThrow("不是文本网页（image/png）");
  });
});

describe("htmlToText", () => {
  it("保留标题、列表、代码块和链接，去掉脚本与样式", () => {
    const { title, text } = htmlToText(
      "<title>API</title><style>.a{}</style><script>alert(1)</script>" +
        "<h2>Usage</h2><ul><li>first</li><li>second &lt;b&gt;</li></ul>" +
        "<pre><code>const a = 1 &lt; 2;\nrun();</code></pre><p>See <a href=\"guide.html\">the guide</a> and <code>run()</code>.</p>",
      new URL("https://example.com/docs/"),
    );
    expect(title).toBe("API");
    expect(text).not.toMatch(/alert|\.a\{\}/);
    expect(text).toContain("## Usage");
    expect(text).toContain("- first\n- second <b>");
    expect(text).toContain("```\nconst a = 1 < 2;\nrun();\n```");
    expect(text).toContain("See [the guide](https://example.com/docs/guide.html) and `run()`.");
  });
});
