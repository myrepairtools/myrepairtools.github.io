// intake — public new-hire intake proxy (token = the credential, same pattern
// as contracts/interviews). The browser NEVER touches staff_intake directly:
// candidates GET their invite + POST their submission here with the token;
// managers create invites / promote via their JWT (admin role checked).
//
// Candidate stage (v3): a link created WITH an offer letter opens as a
// candidate flow — sign the offer (or decline), sign the Employee Handbook
// acknowledgment (rendered live from the KB's Employee Handbook category),
// THEN the new-hire form. Signatures follow the contracts pattern (png
// data-url + typed name + ip/ua). Milestones fire a 'hiring' alert to the
// manager who created the link. Links created without an offer_body keep the
// original form-only behavior.
//
// Offer PDF (v4): the offer letter travels as a PDF, generated server-side
// with pdf-lib (lazy-imported so the hot token actions stay fast).
//   offer_pdf  (manager JWT) — preview PDF from a raw body, pre-create
//   send_offer (manager JWT) — email the PDF as an attachment to the
//     candidate (Gmail SMTP, reply-to from app_settings 'hiring.reply_to'),
//     signing link in the email body; stamps offer_sent_at/_via
//   signed_pdf (token) — the SIGNED record: offer + embedded signature block,
//     plus an Employee Handbook acknowledgment page when that's signed too.
//     Token-auth so both the candidate (done card) and managers (review
//     modal reads the token via RLS) can download it.
// Deploy with verify_jwt:false.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") || "";
const GMAIL_USER = Deno.env.get("GMAIL_USER") || "";
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const NOTIFY_FROM = Deno.env.get("NOTIFY_FROM") || "onboarding@resend.dev";
const SITE = "https://myrepairtools.github.io";
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function manager(req: Request) {
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return null;
  const { data } = await admin.auth.getUser(auth);
  if (!data?.user) return null;
  const { data: s } = await admin.from("staff").select("id, display_name, role").eq("auth_uid", data.user.id).eq("active", true).maybeSingle();
  return s && ["owner", "admin", "manager"].includes(s.role) ? s : null;
}
const PUBLIC_FIELDS = "token, status, invited_name, invited_store, position, start_hint, " +
  "offer_body, offer_signed_at, offer_signed_name, offer_declined_at, " +
  "handbook_signed_at, handbook_signed_name, " +
  "legal_first, legal_middle, legal_last, preferred_name, dob, phone, personal_email, " +
  "address, emergency, emergency2, shirt_size, availability, i9_docs, submitted_at";

// Signature validation — same bounds as the contracts function.
function badSig(sig: string): boolean {
  return !sig.startsWith("data:image/png;base64,") || sig.length < 1000 || sig.length > 400000;
}
function sigMeta(req: Request) {
  return {
    ip: (req.headers.get("x-forwarded-for") || "").split(",")[0].trim(),
    ua: (req.headers.get("user-agent") || "").slice(0, 300),
    at: new Date().toISOString(),
  };
}

// Best-effort 'hiring' alert to the manager who created the link — a
// notification problem must never break the candidate's flow.
async function alertMgr(staffId: unknown, title: string, body: string) {
  const id = Number(staffId);
  if (!id || !NOTIFY_SECRET) return;
  try {
    await fetch(SB_URL + "/functions/v1/alerts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "send", secret: NOTIFY_SECRET, kind: "hiring",
        title, body, link: "onboarding-dashboard.html", staff_ids: [id],
      }),
    });
  } catch { /* best-effort */ }
}

// The Employee Handbook, rendered live from the KB so candidates always sign
// the current wording. Read with the service role but filtered to published,
// employee-visible articles only.
async function handbookArticles() {
  const { data: cat } = await admin.from("kb_categories").select("id").ilike("name", "%handbook%").maybeSingle();
  if (!cat) return [];
  const { data } = await admin.from("kb_articles")
    .select("slug, title, body, sort_order")
    .eq("category_id", cat.id).eq("status", "published").eq("min_role", "employee")
    .order("sort_order").order("id");
  return (data || []).map((a) => ({ slug: a.slug, title: a.title, body: a.body }));
}

function candName(it: Record<string, unknown>): string {
  return String(it.offer_signed_name || it.invited_name ||
    [it.legal_first, it.legal_last].filter(Boolean).join(" ") || "Candidate");
}

