// kb-sign — signatures on knowledge-base articles.
//
// require_ack is a click. Some documents need a real signature: a policy the
// employee signs, frozen to a PDF, and filed against their person in the same
// HR record that already holds their offer letter and handbook acknowledgment.
//
// This function is the only thing that may write a signature, because a
// signature record without the document behind it is worthless. It:
//   1. verifies the caller's own Supabase JWT -> staff row
//   2. renders the article body AS IT READS RIGHT NOW into a PDF
//   3. files that PDF in the private hr-private bucket + staff_documents
//   4. records kb_signatures and stamps kb_reads.acknowledged_at so every
//      existing compliance surface sees it
//
// FROZEN, never regenerated — same rule as the handbook acknowledgment. These
// articles get edited; what someone signed must not change underneath them.
//
// TWO version numbers, deliberately: kb_articles.version bumps on every save
// and is the audit record of the exact wording signed (it prints on the PDF),
// while signature_version is the EPOCH — the obligation. Only a manager
// declaring a revision material advances the epoch, so fixing a typo never
// makes the whole team re-sign. Re-signing a new epoch files a second document
// and keeps the first.
//
// Actions:
//   sign      {article_id, signature, name}  -> staff JWT, idempotent per epoch
//   my_doc    {signature_id}                 -> 120s signed URL to your own PDF
//   ping                                     -> warm boot
//
// The PDF builder here is deliberately its own (leaner) thing rather than a
// copy of intake's buildOfferPdf: that one is letter-shaped (offer body,
// "Accepted and agreed", handbook ack page). Edge functions deploy one file
// each, so there is no shared module to import; the letterhead PNG lives in
// hr-private instead of being duplicated as a base64 constant.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

/* ---------- KB light markup -> the PDF builder's plain markup ----------
   Mirrors intake's kbToPdfMarkup: bullets normalize, tables degrade to
   "cell — cell" rows (the PDF has no table engine), inline marks strip,
   images drop. Keep the two in sync when the markup grows. */
