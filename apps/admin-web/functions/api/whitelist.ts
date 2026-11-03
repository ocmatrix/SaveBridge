import { submitWhitelist, type SubmitEnv } from "../_lib/submit";

interface Ctx {
  request: Request;
  env: SubmitEnv & { ALLOWED_ORIGINS?: string };
}

const MAX_BODY = 100_000; // 500 addresses ≈ 25 KB
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });

/** POST /api/whitelist — same-origin only; body per SubmitBody. */
export const onRequestPost = async ({ request, env }: Ctx): Promise<Response> => {
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get("origin");
  if (!origin || !allowed.includes(origin)) return json(403, { ok: false, error: "origin not allowed" });
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return json(413, { ok: false, error: "body too large" });
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return json(413, { ok: false, error: "body too large" });
    body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: "invalid json" });
  }
  const r = await submitWhitelist(env, body);
  return json(r.status, r.json);
};

export const onRequest = async (): Promise<Response> => json(405, { ok: false, error: "method not allowed" });