/* ---------- offer letter PDF (pdf-lib, lazy-imported) ---------- */
function b64FromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function bytesFromDataUrl(dataUrl: string): Uint8Array | null {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}
// WinAnsi can't hold every char a manager might paste — normalize the fancy
// ones and drop the rest so pdf-lib never throws mid-generation.
function latin1ish(s: string): string {
  return String(s || "")
    .replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')
    .replace(/–/g, "-").replace(/…/g, "...").replace(/ /g, " ")
    .replace(/[^\x0A\x20-\x7E\xA0-\xFF—•]/g, "");
}
type SigBlock = { png: string; name: string; at: string };
async function buildOfferPdf(opts: {
  body: string; link?: string; storeLine?: string;
  offerSig?: SigBlock | null;
  handbookSig?: SigBlock | null;
}): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("https://esm.sh/pdf-lib@1.17.1");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 72, CW = W - M * 2;
  const red = rgb(0.863, 0.157, 0.18), grey = rgb(0.45, 0.45, 0.52),
    dark = rgb(0.176, 0.176, 0.231), blue = rgb(0.118, 0.478, 0.655),
    rule = rgb(0.878, 0.886, 0.918);
  let page = doc.addPage([W, H]);
  let y = H - M;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const ensure = (need: number) => { if (y - need < M) newPage(); };
  const wrapW = (text: string, f: typeof font, size: number, maxw: number): string[] => {
    const out: string[] = [];
    const words = text.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      const t = line ? line + " " + w : w;
      if (f.widthOfTextAtSize(t, size) <= maxw) line = t;
      else { if (line) out.push(line); line = w; }
    }
    if (line) out.push(line);
    return out.length ? out : [""];
  };
  const para = (text: string, f = font, size = 10.5, color = dark, lh = 16) => {
    for (const raw of latin1ish(text).split("\n")) {
      if (!raw.trim()) { y -= 8; continue; }
      // light heading markup, same family as the KB: '# ' title, '## ' section
      let lf = f, ls = size, indent = 0, gapAbove = 0, line = raw;
      if (raw.startsWith("## ")) { lf = bold; ls = 11.5; gapAbove = 6; line = raw.slice(3); }
      else if (raw.startsWith("# ")) { lf = bold; ls = 13.5; gapAbove = 2; line = raw.slice(2); }
      else if (raw.startsWith("• ")) { indent = 14; line = raw.slice(2); }
      y -= gapAbove;
      let first = true;
      for (const ln of wrapW(line, lf, ls, CW - indent)) {
        ensure(lh);
        if (indent && first) page.drawText("•", { x: M, y: y - ls, size: ls, font: f, color });
        page.drawText(ln, { x: M + indent, y: y - ls, size: ls, font: lf, color });
        y -= Math.max(lh, ls + 5);
        first = false;
      }
    }
  };
  const drawSig = async (title: string, sig: SigBlock, ackText?: string) => {
    ensure(150);
    y -= 14;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: rule });
    y -= 22;
    page.drawText(latin1ish(title), { x: M, y: y - 11, size: 11, font: bold, color: dark });
    y -= 20;
    if (ackText) para(ackText, font, 9.5, grey, 14);
    const bytes = bytesFromDataUrl(sig.png);
    if (bytes) {
      try {
        const img = await doc.embedPng(bytes);
        const sw = Math.min(200, img.width), sh = sw * (img.height / img.width);
        const dh = Math.min(sh, 70), dw = dh * (img.width / img.height);
        ensure(dh + 34);
        page.drawImage(img, { x: M, y: y - dh, width: dw, height: dh });
        y -= dh + 6;
      } catch { /* a bad png just leaves the typed name as the record */ }
    }
    ensure(30);
    page.drawLine({ start: { x: M, y }, end: { x: M + 220, y }, thickness: 0.8, color: grey });
    y -= 13;
    const when = new Date(sig.at || Date.now()).toLocaleDateString("en-US",
      { timeZone: "America/Los_Angeles", year: "numeric", month: "long", day: "numeric" });
    page.drawText(latin1ish(sig.name) + "  ·  " + when, { x: M, y, size: 9.5, font, color: grey });
    y -= 8;
  };
  // letterhead
  page.drawText("CPR Cell Phone Repair", { x: M, y: y - 16, size: 16, font: bold, color: red });
  const dt = new Date().toLocaleDateString("en-US",
    { timeZone: "America/Los_Angeles", year: "numeric", month: "long", day: "numeric" });
  page.drawText(dt, { x: W - M - font.widthOfTextAtSize(dt, 9), y: y - 14, size: 9, font, color: grey });
  if (opts.storeLine) {
    page.drawText(latin1ish(opts.storeLine), { x: M, y: y - 29, size: 8.5, font, color: grey });
    y -= 13;
  }
  y -= 30;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: rule });
  y -= 26;
  para(opts.body);
  if (opts.offerSig) {
    await drawSig("Accepted and agreed", opts.offerSig);
  } else if (opts.link) {
    ensure(60);
    y -= 14;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: rule });
    y -= 22;
    page.drawText("To accept, review and sign online:", { x: M, y: y - 10, size: 10, font: bold, color: dark });
    y -= 18;
    page.drawText(latin1ish(opts.link), { x: M, y: y - 10, size: 10, font, color: blue });
    y -= 18;
  }
  if (opts.handbookSig) {
    newPage();
    page.drawText("Employee Handbook Acknowledgment", { x: M, y: y - 14, size: 14, font: bold, color: dark });
    y -= 34;
    await drawSig("Acknowledged and agreed", opts.handbookSig,
      "I acknowledge that I have received, read, and understand the CPR Employee Handbook, and I agree to follow its policies. The handbook was presented in full, section by section, immediately before this signature was captured.");
  }
  return await doc.save();
}