function kbToPdfMarkup(body: string): string {
  return String(body || "").split("\n").map((ln) => {
    let l = ln;
    if (/^\s*!\[/.test(l)) return "";
    if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && /-/.test(l) && /\|/.test(l)) return "";
    if (/^\s*\|.*\|\s*$/.test(l)) {
      return "• " + l.replace(/^\s*\|/, "").replace(/\|\s*$/, "")
        .split("|").map((c) => c.trim()).filter(Boolean).join("  —  ");
    }
    if (/^####\s+/.test(l)) l = "## " + l.replace(/^####\s+/, "");
    else if (/^###\s+/.test(l)) l = "## " + l.replace(/^###\s+/, "");
    else if (/^##\s+/.test(l)) l = "## " + l.replace(/^##\s+/, "");
    else if (/^#\s+/.test(l)) l = "# " + l.replace(/^#\s+/, "");
    l = l.replace(/^(\s*)[-*]\s+/, "$1• ");
    l = l.replace(/^!(#[0-9a-fA-F]{6}\|#[0-9a-fA-F]{6}\|#[0-9a-fA-F]{6}|[rgbnd])?>\s+/, "Note: ");
    l = l.replace(/^\s*---\s*$/, "");
    l = l.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1");
    l = l.replace(/(^|[\s(>])\*([^*\n]+)\*/g, "$1$2");
    l = l.replace(/!\[[^\]]*\]\([^)]+\)/g, "");
    l = l.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
    l = l.replace(/`([^`]+)`/g, "$1");
    return l;
  }).join("\n");
}

// WinAnsi can't hold every character an author might paste — normalize the
// common ones and drop the rest so pdf-lib never throws mid-generation.
function latin1ish(s: string): string {
  return String(s || "")
    .replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')
    .replace(/–/g, "-").replace(/…/g, "...").replace(/ /g, " ")
    .replace(/[^\x0A\x20-\x7E\xA0-\xFF—•]/g, "");
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
// A signature has to actually be a drawing. An empty canvas still produces a
// valid PNG, so length is the cheap proxy for "they drew something".
function badSig(sig: string): boolean {
  return !/^data:image\/png;base64,/.test(sig) || sig.length < 800 || sig.length > 400_000;
}

// Letterhead logo — lives in hr-private (uploaded once from
// assets/images/cpr-logo-letterhead.png) rather than as a base64 constant in
// two functions. Cached per warm boot; a miss just falls back to text.
let _logo: Uint8Array | null | undefined;
async function logoBytes(): Promise<Uint8Array | null> {
  if (_logo !== undefined) return _logo;
  try {
    const { data } = await admin.storage.from("hr-private").download("letterhead-logo.png");
    _logo = data ? new Uint8Array(await data.arrayBuffer()) : null;
  } catch { _logo = null; }
  return _logo;
}

const ACK_DEFAULT =
  "I have read and understand this document, and I agree to follow it. " +
  "I understand it is part of the policies and procedures of my employment.";

async function buildPolicyPdf(opts: {
  title: string; body: string; version: number;
  sig: { png: string; name: string; at: string };
  ackText?: string;
}): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("https://esm.sh/pdf-lib@1.17.1");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 72, CW = W - M * 2;
  const red = rgb(0.863, 0.157, 0.18), grey = rgb(0.45, 0.45, 0.52),
    dark = rgb(0.176, 0.176, 0.231), rule = rgb(0.878, 0.886, 0.918);
  let page = doc.addPage([W, H]);
  let y = H - M;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const ensure = (need: number) => { if (y - need < M) newPage(); };
  const wrapW = (text: string, f: typeof font, size: number, maxw: number): string[] => {
    const out: string[] = [];
    let line = "";
    for (const w of text.split(/\s+/).filter(Boolean)) {
      const t = line ? line + " " + w : w;
      if (f.widthOfTextAtSize(t, size) <= maxw) line = t;
      else { if (line) out.push(line); line = w; }
    }
    if (line) out.push(line);
    return out.length ? out : [""];
  };
  const para = (text: string, f = font, size = 10.5, color = dark, lh = 15.5) => {
    for (const raw of latin1ish(text).split("\n")) {
      if (!raw.trim()) { y -= 7; continue; }
      let lf = f, ls = size, indent = 0, gapAbove = 0, line = raw;
      if (raw.startsWith("## ")) { lf = bold; ls = 11.5; gapAbove = 6; line = raw.slice(3); }
      else if (raw.startsWith("# ")) { lf = bold; ls = 13; gapAbove = 10; line = raw.slice(2); }
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

  // letterhead
  let logoBottom = y - 18;
  const lb = await logoBytes();
  if (lb) {
    try {
      const img = await doc.embedPng(lb);
      const lw = 168, lhh = lw * (img.height / img.width);
      page.drawImage(img, { x: M, y: y - lhh, width: lw, height: lhh });
      logoBottom = y - lhh;
    } catch { /* fall through to the text mark */ }
  }
  if (logoBottom === y - 18) {
    page.drawText("CPR Cell Phone Repair", { x: M, y: y - 16, size: 16, font: bold, color: red });
  }
  const stamp = new Date().toLocaleDateString("en-US",
    { timeZone: "America/Los_Angeles", year: "numeric", month: "long", day: "numeric" });
  page.drawText(stamp, { x: W - M - font.widthOfTextAtSize(stamp, 9), y: y - 14, size: 9, font, color: grey });
  y = logoBottom - 16;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: rule });
  y -= 26;

  // title + which wording this is
  for (const ln of wrapW(latin1ish(opts.title), bold, 15, CW)) {
    ensure(21);
    page.drawText(ln, { x: M, y: y - 15, size: 15, font: bold, color: dark });
    y -= 21;
  }
  page.drawText("Version " + opts.version, { x: M, y: y - 10, size: 9, font, color: grey });
  y -= 24;

  para(kbToPdfMarkup(opts.body));

  // acknowledgment + signature
  ensure(190);
  y -= 18;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: rule });
  y -= 24;
  page.drawText("Acknowledgment and signature", { x: M, y: y - 11, size: 11, font: bold, color: dark });
  y -= 20;
  para(opts.ackText || ACK_DEFAULT, font, 9.5, grey, 14);
  y -= 6;
  const bytes = bytesFromDataUrl(opts.sig.png);
  if (bytes) {
    try {
      const img = await doc.embedPng(bytes);
      const dh = Math.min(70, 200 * (img.height / img.width));
      const dw = dh * (img.width / img.height);
      ensure(dh + 34);
      page.drawImage(img, { x: M, y: y - dh, width: dw, height: dh });
      y -= dh + 6;
    } catch { /* a bad png just leaves the typed name as the record */ }
  }
  ensure(30);
  page.drawLine({ start: { x: M, y }, end: { x: M + 220, y }, thickness: 0.8, color: grey });
  y -= 13;
  const when = new Date(opts.sig.at || Date.now()).toLocaleString("en-US",
    { timeZone: "America/Los_Angeles", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  page.drawText(latin1ish(opts.sig.name) + "  ·  " + when, { x: M, y, size: 9.5, font, color: grey });
  return await doc.save();
}

/* ---------- caller -> staff row ---------- */
async function whoami(req: Request) {
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "") || "";
  if (!auth) return null;
  const { data: u } = await admin.auth.getUser(auth);
  if (!u?.user) return null;
  const { data: me } = await admin.from("staff")
    .select("id, display_name, role").eq("auth_uid", u.user.id).eq("active", true).maybeSingle();
  return me as { id: number; display_name: string; role: string } | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ping with no body */ }
  const action = String(body.action || "");
  if (action === "ping") return json({ ok: true });

  const me = await whoami(req);
  if (!me) return json({ ok: false, error: "unauthorized" }, 401);

  /* ---- sign ---- */
  if (action === "sign") {
    const articleId = Number(body.article_id || 0);
    const sig = String(body.signature || "");
    const name = String(body.name || "").trim();
    if (!articleId) return json({ ok: false, error: "missing_article" }, 400);
    if (!name || name.length < 2) return json({ ok: false, error: "name_required" }, 400);
    if (badSig(sig)) return json({ ok: false, error: "signature_required" }, 400);

    const { data: art } = await admin.from("kb_articles")
      .select("id, slug, title, body, version, signature_version, status, require_signature")
      .eq("id", articleId).maybeSingle();
    if (!art) return json({ ok: false, error: "not_found" }, 404);
    if (art.status !== "published") return json({ ok: false, error: "not_published" }, 400);
    if (!art.require_signature) return json({ ok: false, error: "signature_not_required" }, 400);

    // version = the exact wording (bumps on every edit, printed on the PDF).
    // epoch  = the signature obligation (bumps only when a manager declares a
    //          revision material), so a typo fix never makes the team re-sign.
    const version = Number(art.version || 1);
    const epoch = Number(art.signature_version || 1);

    // Already signed THIS epoch? Hand back the existing record — a double tap
    // on a slow connection must not file a second copy of the same document.
    const { data: existing } = await admin.from("kb_signatures")
      .select("id, signed_at, document_id")
      .eq("staff_id", me.id).eq("article_id", articleId).eq("signature_epoch", epoch).maybeSingle();
    if (existing) return json({ ok: true, already: true, signature: existing });

    const now = new Date().toISOString();
    let pdf: Uint8Array;
    try {
      pdf = await buildPolicyPdf({
        title: String(art.title || "Policy"), body: String(art.body || ""), version,
        sig: { png: sig, name, at: now },
        ackText: String(body.ack_text || "") || undefined,
      });
    } catch (e) {
      return json({ ok: false, error: "pdf_failed", detail: String(e).slice(0, 200) }, 500);
    }

    const path = `staff/${me.id}/${crypto.randomUUID()}.pdf`;
    const up = await admin.storage.from("hr-private")
      .upload(path, pdf, { contentType: "application/pdf", upsert: false });
    if (up.error) return json({ ok: false, error: "upload_failed", detail: up.error.message }, 500);

    const fileName = `${art.title} — signed.pdf`;
    const { data: doc, error: docErr } = await admin.from("staff_documents").insert({
      staff_id: me.id,
      kind: "policy",
      title: `${art.title} — signed`,
      file_path: path,
      file_name: fileName,
      mime: "application/pdf",
      file_size: pdf.byteLength,
      signed_at: now,
      source: `kb:${art.slug}:e${epoch}`,
      uploaded_by: me.id,
      uploaded_by_name: me.display_name,
    }).select("id").single();
    if (docErr) {
      // never leave an orphan file behind a failed record
      await admin.storage.from("hr-private").remove([path]).catch(() => {});
      return json({ ok: false, error: "file_failed", detail: docErr.message }, 500);
    }

    const { data: srow, error: sErr } = await admin.from("kb_signatures").insert({
      article_id: articleId, article_version: version, signature_epoch: epoch, staff_id: me.id,
      signed_name: name.slice(0, 120), signature_png: sig, signed_at: now,
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      ua: (req.headers.get("user-agent") || "").slice(0, 400) || null,
      document_id: doc.id,
    }).select("id, signed_at, document_id").single();
    if (sErr) {
      // a lost race on the unique key means someone else's request already
      // filed it — drop ours and return theirs rather than double-filing
      await admin.from("staff_documents").delete().eq("id", doc.id);
      await admin.storage.from("hr-private").remove([path]).catch(() => {});
      const { data: other } = await admin.from("kb_signatures")
        .select("id, signed_at, document_id")
        .eq("staff_id", me.id).eq("article_id", articleId).eq("signature_epoch", epoch).maybeSingle();
      if (other) return json({ ok: true, already: true, signature: other });
      return json({ ok: false, error: "sign_failed", detail: sErr.message }, 500);
    }

    // The read receipt is what every existing compliance surface reads, so a
    // signature must stamp it too. Best-effort in a real try/catch: a
    // PostgrestBuilder is thenable but has no .catch(), and the signature is
    // the record of truth — it must not be lost to a receipt write.
    try {
      await admin.from("kb_reads").upsert({
        article_id: articleId, staff_id: me.id,
        acknowledged_at: now, last_viewed_at: now,
      }, { onConflict: "article_id,staff_id" });
    } catch { /* the signature stands on its own */ }

    return json({ ok: true, signature: srow, version, epoch });
  }

  /* ---- my_doc: a 120-second link to your own signed PDF ----
     The page never holds a URL to a file, and hr-private's storage policies
     only open the staff/ prefix to is_admin() — so an employee downloading
     their OWN signed copy has to be minted here. */
  if (action === "my_doc") {
    const sigId = Number(body.signature_id || 0);
    if (!sigId) return json({ ok: false, error: "missing_signature" }, 400);
    const { data: srow } = await admin.from("kb_signatures")
      .select("id, staff_id, document_id").eq("id", sigId).maybeSingle();
    if (!srow) return json({ ok: false, error: "not_found" }, 404);
    const mgr = ["admin", "manager", "owner"].includes(String(me.role));
    if (Number(srow.staff_id) !== me.id && !mgr) return json({ ok: false, error: "forbidden" }, 403);
    if (!srow.document_id) return json({ ok: false, error: "no_document" }, 404);
    const { data: doc } = await admin.from("staff_documents")
      .select("file_path, file_name").eq("id", srow.document_id).maybeSingle();
    if (!doc) return json({ ok: false, error: "no_document" }, 404);
    const { data: signed, error } = await admin.storage.from("hr-private")
      .createSignedUrl(doc.file_path, 120, { download: doc.file_name });
    if (error) return json({ ok: false, error: "url_failed", detail: error.message }, 500);
    return json({ ok: true, url: signed.signedUrl });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
