// =============================================================================
// receipts-inbound — email a receipt in, get a review item out.
//
// The Resend inbound webhook (email.received) POSTs here when mail lands on the
// receipts address. Every PDF/image attachment becomes ONE expense_receipts row:
// the file goes into the private 'receipts' bucket, Claude reads vendor / date /
// amount / card digits off it, the card digits pick the Paid With account (via
// the qbo function's pay_accounts — this function NEVER touches the QBO token
// machinery, the single-flight refresh lives in qbo only), and the row lands as
// status 'review' with source 'email' — the owner's queue on receipts.html.
//
//   POST ?s=<RECEIPTS_INBOUND_SECRET>   body = Resend email.received event
//        { type:'email.received', data:{ email_id, from, subject,
//          attachments:[{ id, filename, content_type[, content_b64] }] } }
//
// Attachment content comes from Resend's attachments API (download_url); an
// attachment carrying content_b64 inline skips that fetch, so a Zapier email
// parser (or a test) can POST the same shape directly.
//
// Idempotent: source_ref 'email:<email_id>:<attachment_id>' is unique — Resend
// webhook retries and double-fires insert nothing twice.
//
// Secrets: RECEIPTS_INBOUND_SECRET, RESEND_API_KEY, ANTHROPIC_API_KEY,
//          NOTIFY_SECRET (+ SUPABASE_URL / SERVICE_ROLE_KEY).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("RECEIPTS_INBOUND_SECRET") || "";
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const ANTHROPIC = Deno.env.get("ANTHROPIC_API_KEY") || "";
const NOTIFY = Deno.env.get("NOTIFY_SECRET") || "";

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Att = { id?: string; filename?: string; content_type?: string; content_b64?: string };

const EXT: Record<string, string> = {
  "application/pdf": "pdf", "image/jpeg": "jpg", "image/jpg": "jpg",
  "image/png": "png", "image/webp": "webp",
};
function extOf(a: Att): string | null {
  const byType = EXT[String(a.content_type || "").toLowerCase().split(";")[0]];
  if (byType) return byType;
  const m = String(a.filename || "").toLowerCase().match(/\.(pdf|png|webp|jpe?g)$/);
  return m ? (m[1] === "jpeg" ? "jpg" : m[1]) : null;
}
function fromEmail(v: unknown): string {
  const s = String(v || "");
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}
function b64(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768) as unknown as number[]);
  return btoa(s);
}

// Claude reads the receipt — image block for photos, document block for PDFs.
async function extract(bytes: Uint8Array, ext: string) {
  const out: { vendor: string | null; date: string | null; amount: number | null; card_last4: string | null } =
    { vendor: null, date: null, amount: null, card_last4: null };
  if (!ANTHROPIC || bytes.length > 20_000_000) return out;
  const data = b64(bytes);
  const block = ext === "pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg", data } };
  const payload = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: 'You extract fields from a purchase receipt (photo or PDF). Reply with ONLY a JSON object, no prose: ' +
      '{"vendor": string|null, "date": "YYYY-MM-DD"|null, "amount": number|null, "card_last4": string|null}. ' +
      'vendor = the merchant name as printed, short. date = the transaction date. ' +
      'amount = the final grand total actually charged, after tax and tip. ' +
      'card_last4 = the LAST FOUR DIGITS of the card used exactly as printed (Apple Pay device numbers count — ' +
      "give what is printed). Null if paid cash or no card shown. Use null for anything you cannot read confidently. Never guess.",
    messages: [{ role: "user", content: [block, { type: "text", text: "Extract the fields from this receipt." }] }],
  };
  let d: any = null;
  for (const model of ["claude-haiku-4-5-20251001", "claude-sonnet-5"]) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, model }),
        signal: AbortSignal.timeout(60_000),
      });
      d = await r.json().catch(() => null);
      if (r.ok) break;
      d = null;
    } catch (_) { d = null; }
  }
  if (!d) return out;
  const text = ((d.content || []) as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text").map((c) => c.text || "").join(" ");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return out;
  try {
    const p = JSON.parse(m[0]);
    if (typeof p.vendor === "string" && p.vendor.trim()) out.vendor = p.vendor.trim().slice(0, 120);
    if (typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && +p.date.slice(0, 4) >= 2000 && +p.date.slice(0, 4) <= 2100) out.date = p.date;
    const a = Number(p.amount);
    if (Number.isFinite(a) && a > 0 && a < 1_000_000) out.amount = Math.round(a * 100) / 100;
    const c4 = String(p.card_last4 ?? "").replace(/\D/g, "");
    if (c4.length === 4) out.card_last4 = c4;
  } catch (_) { /* unreadable — nulls */ }
  return out;
}

