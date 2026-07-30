// Case Studio: customer side of the case-design platform.
//
// The designer (case-designer.html) is a public page with no Supabase session —
// this function is its only backend, holding the service role like `contracts`.
// Staff work the queue in case-orders.html via direct RLS (shared PIN session),
// so this function deliberately only serves the CUSTOMER motions.
//
// Deploy with verify_jwt OFF (same as contracts): the page sends no auth.
//
// Actions (?action=):
//   create  POST {store, model_id, model_name, price, customer_name,
//                 customer_phone, design, print_b64, mockup_b64}
//           -> uploads the 300 DPI print PNG + mockup to the private
//              `case-prints` bucket, inserts the row, returns {ok, code}.
//              The code is the customer's pickup credential.
//   view    GET &code=XXXXXX -> public-safe status for "check my order"
//   ping    -> warm-up
//
// Guardrails: payload caps (print ≤ 10MB, design json ≤ 200KB), store and
// model ids length-checked, code from an unambiguous alphabet with retry on
// collision. Photo pixels are stripped from `design` client-side — the print
// file is the authoritative artwork.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const BUCKET = "case-prints";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L

function makeCode(): string {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  let s = "";
  for (const b of a) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}

function b64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64.replace(/^data:[^,]*,/, ""));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function create(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }

  const store = String(body.store || "").trim();
  const modelId = String(body.model_id || "").trim();
  const modelName = String(body.model_name || "").slice(0, 80);
  const custName = String(body.customer_name || "").trim().slice(0, 80);
  const custPhone = String(body.customer_phone || "").trim().slice(0, 25);
  const price = Number(body.price) || null;
  const design = body.design;
  const printB64 = String(body.print_b64 || "");
  const mockupB64 = String(body.mockup_b64 || "");

  if (!store || store.length > 40) return json({ ok: false, error: "bad store" }, 400);
  if (!modelId || modelId.length > 60) return json({ ok: false, error: "bad model" }, 400);
  if (!custName) return json({ ok: false, error: "name required" }, 400);
  if (!printB64 || printB64.length > 14_000_000) return json({ ok: false, error: "bad print file" }, 400);
  if (mockupB64.length > 8_000_000) return json({ ok: false, error: "bad mockup" }, 400);
  if (!design || JSON.stringify(design).length > 200_000) return json({ ok: false, error: "bad design" }, 400);

  const id = crypto.randomUUID();
  const now = new Date();
  const dir = `designs/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const printPath = `${dir}/${id}-print.png`;
  const mockupPath = mockupB64 ? `${dir}/${id}-mockup.png` : null;

  const up1 = await admin.storage.from(BUCKET).upload(printPath, b64ToBytes(printB64), {
    contentType: "image/png", upsert: false,
  });
  if (up1.error) return json({ ok: false, error: "print upload failed" }, 500);
  if (mockupPath) {
    await admin.storage.from(BUCKET).upload(mockupPath, b64ToBytes(mockupB64), {
      contentType: "image/png", upsert: false,
    }); // mockup is best-effort; the queue falls back to no thumbnail
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode();
    const ins = await admin.from("case_designs").insert({
      id, code, store, model_id: modelId, model_name: modelName, price,
      customer_name: custName, customer_phone: custPhone || null,
      design, print_path: printPath, mockup_path: mockupPath,
    });
    if (!ins.error) return json({ ok: true, code });
    if (!String(ins.error.message || "").includes("duplicate")) {
      return json({ ok: false, error: "save failed" }, 500);
    }
  }
  return json({ ok: false, error: "save failed" }, 500);
}

async function view(url: URL): Promise<Response> {
  const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) return json({ ok: false, error: "bad code" }, 400);
  const { data } = await admin.from("case_designs")
    .select("code, store, model_name, status, created_at, mockup_path").eq("code", code).maybeSingle();
  if (!data) return json({ ok: false, error: "not found" }, 404);
  let mockup_url: string | null = null;
  if (data.mockup_path) {
    const s = await admin.storage.from(BUCKET).createSignedUrl(data.mockup_path, 60 * 60 * 24 * 7);
    mockup_url = s.data?.signedUrl || null;
  }
  return json({
    ok: true,
    order: { code: data.code, store: data.store, model_name: data.model_name,
             status: data.status, created_at: data.created_at, mockup_url },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";
  try {
    if (action === "ping") return json({ ok: true });
    if (action === "create" && req.method === "POST") return await create(req);
    if (action === "view") return await view(url);
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "server error" }, 500);
  }
});
