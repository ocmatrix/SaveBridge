/**
 * admin.wanto.pro/api/admin/* → RELAYER_ORIGIN/admin/* (DESIGN §8.2). Untrusted by design: no secrets, no checks
 * that the relayer would rely on — the relayer verifies the SIWE session itself. Forwards only GET/POST, only
 * /api/admin/*, only the Authorization + Content-Type headers, never cookies.
 */
export interface Env {
  RELAYER_ORIGIN: string;
}

export async function forward(req: Request, env: Env, fetchFn: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/admin/")) return new Response("not found", { status: 404 });
  if (req.method !== "GET" && req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!env.RELAYER_ORIGIN) return new Response("relayer not configured", { status: 503 });
  const target = new URL(url.pathname.slice("/api".length) + url.search, env.RELAYER_ORIGIN);
  const headers = new Headers();
  for (const h of ["authorization", "content-type"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const res = await fetchFn(target.toString(), { method: req.method, headers, body: req.method === "POST" ? await req.text() : undefined });
  return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
}

export default { fetch: (req: Request, env: Env) => forward(req, env) };