// The allowlisted cards + class map, from qbo (server-to-server, NOTIFY_SECRET).
async function payAccounts() {
  try {
    const r = await fetch(SB_URL + "/functions/v1/qbo?action=pay_accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE, apikey: SERVICE },
      body: JSON.stringify({ action: "pay_accounts", secret: NOTIFY }),
      signal: AbortSignal.timeout(30_000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(d.accounts)) return null;
    return d as { accounts: Array<{ id: string; name: string; type: string | null }>;
      applepay: Record<string, string>; cls: Record<string, string>;
      classes: Array<{ id: string; name: string }> };
  } catch (_) { return null; }
}
function matchCard(pa: NonNullable<Awaited<ReturnType<typeof payAccounts>>>, last4: string | null) {
  if (!last4) return null;
  const hits = pa.accounts.filter((a) =>
    pa.applepay[a.id] === last4 || (String(a.name || "").match(/\d{4}/g) || []).indexOf(last4) > -1);
  return hits.length === 1 ? hits[0] : null;   // only a UNIQUE match is a match
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  if (!SECRET || url.searchParams.get("s") !== SECRET) return json({ error: "forbidden" }, 403);
  if (req.method !== "POST") return json({ error: "bad_method" }, 405);
  const body = await req.json().catch(() => ({})) as Record<string, any>;
  if (String(body.type || "") !== "email.received") return json({ ok: true, ignored: body.type || null });

  const data = (body.data || {}) as Record<string, any>;
  const emailId = String(data.email_id || data.id || "");
  const sender = fromEmail(data.from);
  const subject = String(data.subject || "").trim().slice(0, 300);
  const atts = (Array.isArray(data.attachments) ? data.attachments : []) as Att[];
  if (!emailId) return json({ error: "bad_request", detail: "no email_id" }, 400);

  // who forwarded it — personal email on the profile is the SMS/email identity
  let who: { auth_uid: string | null; name: string | null } = { auth_uid: null, name: null };
  if (sender) {
    const { data: prof } = await admin.from("staff_profiles")
      .select("staff_id, personal_email, staff:staff_id (auth_uid, display_name, active)")
      .ilike("personal_email", sender).limit(1).maybeSingle();
    const st = (prof as any)?.staff;
    if (st && st.active) who = { auth_uid: st.auth_uid || null, name: st.display_name || null };
  }

  const pa = await payAccounts();
  const now = new Date();
  const ym = now.getFullYear() + "/" + String(now.getMonth() + 1).padStart(2, "0");
  const filed: string[] = [], skipped: string[] = [];

  for (const att of atts.slice(0, 10)) {
    const ext = extOf(att);
    const attId = String(att.id || att.filename || "");
    if (!ext || !attId) { skipped.push((att.filename || "?") + " (not a receipt file)"); continue; }
    const ref = `email:${emailId}:${attId}`;
    const { data: dup } = await admin.from("expense_receipts").select("id").eq("source_ref", ref).maybeSingle();
    if (dup) { skipped.push(attId + " (already filed)"); continue; }

    // attachment bytes: inline (Zapier/test) or the Resend attachments API
    let bytes: Uint8Array | null = null;
    if (att.content_b64) {
      try { bytes = Uint8Array.from(atob(att.content_b64), (c) => c.charCodeAt(0)); } catch (_) { bytes = null; }
    } else if (RESEND && att.id) {
      try {
        const ar = await fetch(`https://api.resend.com/emails/receiving/${emailId}/attachments/${att.id}`, {
          headers: { Authorization: "Bearer " + RESEND }, signal: AbortSignal.timeout(30_000),
        });
        const ad = await ar.json().catch(() => ({}));
        const dl = ad?.download_url || ad?.data?.download_url;
        if (ar.ok && dl) {
          const fr = await fetch(dl, { signal: AbortSignal.timeout(60_000) });
          if (fr.ok) bytes = new Uint8Array(await fr.arrayBuffer());
        }
      } catch (_) { bytes = null; }
    }
    if (!bytes || bytes.length < 100) { skipped.push(attId + " (no content)"); continue; }
    if (bytes.length > 20_000_000) { skipped.push(attId + " (too large)"); continue; }

    const read = await extract(bytes, ext);
    const card = pa ? matchCard(pa, read.card_last4) : null;
    const clsId = card && pa ? (pa.cls[card.id] ? String(pa.cls[card.id]) : null) : null;
    const cls = clsId && pa ? (pa.classes.find((c) => String(c.id) === clsId) || null) : null;

    const path = `email/${ym}/${crypto.randomUUID()}.${ext}`;
    const up = await admin.storage.from("receipts").upload(path, bytes, {
      contentType: ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg",
    });
    if (up.error) { skipped.push(attId + " (upload failed: " + up.error.message + ")"); continue; }

    const ins = await admin.from("expense_receipts").insert({
      txn_date: read.date || now.toISOString().slice(0, 10),
      amount: read.amount ?? 0,
      vendor: read.vendor,
      memo: subject || "Emailed receipt",
      payment_account_id: card ? card.id : null,
      payment_account_name: card ? card.name : null,
      payment_account_type: card ? card.type : null,
      class_id: cls ? cls.id : null,
      class_name: cls ? cls.name : null,
      receipt_path: path,
      status: "review",
      source: "email",
      source_ref: ref,
      created_by: who.name || sender || "email",
      submitted_by: who.auth_uid,
    }).select("id").single();
    if (ins.error) {
      // unique source_ref = a concurrent retry won the race — that is success
      if (/source_ref/i.test(ins.error.message)) { skipped.push(attId + " (already filed)"); continue; }
      await admin.storage.from("receipts").remove([path]).then(() => {}, () => {});
      skipped.push(attId + " (insert failed: " + ins.error.message + ")");
      continue;
    }
    filed.push(ins.data.id);
  }
  return json({ ok: true, filed: filed.length, ids: filed, skipped });
});