/* ---------- email with PDF attachment (Resend first, Gmail fallback) ---------- */
function emailHtml(text: string): string {
  return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#2D2D3B;line-height:1.55;white-space:pre-line">' +
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/(https:\/\/[^\s]+)/g, '<a href="$1">$1</a>') + "</div>";
}
async function sendOfferEmail(to: string, subject: string, text: string,
  pdf: Uint8Array, filename: string, replyTo?: string): Promise<{ ok: boolean; error?: string }> {
  const b64 = b64FromBytes(pdf);
  if (RESEND_API_KEY) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: NOTIFY_FROM, to: [to], subject, text, html: emailHtml(text),
        ...(replyTo ? { reply_to: replyTo } : {}),
        attachments: [{ filename, content: b64 }],
      }),
    });
    if (r.ok) return { ok: true };
    const d = await r.json().catch(() => ({}));
    if (!GMAIL_USER) return { ok: false, error: (d && (d.message || d.name)) || `resend_${r.status}` };
  }
  if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    try {
      const { SMTPClient } = await import("https://deno.land/x/denomailer@1.6.0/mod.ts");
      const client = new SMTPClient({
        connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD } },
      });
      await client.send({
        from: `CPR Cell Phone Repair <${GMAIL_USER}>`, to, subject,
        content: text, html: emailHtml(text),
        ...(replyTo ? { replyTo } : {}),
        attachments: [{ filename, content: b64, encoding: "base64", contentType: "application/pdf" }],
      });
      await client.close();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: "gmail_" + String((e as Error)?.message || e).slice(0, 200) };
    }
  }
  return { ok: false, error: "no_email_transport" };
}
// Letterhead sub-line from the stores table (Settings -> Locations is the
// runtime authority for store contact info).
async function storeLetterhead(store: unknown): Promise<string | undefined> {
  if (!store) return undefined;
  const s = String(store);
  const { data } = await admin.from("stores").select("store, rq_name, address, phone");
  const row = (data || []).find((r) => r.store === s || r.rq_name === s);
  if (!row) return undefined;
  return [row.address, row.phone].filter(Boolean).join("  \u2022  ") || undefined;
}
async function hiringReplyTo(): Promise<string | undefined> {
  const { data } = await admin.from("app_settings").select("value").eq("key", "hiring.reply_to").maybeSingle();
  const v = data?.value?.email;
  return v && /@/.test(String(v)) ? String(v) : undefined;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = String(body.action || "");

  // ---- candidate side (token auth) ----
  if (action === "get") {
    const token = String(body.token || "");
    if (!token) return json({ error: "token required" }, 400);
    const { data } = await admin.from("staff_intake").select(PUBLIC_FIELDS).eq("token", token).maybeSingle();
    if (!data) return json({ error: "not_found" }, 404);
    // Hand the handbook over only when it's the next thing to sign.
    let handbook: unknown[] | undefined;
    if (data.offer_body && data.offer_signed_at && !data.offer_declined_at && !data.handbook_signed_at) {
      handbook = await handbookArticles();
    }
    return json({ ok: true, intake: data, ...(handbook ? { handbook } : {}) });
  }

  if (action === "sign_offer" || action === "decline_offer" || action === "sign_handbook") {
    const token = String(body.token || "");
    if (!token) return json({ error: "token required" }, 400);
    const { data: it } = await admin.from("staff_intake").select("*").eq("token", token).maybeSingle();
    if (!it) return json({ error: "not_found" }, 404);
    if (it.status === "promoted") return json({ error: "already_promoted" }, 409);
    if (!it.offer_body) return json({ error: "no_offer" }, 409);
    if (it.offer_declined_at) return json({ error: "declined" }, 409);
    const now = new Date().toISOString();
    const meta = (it.signed_meta && typeof it.signed_meta === "object") ? it.signed_meta : {};

    if (action === "sign_offer") {
      if (it.offer_signed_at) return json({ error: "already_signed" }, 409);
      const name = String(body.signed_name || "").trim();
      const sig = String(body.signature || "");
      if (name.length < 2) return json({ error: "name_required" }, 400);
      if (badSig(sig)) return json({ error: "signature_required" }, 400);
      const { error } = await admin.from("staff_intake").update({
        offer_signature: sig, offer_signed_name: name.slice(0, 120), offer_signed_at: now,
        signed_meta: { ...meta, offer: sigMeta(req) }, updated_at: now,
      }).eq("id", it.id).is("offer_signed_at", null);
      if (error) return json({ error: error.message }, 500);
      await alertMgr(it.invited_by, "Offer signed — " + name,
        name + " accepted and signed their offer" + (it.position ? " (" + it.position + ")" : "") + ". Handbook + new-hire form are next.");
      return json({ ok: true });
    }

    if (action === "decline_offer") {
      if (it.offer_signed_at) return json({ error: "already_signed" }, 409);
      const note = body.note == null ? null : String(body.note).slice(0, 500) || null;
      const { error } = await admin.from("staff_intake").update({
        status: "declined", offer_declined_at: now, decline_note: note, updated_at: now,
      }).eq("id", it.id).is("offer_declined_at", null);
      if (error) return json({ error: error.message }, 500);
      await alertMgr(it.invited_by, "Offer declined — " + candName(it),
        candName(it) + " declined the offer" + (it.position ? " (" + it.position + ")" : "") + (note ? '. "' + note + '"' : "."));
      return json({ ok: true });
    }

    // sign_handbook
    if (!it.offer_signed_at) return json({ error: "offer_first" }, 409);
    if (it.handbook_signed_at) return json({ error: "already_signed" }, 409);
    const name = String(body.signed_name || "").trim();
    const sig = String(body.signature || "");
    if (name.length < 2) return json({ error: "name_required" }, 400);
    if (badSig(sig)) return json({ error: "signature_required" }, 400);
    const { error } = await admin.from("staff_intake").update({
      handbook_signature: sig, handbook_signed_name: name.slice(0, 120), handbook_signed_at: now,
      signed_meta: { ...meta, handbook: sigMeta(req) }, updated_at: now,
    }).eq("id", it.id).is("handbook_signed_at", null);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "signed_pdf") {
    // The signed record: offer + embedded signature (+ handbook ack page).
    // Token-auth — the candidate downloads their copy, and managers (who can
    // read the token under is_admin RLS) pull the same document.
    const token = String(body.token || "");
    if (!token) return json({ error: "token required" }, 400);
    const { data: it } = await admin.from("staff_intake").select("*").eq("token", token).maybeSingle();
    if (!it) return json({ error: "not_found" }, 404);
    if (!it.offer_body || !it.offer_signed_at) return json({ error: "not_signed" }, 409);
    const pdf = await buildOfferPdf({
      body: it.offer_body,
      storeLine: await storeLetterhead(it.invited_store),
      offerSig: { png: it.offer_signature, name: it.offer_signed_name || "", at: it.offer_signed_at },
      handbookSig: it.handbook_signed_at
        ? { png: it.handbook_signature, name: it.handbook_signed_name || "", at: it.handbook_signed_at }
        : null,
    });
    return json({ ok: true, pdf: b64FromBytes(pdf), filename: "CPR Offer — " + (it.offer_signed_name || "signed") + ".pdf" });
  }

  if (action === "submit") {
    const token = String(body.token || "");
    if (!token) return json({ error: "token required" }, 400);
    const { data: row } = await admin.from("staff_intake")
      .select("id, status, invited_by, position, offer_body, offer_signed_at, offer_declined_at, handbook_signed_at")
      .eq("token", token).maybeSingle();
    if (!row) return json({ error: "not_found" }, 404);
    if (row.status === "promoted") return json({ error: "already_promoted" }, 409);
    if (row.offer_declined_at) return json({ error: "declined" }, 409);
    // Docs flow: the form only opens after both signatures.
    if (row.offer_body && (!row.offer_signed_at || !row.handbook_signed_at)) return json({ error: "docs_first" }, 409);
    const f = (k: string, max = 200) => body[k] == null ? null : String(body[k]).slice(0, max) || null;
    const patch: Record<string, unknown> = {
      legal_first: f("legal_first"), legal_middle: f("legal_middle"), legal_last: f("legal_last"),
      preferred_name: f("preferred_name"), dob: f("dob", 10), phone: f("phone", 30),
      personal_email: f("personal_email"),
      address: body.address && typeof body.address === "object" ? body.address : null,
      emergency: body.emergency && typeof body.emergency === "object" ? body.emergency : null,
      emergency2: body.emergency2 && typeof body.emergency2 === "object" ? body.emergency2 : null,
      shirt_size: f("shirt_size", 10), i9_docs: f("i9_docs"),
      availability: Array.isArray(body.availability) ? (body.availability as unknown[]).slice(0, 7) : null,
      status: "submitted", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const { error } = await admin.from("staff_intake").update(patch).eq("id", row.id);
    if (error) return json({ error: error.message }, 500);
    const nm = [patch.legal_first, patch.legal_last].filter(Boolean).join(" ") || "A candidate";
    await alertMgr(row.invited_by, "New-hire form in — " + nm,
      nm + " finished their paperwork" + (row.offer_body ? " (offer + handbook signed)" : "") + " — ready to convert to a New Employee.");
    return json({ ok: true });
  }

  // ---- manager side (JWT auth) ----
  const mgr = await manager(req);
  if (!mgr) return json({ error: "forbidden" }, 403);
  if (action === "offer_pdf") {
    // Preview: build the PDF from a raw (possibly not-yet-saved) body. No
    // signing link yet — the wizard hasn't created the row.
    const offerBody = String(body.offer_body || "").slice(0, 8000);
    if (!offerBody.trim()) return json({ error: "offer_body required" }, 400);
    const pdf = await buildOfferPdf({ body: offerBody, storeLine: await storeLetterhead(body.store) });
    return json({ ok: true, pdf: b64FromBytes(pdf) });
  }
  if (action === "send_offer") {
    const intakeId = Number(body.intake_id);
    if (!intakeId) return json({ error: "intake_id required" }, 400);
    const { data: it } = await admin.from("staff_intake").select("*").eq("id", intakeId).maybeSingle();
    if (!it) return json({ error: "not_found" }, 404);
    if (!it.offer_body) return json({ error: "no_offer" }, 409);
    if (it.offer_declined_at) return json({ error: "declined" }, 409);
    if (!it.personal_email || !/@/.test(it.personal_email)) return json({ error: "no_email" }, 400);
    const link = SITE + "/intake.html?t=" + it.token;
    const pdf = await buildOfferPdf({ body: it.offer_body, link, storeLine: await storeLetterhead(it.invited_store) });
    const first = String(it.invited_name || "").trim().split(/\s+/)[0] || "there";
    const text = "Hi " + first + ",\n\n"
      + "Your offer letter from CPR Cell Phone Repair is attached as a PDF.\n\n"
      + "When you're ready, review and sign it online — the same link walks you through the Employee Handbook and your new-hire form (about 10 minutes total):\n"
      + link + "\n\n"
      + "Questions? Just reply to this email.\n\n— CPR Cell Phone Repair, Oregon";
    const r = await sendOfferEmail(String(it.personal_email), "Your offer from CPR Cell Phone Repair", text,
      pdf, "CPR Offer Letter.pdf", await hiringReplyTo());
    if (r.ok) {
      await admin.from("staff_intake").update({
        offer_sent_at: new Date().toISOString(), offer_sent_via: "email", updated_at: new Date().toISOString(),
      }).eq("id", intakeId);
    }
    return json(r.ok ? { ok: true } : { error: r.error || "send_failed" }, r.ok ? 200 : 500);
  }
  if (action === "create") {
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const s = (k: string, max = 200) => String(body[k] || "").slice(0, max) || null;
    const { data, error } = await admin.from("staff_intake").insert({
      token, status: "sent",
      invited_name: s("invited_name", 120),
      invited_store: s("invited_store", 60),
      invited_by: mgr.id,
      position: s("position", 80), pay: s("pay", 120), start_hint: s("start_hint", 60),
      offer_body: body.offer_body == null ? null : String(body.offer_body).slice(0, 8000) || null,
      phone: s("phone", 30), personal_email: s("personal_email"),
    }).select("id, token").single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, id: data.id, token: data.token });
  }
  if (action === "cancel") {
    // delete an un-promoted intake (test rows, rescinded offers, declines).
    // Promoted intakes are history — they can't be removed from here.
    const intakeId = Number(body.intake_id);
    if (!intakeId) return json({ error: "intake_id required" }, 400);
    const { data: it } = await admin.from("staff_intake").select("id, status").eq("id", intakeId).maybeSingle();
    if (!it) return json({ error: "not_found" }, 404);
    if (it.status === "promoted") return json({ error: "already_promoted" }, 409);
    const { error } = await admin.from("staff_intake").delete().eq("id", intakeId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (action === "promote") {
    // copy the intake onto an existing staff row + staff_profiles, stamp the
    // link, and fire module auto-assign for the hire. staff_id required (the
    // staff row is created by the QB Time sync or Team Members first).
    // Doc gating lives in the UI (a paper-signed candidate can still be
    // converted) — but a declined offer is a hard no.
    const intakeId = Number(body.intake_id), staffId = Number(body.staff_id);
    if (!intakeId || !staffId) return json({ error: "intake_id and staff_id required" }, 400);
    const { data: it } = await admin.from("staff_intake").select("*").eq("id", intakeId).maybeSingle();
    if (!it) return json({ error: "not_found" }, 404);
    if (it.offer_declined_at) return json({ error: "declined" }, 409);
    const { data: st } = await admin.from("staff").select("id, role, start_date, birthday, first_name, last_name, preferred_name").eq("id", staffId).maybeSingle();
    if (!st) return json({ error: "staff_not_found" }, 404);
    const patch: Record<string, unknown> = {};
    if (it.legal_first && !st.first_name) patch.first_name = it.legal_first;
    if (it.legal_last && !st.last_name) patch.last_name = it.legal_last;
    if (it.preferred_name && !st.preferred_name) patch.preferred_name = it.preferred_name;
    if (it.dob && !st.birthday) patch.birthday = it.dob;
    if (Object.keys(patch).length) await admin.from("staff").update(patch).eq("id", staffId);
    // contact + emergency onto staff_profiles (never overwrite non-empty)
    const { data: prof } = await admin.from("staff_profiles").select("staff_id, phone, personal_email, emergency").eq("staff_id", staffId).maybeSingle();
    await admin.from("staff_profiles").upsert({
      staff_id: staffId,
      phone: prof?.phone || it.phone || null,
      personal_email: prof?.personal_email || it.personal_email || null,
      emergency: prof?.emergency || it.emergency || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "staff_id" });
    await admin.from("staff_intake").update({
      status: "promoted", promoted_staff_id: staffId, promoted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", intakeId);
    // fire auto-assign: modules whose rule matches this hire
    const { data: mods } = await admin.from("onboarding_modules").select("id, auto_assign_role, auto_assign_from").eq("active", true);
    const hired = String(st.start_date || new Date().toISOString().slice(0, 10));
    let assigned = 0;
    for (const m of (mods || [])) {
      if (!m.auto_assign_role) continue;
      const roleOk = m.auto_assign_role === "any" || m.auto_assign_role === st.role
        || (m.auto_assign_role === "team_member" && ["employee", "team_member"].includes(st.role));
      const dateOk = !m.auto_assign_from || hired >= String(m.auto_assign_from);
      if (!roleOk || !dateOk) continue;
      const { error } = await admin.from("onboarding_assignments")
        .upsert({ staff_id: staffId, module_id: m.id, assigned_by: mgr.id }, { onConflict: "staff_id,module_id", ignoreDuplicates: true });
      if (!error) assigned++;
    }
    return json({ ok: true, assigned });
  }
  return json({ error: "unknown action" }, 400);
});
