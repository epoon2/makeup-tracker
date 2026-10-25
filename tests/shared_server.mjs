/*
  A stand-in for the Netlify site, for trying shared mode on one computer:

    npm install
    node tests/shared_server.mjs          then open http://localhost:8890

  It serves index.html with the same security headers as netlify.toml and answers /api/*
  with the real server code (netlify/lib/core.mjs) on the Netlify Blobs test server, so
  nothing is stored anywhere but a temporary folder. The setup code is "local-setup-code".
  tests/shared_browser.mjs uses it to drive two browsers against one shared copy.
*/

import { createServer } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BlobsServer } from "@netlify/blobs/server";
import { getStore } from "@netlify/blobs";
import { createApi } from "../netlify/lib/core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SETUP_CODE = "local-setup-code";

// The headers netlify.toml sets on every response, read from the file itself so this
// stand-in cannot drift from what Netlify serves.
export function netlifyHeaders() {
  const toml = readFileSync(join(ROOT, "netlify.toml"), "utf8");
  const block = toml.slice(toml.indexOf("[headers.values]"));
  const headers = {};
  for (const line of block.split("\n").slice(1)) {
    const m = line.match(/^\s*([A-Za-z-]+)\s*=\s*"(.*)"\s*$/);
    if (m) headers[m[1]] = m[2];
    else if (line.trim().startsWith("[")) break;
  }
  return headers;
}

export async function startSite({ port = 0, iterations = 1000, secureCookie = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "makeup-site-"));
  const blobs = new BlobsServer({ directory: dir, token: "local-token" });
  const blobsPort = (await blobs.start()).port;
  const url = "http://localhost:" + blobsPort;
  const open = (name) => getStore({ name, siteID: "local-site", token: "local-token", edgeURL: url, uncachedEdgeURL: url, consistency: "strong" });
  const stores = { authStore: open("makeup-auth"), dataStore: open("makeup-data") };
  const api = createApi({ ...stores, env: { SETUP_CODE }, cache: {}, iterations, secureCookie });
  const headers = netlifyHeaders();

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://x").pathname;
      if (path.startsWith("/api/") || path === "/api") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const request = new Request("http://" + req.headers.host + req.url, {
          method: req.method,
          headers: Object.entries(req.headers).filter(([, v]) => typeof v === "string"),
          body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
        });
        const answer = await api(request, { ip: req.socket.remoteAddress });
        const out = { ...headers };
        answer.headers.forEach((v, k) => { out[k] = v; });
        res.writeHead(answer.status, out);
        res.end(Buffer.from(await answer.arrayBuffer()));
        return;
      }
      if (path === "/" || path === "/index.html") {
        res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(join(ROOT, "index.html")));
        return;
      }
      res.writeHead(404, headers);
      res.end("Not found");
    } catch (err) {
      res.writeHead(500);
      res.end(String(err && err.message));
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: "http://localhost:" + server.address().port,
    stores,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await blobs.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const site = await startSite({ port: Number(process.env.PORT || 8890) });
  console.log("Shared makeup calculator stand-in at " + site.url + "  (setup code: " + SETUP_CODE + ")");
  console.log("Data lives in a temporary folder and is deleted on Ctrl+C.");
  process.on("SIGINT", async () => { await site.close(); process.exit(0); });
}
