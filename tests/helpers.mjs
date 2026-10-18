import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A fake engine API: routes = { "/path": object | (req, url) => object }.
export async function mockServer(routes) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const r = routes[u.pathname];
    if (r === undefined) { res.writeHead(404); return res.end(); }
    let body = "";
    for await (const c of req) body += c;
    const out = typeof r === "function" ? await r(req, u, body) : r;
    if (typeof out === "string") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(out); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}`, port: server.address().port, close: () => server.close() };
}

export function tempFile(name, content = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wattllama-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return { file, append: (s) => fs.appendFileSync(file, s), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function tokenSink() {
  const got = new Map();
  const addTokens = (model, gen, pp, req = 0) => {
    const p = got.get(model) || { gen: 0, pp: 0, req: 0 };
    p.gen += gen; p.pp += pp; p.req += req; got.set(model, p);
  };
  return { got, addTokens };
}
