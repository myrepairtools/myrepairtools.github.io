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
// Candidate-facing mail can carry its own From (e.g. hiring@) — an offer letter
// reading "noreply@" undercuts it. Falls back to the system sender.
const HIRING_FROM = Deno.env.get("HIRING_FROM") || NOTIFY_FROM;
const REPLY_TO_ENV = Deno.env.get("NOTIFY_REPLY_TO") || "";
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
  "offer_body, offer_signed_at, offer_signed_name, offer_signature, offer_declined_at, " +
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

// KB light markup -> the PDF builder's plain markup: bullets normalize to
// '• ', body headings demote under the section title, inline marks strip to
// text, images drop (a print handbook reads as text).
function kbToPdfMarkup(body: string): string {
  return String(body || "").split("\n").map((ln) => {
    let l = ln;
    if (/^\s*!\[/.test(l)) return "";
    // the PDF has no table engine — drop the |---| rule and lay each row out
    // as "cell — cell" so a handbook table still reads as prose
    if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && /-/.test(l) && /\|/.test(l)) return "";
    if (/^\s*\|.*\|\s*$/.test(l)) {
      return "• " + l.replace(/^\s*\|/, "").replace(/\|\s*$/, "")
        .split("|").map((c) => c.trim()).filter(Boolean).join("  —  ");
    }
    if (/^####\s+/.test(l)) l = "## " + l.replace(/^####\s+/, "");
    else if (/^###\s+/.test(l)) l = "## " + l.replace(/^###\s+/, "");
    else if (/^#\s+/.test(l)) l = "## " + l.replace(/^#\s+/, "");
    l = l.replace(/^(\s*)[-*]\s+/, "$1• ");
    l = l.replace(/^!(#[0-9a-fA-F]{6}\|#[0-9a-fA-F]{6}\|#[0-9a-fA-F]{6}|[rgbnd])?>\s+/, "Note: ");
    l = l.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1");
    l = l.replace(/(^|[\s(>])\*([^*\n]+)\*/g, "$1$2");
    l = l.replace(/!\[[^\]]*\]\([^)]+\)/g, "");
    l = l.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
    l = l.replace(/`([^`]+)`/g, "$1");
    return l;
  }).join("\n");
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
// Owner signature for the offer letter closing — drawn wherever the body has
// a line that is exactly "{signature}"; the line collapses if the image is
// missing. The PNG lives in the PRIVATE hr-private storage bucket (no
// policies — service-role only), deliberately NOT in the public repo:
// a real signature on public hosting would be a forgery kit. Cached per
// warm boot.
// The handbook acknowledgment wording (the owner's real At-Will Employment
// Agreement page) — owner-editable in app_settings 'hiring.handbook_ack';
// falls back to a minimal built-in acknowledgment.
const ACK_FALLBACK = {
  title: "Employee Handbook Acknowledgment",
  version: "", employer_name: "", employer_title: "",
  body: "I acknowledge that I have received, read, and understand the CPR Employee Handbook, and I agree to follow its policies.",
};
async function handbookAck() {
  const { data } = await admin.from("app_settings").select("value").eq("key", "hiring.handbook_ack").maybeSingle();
  const v = (data?.value && typeof data.value === "object") ? data.value : {};
  return { ...ACK_FALLBACK, ...v };
}
let _ownerSig: Uint8Array | null | undefined;
async function ownerSigBytes(): Promise<Uint8Array | null> {
  if (_ownerSig !== undefined) return _ownerSig;
  try {
    const { data } = await admin.storage.from("hr-private").download("owner-signature.png");
    _ownerSig = data ? new Uint8Array(await data.arrayBuffer()) : null;
  } catch { _ownerSig = null; }
  return _ownerSig;
}
// CPR logo for the PDF letterhead — rasterized from
// assets/images/CPRLogo_NoAssurant_Black.svg (same PNG committed at
// assets/images/cpr-logo-letterhead.png). Embedded so the function stays
// self-contained; pdf-lib can't take SVG.
const LOGO_B64 = "iVBORw0KGgoAAAANSUhEUgAABBAAAADGCAYAAABrTXPRAAAQAElEQVR4nOzdB3wb5fkH8N97kh1nMuwEKGW1zJRCwElseZ7D3hRIgbTsUaAFyh5lUzZ/VqFQyt6z7E1iecpOYsLeq9ASSJwEkpBhS/f+n1dJaBLrZNnWOEm/74cgWXead/fee8/7vs/rB6XcLNveVGm9gVJqDWg9XB4aBgvDNTBU7g+HVssei/7TQ6GwWO4vlMcXKLnVSs9XWv0YfUw5C5bd4nuEMbOksfEDEBEREREREaWYAiXFgoqKUYsLCraQIMEWUHozaGwFpTaXRVsg1bT+RDblx3LvQ/n3qfz9kfL5Pi6ZMuW/ICIiIiIiIkoCBhD6YV5d3bZhrcfJ3bEa2FYpPVp+yhHwGA29SDbwu9DqbflzOiKRaSObmt4AERERERERUR8xgBCHBAdUZ13d5tKiP1Z+qHGOwlh5dDsFNQRZS3dFAwpKT9MOpvm1nr5WY+N78v0cEBEREREREblgACEGEziYU1c33tF6X/mB9pVfaUvkKPmunymNp3xKPb1WfX2IgQQiIiIiIiKKhQGE5fTEib45c76rdRxrP6UkaACsjzwjwYTvFPQzltJPrv3Dj/Wqo6MbRERERERERMjzAILebbdBnYsX76SV3k9+ir3lxygGLaPxvfz/eaX1v4oXLnxFggmLQERERERERHkrLwMIPwQCay8tLPwdlDpSKYwBxaf1JwrqrkFdXXcNb22dBSIiIiIiIso7eRVAmFNdPdrx+U7RwO8lcFAE6quIRBOe1BF95ajGxhkgIiIiIiKivJEXAYQ5tbU7RZQ6TYIGu4CSQyMIpa4tqa9/UUXTJxAREREREVEuy+kAwuy6ulqt9ZUSOCgHpcp7ytHnFzc0PM1AAhERERERUe7KyQBCZ11dmQkcyLezQemh9Qwo65SR9fUNICIiIiIiopyTUwGEWTU12ymf+qt8rd1BmaERVEqdXVJf3w4iIiIiIiLKGTkRQJhn2xuHlb5E7v5OvpIFyjytn/NBnbt2MPguiIiIiIiIKOtldQBhQXX1yKV+6zwNHCdfpRDkMdqRbfOA6gqfM7Kl5RsQERERERFR1sraAMLsuppJWlv/pxTWBXndD0rjvOJg8O+ywzkgIiIiIiKirJN1AYTvq6p+0V3g+6d89AmgLKPf0BF99KjGxhkgIiIiIiKirJI1AQQtn3W2bZ8kd820jEWgbBVRGlcWL1hwsero6AYRERERERFlhawIIMyurPwZCgruk0+7Ayg3aD1DQU0qCQY/BBEREREREXme52csmGXbB0rw4D0GD3KMUts5wIxZtbUn6hybTpSIiIiIiCgXefbCTY8eXdg5atRV8gn/DMptGo+WAIerYHAJiIiIiIiIyJM8GUBYuMMO6yx2ws/KxxsPygsaeMvf1b332i0tX4GIiIiIiIg8x3MBhM7a2nGOUs9yesb8I0GEOQrqsJH19S+AiIiIiIiIPMVTORDm2PYBjqWaGDzITxLNKpYwwjOzamuPABEREREREXmKZwIIs2z7ZAf6MbmIHATKZz5lqbtm19VeACIiIiIiIvIMTwxhmG3b1zNZIq1OQd9VXN9wjOykDoiIiIiIiCijMhpA0BMn+jo7Z90qH+MYEMWi8UzJrFm/Ve+/3wUiIiIiIiLKmIwFEJZP0/ikfII9QRSPxuSSBQv2Vh0di0BEREREREQZkZEAgi4tHdI5fNjzUKoORAnQGm1+v3/XtV9//QcQERERERFR2qU9gDB3xx3XiES6X5W3Ho9sVlCA4pdfQbaYN2kSnO++RTbT0G/7InrP4sbGr0FERERERERpldZZGObZ9prhSPeLWR88oIxQUNs4Puu1BRUVo0BERERERERplbYAggkedAP1chFYAaL+22LJoMLGuZWVG4KIiIiIiIjSJi0BBNNiHA0eKIwB0cBtESksYBCBiIiIiIgojVIeQNC27V9cWPAAgweUZBuFCwqekf2rCERERERERJRyKQ8gdAI3K6V2AlGSmaDUbOj7dAanIyUiIiIiIsoXKQ0gzLbtP8ul3R9AlCISnJoo+9kVICIiIiIiopRKWQCh07Z3hNL/B6IUUwpnzbLto0BEREREREQpk5IAwpyamg20whNyaZfWaSIpjyl906yamu1AREREREREKZH0C3wdCAx2fOppubsGiNJEQQ1Rst/NKSsbASIiIiIiIkq6pAcQOosK75DLue1BlHZqQ2fw4IeYVJGIiIiIiCj5khpAiCZNhJoEokxR2KPTti8EERERERERJVXSAggSPBgL6KtBlGlKn985oWYCiIiIiIiIKGmSEkCYu+OOa2jgcShVAKKMU5bjWA8u3GGHdUBERERERERJkZQAQiQcvlcpbAwij5D9cd3FkciDzIdARERERESUHAMOIMy27YPkEm0fEHmNwg6dtn0yiIiIiIiIaMAGFED4vqpqLSh9C4g8SgOXzrLtTUFEREREREQDMqAAQrfff6s0864NIo9SCsOU0neCiIiIiIiIBqTfAYRO294XCgeCyPNUzWzbPg5ERERERETUb/0KIOjRowu10jeCKEto6EtmV1YOBxEREREREfVLvwIIc0aNOlVadTcEUZZQSo3UBQV/AREREREREfVLnwMI8227RFpzzwVRtlH489zKSga+iIiIiIiI+qHPAYSlwF+lOZddwSnrKGBQpKDgahAREREREVGf9SmAMM+2N5arsKNBlK0UDpxt2zaIiIiIiIioT/oUQAgDV8qND0TZTOEiEBERERERUZ8kHECYa9tbc9pGyhG1c2x7VxAREREREVHCEg4gREzuA6IcEVHR3jRERERERESUoIQCCHPr6iqhsA+IcoQCtu207X1BRERERERECUkogBDR+gwQ5RitcDaIiIiIiIgoIb0GEGbZ9qZyqbU3iHJPGWdkICIiIiIiSkwiPRDOg1IKRDlIg70QiIiIiIiIEhE3gGB6H0jk4HcgylEKeufZdXWlICIiIiIiorjiBhAkePB7+Z8fRLlKKaW1PhFEREREREQUl2sAQU+c6IPSR4Ao1ykcoEtLh4CIiIiIiIhcuQYQ5syevZdcWW0IohyngKGdw4cfCiIiIiIiInLlGkBwgONAlCe04v5OREREREQUT8wAwoKKilEmuRyI8oQCtu207S1BREREREREMcUMICwpLNyPUzdSvtHAQSAiIiIiIqKYYg9hULyQojzE/Z6IiIiIiMhVjwCCGb4ArWtAlH+24DAGIiIiIiKi2HoEEDh8gfIZhzEQERERERHF1iOAIBdQ+4IoT2nF/Z+IiIiIiCiWVQIIurS0QCldB6I8pbTepnPChPVBREREREREq1glgDB3+PAd5BKqEET5ygzfcZydQERERERERKtYtQcCsCuI8hyPAyIiIiIiop78K/+hFS+ciMDjgIiIiIiIqIefAgjfV1Wt1Q29mbl6Ispza8yy7TGjgsE3kSfKqqu3UY5vO2VhjNbYWsqBgmVLdJcUCXOUxhwNdEJpuVWz5e9vF80vnPb226/+COpVlZSvYRRsvmh+wbvZ9puNr6rbFuhePLW5+WNQ1isvtze2Cp0Nl2r9SUdT00x4UGl1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ggWnytXbGyDKGP2VHzgORERERERElFRJDSCojo5FVkTvK3d/AFGaaehFWvY/M6QGRERERERElFRJDSAYxY2NX2s4k+RyzgFRGikHR49qbJwBIiIiIiIiSrqkBxCMUfWNLyqt/gKiNFEaN45saHgYRERERERElBIpCSAYJcHgldB4AEQpp58tHjnyNBAREREREVHKpCyAYJSMHHm4ubgDUcroqSVFQ36rHn88AiIiIiIiIkqZlAYQzEWdubgzF3kgSjKt8W7hkq7d1EsvLQURERERERGlVEoDCIa5uBtk+XfXWr8DouT5tw/YbY1QaC6IiIiIiIgo5VIeQDBGTJ48R0WcXTT05yAaKK1n+jXs4mDwPyAiIiIiIqK0SEsAwRjZ1DSzMKJ3lKu/b0DUb3qugpqwVjD4JYiIiIiIiCht0hZAMNZsbPzCCjs7MYhA/aE1FkL2n5Jg8EMQERERERFRWilkwCzb3lQpPVnefkMQJULje6X1ziUNDdNAREREREREaZeRAIIxp6ZmA8dSk6HUZiCKR+uvfVC7rx0MvgsiIiIiIiLKiIwFEIwF1dUjF/ut1xXUNiCKQWt86gPqmDCRiIiIiIgos9KaA2F1w5uaZvsWLamGxusgWo2Gbh3i81UxeEBERERERJR5GQ0gGMXt7fNLRo7cVVqarwLRChoPjpy/0B42efJ3ICIiIiIioozL6BCG1c2uq5kkH+lu+VcIylcRCSadNioYvBFERERERETkGZ4KIBhzamsDjsKTUGo9UJ7RczX0IaPqG18EEREREREReYrnAgjGLNteV26eUgrloLygtX7H5+g9ihsbvwYRERERERF5jicDCIYePbqwc52RV8pHPAWU07TGEyOBQ1QwuARERERERETkSZ4NIKwwx7YPcIB/yiddE5RTJHCwxAJOLwkGbwERERERERF5mucDCMbsysqfoaDgPvm0O4Byg9YzFNQkCR58CCIiIiIiIvK8rAggGFo+6+za2j9BqauVQhEoW0UU9FXF8xdepDo6ukFERERERERZIWsCCCt8X1X1i+4C3z/lo08AZRn9ho7oo0c1Ns4AERERERERZZWsCyCsMNu2D9LA9UphXZCnyXaaI/87a2QweLfscA6IiIiIiIgo62RtAMGYU1Y2IjJ48GUSRPgTyJM09H1Flv/UEZMnzwERERERERFlrawOIKzQWVOzleNTdyioCpAnaOAtKxw5tqSpaSqIiIiIiIgo6+VEAMEwSRbn1Nb+3lmWZJHDGjJGz4VWfykJBm/ncAUiIiIiIqLckTMBhBV0aemQOcOHH+FAn6aU2gSULv+VKM4N1uLFtxe3t88HERERERER5ZScCyCsoCdO9M2eNWs/CSKcKd9yLChF9MdwcG3JwoX3cFpGIiIiIiKi3JWzAYSVddr2jg5wmlLYFZQcGkH5//+VBIMvqOgIEiIiIiIiIspleRFAWGFOdfVox+c7Ra52fy/BhCJQ32jdLXvMIzqirx/V2DgDRERERERElDfyKoCwwg+BwNrdgwYdrKGPglLbgeLT+hOtcbfl891XMmXKf0FERERERER5Jy8DCCubZdtjoPQx8kMcJD/H2qAoDfyooB+yHNxd3NAQAhEREREREeW1vA8grKBHjy6cM3LkHtrC4dBqd/ll/Mg3WptcBkEFdW9xYeET6tVXfwQRERERERERGECIaUFFxaglgwp+L3f3kJ9oAnKd1k0a6hWf49xX3Nj4NYiIiIiIiIhWwwBCL7RtF82xnApotYMDVSsX29srpQYji2mNNqV0o6X05LV/+LFZdXQsAhEREREREVEcDCD0w7y6um27tR4rP944+bNUfsWx8CqtZ8hm7pB70xGJTBvZ1PQGiIiIiIiIiPqIAYQk6aytHaeVKpW7Y7XSWymo9eX+RkgXjf/I1vyv1vjAAjpkw04vDgbbQERERERERJQEDCCk2HzbLgk7znraj/W0Y60nD63nKP0zaLWe/PglsgV63wbajDrAHLk3E0rPhIOZPsv6RgIF3/qXLp05vLV1FoiIiIiIiIhS6P8BAAD//8JmoIEAAAAGSURBVAMA8TbIKnDGFx4AAAAASUVORK5CYII=";
type SigBlock = { png: string; name: string; at: string };
async function buildOfferPdf(opts: {
  body: string; link?: string; storeLine?: string;
  offerSig?: SigBlock | null;
  handbookSig?: SigBlock | null;
  ack?: Record<string, unknown> | null;
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
  let ownerImg: Awaited<ReturnType<typeof doc.embedPng>> | null = null;
  const sigBytes = await ownerSigBytes();
  if (sigBytes) {
    try { ownerImg = await doc.embedPng(sigBytes); }
    catch { /* a bad image just collapses the placeholder */ }
  }
  const para = (text: string, f = font, size = 10.5, color = dark, lh = 16) => {
    for (const raw of latin1ish(text).split("\n")) {
      if (raw.trim() === "{pagebreak}") { newPage(); continue; }
      if (raw.trim() === "{signature}") {
        if (ownerImg) {
          const sw = 150, sh = sw * (ownerImg.height / ownerImg.width);
          ensure(sh + 8);
          page.drawImage(ownerImg, { x: M, y: y - sh, width: sw, height: sh });
          y -= sh + 4;
        }
        continue;
      }
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
  // letterhead — logo top-left (falls back to text if the embed ever fails)
  let logoBottom = y - 18;
  try {
    const logoImg = await doc.embedPng(Uint8Array.from(atob(LOGO_B64), (c) => c.charCodeAt(0)));
    const lw = 168, lhh = lw * (logoImg.height / logoImg.width);
    page.drawImage(logoImg, { x: M, y: y - lhh, width: lw, height: lhh });
    logoBottom = y - lhh;
  } catch {
    page.drawText("CPR Cell Phone Repair", { x: M, y: y - 16, size: 16, font: bold, color: red });
  }
  const dt = new Date().toLocaleDateString("en-US",
    { timeZone: "America/Los_Angeles", year: "numeric", month: "long", day: "numeric" });
  page.drawText(dt, { x: W - M - font.widthOfTextAtSize(dt, 9), y: y - 14, size: 9, font, color: grey });
  y = logoBottom;
  if (opts.storeLine) {
    page.drawText(latin1ish(opts.storeLine), { x: M, y: y - 13, size: 8.5, font, color: grey });
    y -= 13;
  }
  y -= 14;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: rule });
  y -= 26;
  // an acknowledgment archived on its own has no letter body — start it on
  // page 1 instead of leaving a blank sheet in front of it
  const hasBody = !!String(opts.body || "").trim();
  if (hasBody) para(opts.body);
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
    const ack = opts.ack || ACK_FALLBACK;
    if (hasBody) newPage();
    for (const ln of wrapW(latin1ish(String(ack.title || "Employee Handbook Acknowledgment")), bold, 13, CW)) {
      page.drawText(ln, { x: M, y: y - 13, size: 13, font: bold, color: dark });
      y -= 19;
    }
    y -= 4;
    const meta = ["Employee: " + (opts.handbookSig.name || ""), ack.version ? "Handbook Version: " + ack.version : ""].filter(Boolean).join("   ·   ");
    page.drawText(latin1ish(meta), { x: M, y: y - 9.5, size: 9.5, font, color: grey });
    y -= 24;
    para(String(ack.body || ""), font, 9.8, dark, 14.5);
    y -= 6;
    para("The Employee Handbook was presented in full, section by section, immediately before the employee signature below was captured.", font, 8.5, grey, 12.5);
    if (ownerImg && ack.employer_name) {
      ensure(120);
      y -= 12;
      const sw = 120, sh = sw * (ownerImg.height / ownerImg.width);
      page.drawImage(ownerImg, { x: M, y: y - sh, width: sw, height: sh });
      y -= sh + 4;
      page.drawLine({ start: { x: M, y }, end: { x: M + 220, y }, thickness: 0.8, color: grey });
      y -= 13;
      page.drawText(latin1ish(ack.employer_name + (ack.employer_title ? "  ·  " + ack.employer_title : "") + "  ·  Employer"),
        { x: M, y, size: 9.5, font, color: grey });
      y -= 8;
    }
    await drawSig("Employee signature", opts.handbookSig);
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
        from: HIRING_FROM, to: [to], subject, text, html: emailHtml(text),
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
/* Stage two. Fires once, when the offer is signed: their signed copy attached,
   and the link to the handbook + new-hire form. Stamped so a re-signed or
   replayed request can't email twice. */
async function sendNewHireEmail(it: Record<string, unknown>): Promise<void> {
  const email = String(it.personal_email || "");
  if (!/@/.test(email) || it.newhire_sent_at) return;
  const link = SITE + "/intake.html?t=" + String(it.token) + "&s=hire";
  const first = String(it.invited_name || it.offer_signed_name || "").trim().split(/\s+/)[0] || "there";
  const text = "Hi " + first + ",\n\n"
    + "Your signed offer letter is attached — that copy is yours to keep, so there's nothing to print or bring in.\n\n"
    + "Next, two things to finish online (about 10 minutes):\n"
    + "  1. Read and acknowledge the Employee Handbook\n"
    + "  2. Fill out your new-hire form — contact details, emergency contacts, and your availability\n\n"
    + link + "\n\n"
    + "Questions? Just reply to this email.\n\n— CPR Cell Phone Repair, Oregon";
  let pdf: Uint8Array;
  try {
    pdf = await buildOfferPdf({
      body: String(it.offer_body || ""),
      storeLine: await storeLetterhead(String(it.invited_store || "")),
      offerSig: {
        png: String(it.offer_signature || ""),
        name: String(it.offer_signed_name || ""),
        at: String(it.offer_signed_at || ""),
      },
    });
  } catch { return; }
  const r = await sendOfferEmail(email, "Welcome to CPR — your next steps", text,
    pdf, "CPR Offer — signed.pdf", await hiringReplyTo());
  if (r.ok) {
    await admin.from("staff_intake")
      .update({ newhire_sent_at: new Date().toISOString() })
      .eq("id", it.id as number).is("newhire_sent_at", null);
  }
}

/* Archive the signed paperwork onto the PERSON.

   The intake row is a hiring record — it disappears from the Onboarding board
   the moment someone is promoted — so their signed documents get frozen to
   PDFs in the private hr-private bucket and filed in staff_documents, where
   Team Members can reach them for as long as the employee exists. Frozen, not
   regenerated: the handbook acknowledgment renders from live KB articles, and
   a rebuilt copy would show today's wording rather than what they signed.

   Best-effort by design — a storage hiccup must never block a conversion. */
async function archiveDocs(
  it: Record<string, unknown>,
  staffId: number,
  by: { id?: number; display_name?: string } | null,
): Promise<{ filed: number; errors: string[] }> {
  const errors: string[] = [];
  let filed = 0;
  const source = "intake:" + it.id;
  const who = candName(it);
  const storeLine = await storeLetterhead(it.invited_store);

  const file = async (kind: string, title: string, pdf: Uint8Array, signedAt: unknown) => {
    const path = "staff/" + staffId + "/" + crypto.randomUUID() + ".pdf";
    const up = await admin.storage.from("hr-private")
      .upload(path, pdf, { contentType: "application/pdf", upsert: false });
    if (up.error) { errors.push(kind + ": " + up.error.message); return; }
    const { error } = await admin.from("staff_documents").upsert({
      staff_id: staffId, kind, title, file_path: path,
      file_name: title.replace(/[\\/:*?"<>|]/g, "") + ".pdf",
      mime: "application/pdf", file_size: pdf.length,
      signed_at: signedAt || null, source,
      uploaded_by: by?.id || null, uploaded_by_name: by?.display_name || null,
    }, { onConflict: "staff_id,kind,source" });
    if (error) {
      // the row failed, so don't leave an orphan file behind
      await admin.storage.from("hr-private").remove([path]).catch(() => {});
      errors.push(kind + ": " + error.message);
      return;
    }
    filed++;
  };

  if (it.offer_body && it.offer_signed_at) {
    try {
      const pdf = await buildOfferPdf({
        body: String(it.offer_body), storeLine,
        offerSig: { png: String(it.offer_signature || ""), name: String(it.offer_signed_name || who), at: String(it.offer_signed_at) },
      });
      await file("offer", "Offer letter — signed", pdf, it.offer_signed_at);
    } catch (e) { errors.push("offer: " + (e instanceof Error ? e.message : String(e))); }
  }

  if (it.handbook_signed_at) {
    try {
      const pdf = await buildOfferPdf({
        body: "", storeLine,
        handbookSig: { png: String(it.handbook_signature || ""), name: String(it.handbook_signed_name || who), at: String(it.handbook_signed_at) },
        ack: await handbookAck(),
      });
      await file("handbook", "Employee handbook acknowledgment", pdf, it.handbook_signed_at);
    } catch (e) { errors.push("handbook: " + (e instanceof Error ? e.message : String(e))); }
  }

  if (it.submitted_at) {
    try {
      const pdf = await buildOfferPdf({ body: intakeFormMarkup(it), storeLine });
      await file("intake_form", "New-hire form", pdf, it.submitted_at);
    } catch (e) { errors.push("intake_form: " + (e instanceof Error ? e.message : String(e))); }
  }

  return { filed, errors };
}

/* What they filled in, laid out for the HR file. */
function intakeFormMarkup(it: Record<string, unknown>): string {
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const addr = (it.address || {}) as Record<string, string>;
  const em = (it.emergency || {}) as Record<string, string>;
  const em2 = (it.emergency2 || {}) as Record<string, string>;
  const row = (k: string, v: unknown) => (v ? "• " + k + ": " + v + "\n" : "");
  const person = (e: Record<string, string>) =>
    [e.name, e.relationship, e.phone].filter(Boolean).join("  ·  ");
  const av = Array.isArray(it.availability)
    ? (it.availability as Array<Record<string, unknown>>).map((a) =>
      "• " + (DAYS[Number(a.day)] || "") + ": "
      + (a.mode === "all" ? "All day" : a.mode === "off" ? "Off" : [a.from, a.to].filter(Boolean).join(" - "))).join("\n")
    : "";
  return "# New-Hire Form\n"
    + [it.legal_first, it.legal_middle, it.legal_last].filter(Boolean).join(" ")
    + (it.preferred_name ? '  (goes by "' + it.preferred_name + '")' : "") + "\n\n"
    + "## Personal\n"
    + row("Date of birth", it.dob)
    + row("Mobile", it.phone)
    + row("Email", it.personal_email)
    + row("Address", [addr.street, addr.city, addr.zip].filter(Boolean).join(", "))
    + row("Shirt size", it.shirt_size)
    + "\n## Employment\n"
    + row("Position", it.position)
    + row("Store", it.invited_store)
    + row("Start date", it.start_hint || it.start_date)
    + row("I-9 documents", it.i9_docs)
    + "\n## Emergency contacts\n"
    + row("Primary", person(em))
    + row("Secondary", person(em2))
    + (av ? "\n## Availability\n" + av + "\n" : "")
    + "\nSubmitted " + new Date(String(it.submitted_at || Date.now())).toLocaleDateString("en-US",
      { timeZone: "America/Los_Angeles", year: "numeric", month: "long", day: "numeric" }) + ".";
}

/* QuickBooks employee, created once the new-hire form is in. Intuit's create
   endpoint is not idempotent, so the qbo function looks the person up first;
   we also stamp the id here and skip anyone already synced. */
async function createQboEmployee(it: Record<string, unknown>): Promise<{ ok: boolean; id?: string; error?: string; skipped?: string }> {
  // Verified 2026-08-14 against the live company (realm 1267613695): the
  // Accounting API's Employee list IS the payroll employee list — 64 records
  // either way, and Britt Bay is Id 575 in both (the payroll record carries
  // intuit.qbo.name.id = 575). An earlier exact-DisplayName probe missed her
  // because QBO stores "Britt A. Bay", which is why the lookup now matches on
  // GivenName + FamilyName. No payroll OAuth scope needed.
  // Still unverified: whether creating this way sets is_self_onboarding and
  // sends the Workforce invite. Watch the first real hire.
  //
  // Kill switch. Nothing reaches QuickBooks unless this is explicitly true —
  // test candidates must never turn into real employee records.
  const { data: cfg } = await admin.from("app_settings")
    .select("value").eq("key", "hiring.qbo_autocreate").maybeSingle();
  if (cfg?.value !== true) return { ok: false, skipped: "disabled", error: "QBO auto-create is off" };
  if (it.qbo_employee_id) return { ok: true, id: String(it.qbo_employee_id) };
  const first = String(it.legal_first || "").trim();
  const last = String(it.legal_last || "").trim();
  if (!first || !last) return { ok: false, error: "no legal name on file" };
  if (!NOTIFY_SECRET) return { ok: false, error: "NOTIFY_SECRET not configured" };
  const addr = (it.address && typeof it.address === "object" ? it.address : {}) as Record<string, string>;
  try {
    const r = await fetch(SB_URL + "/functions/v1/qbo", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_employee", secret: NOTIFY_SECRET,
        first_name: first, last_name: last,
        email: it.personal_email || null, phone: it.phone || null,
        hire_date: it.start_date || null,
        address: { street: addr.street || "", city: addr.city || "", zip: addr.zip || "", state: "OR" },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok && j.id) {
      await admin.from("staff_intake")
        .update({ qbo_employee_id: String(j.id), qbo_synced_at: new Date().toISOString(), qbo_error: null })
        .eq("id", it.id as number);
      return { ok: true, id: String(j.id) };
    }
    const err = String(j.detail || j.error || r.status);
    await admin.from("staff_intake").update({ qbo_error: err.slice(0, 300) }).eq("id", it.id as number);
    return { ok: false, error: err };
  } catch (e) {
    const err = String((e as Error).message || e);
    await admin.from("staff_intake").update({ qbo_error: err.slice(0, 300) }).eq("id", it.id as number);
    return { ok: false, error: err };
  }
}

/* Same PBKDF2 shape cpr-auth uses (salt:hash, 100k, SHA-256) — a PIN written
   here has to verify there. */
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return toHex(salt) + ":" + toHex(new Uint8Array(bits));
}
async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [saltHex] = stored.split(":");
  const salt = new Uint8Array((saltHex.match(/.{2}/g) || []).map((x) => parseInt(x, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return (toHex(salt) + ":" + toHex(new Uint8Array(bits))) === stored;
}
/* PIN-only login must resolve to exactly one person, so a duplicate can't be
   allowed through. Returns the PIN to use, or null when it's taken. */
async function pinFreeOrNull(pin: string): Promise<string | null> {
  if (!/^\d{4}$/.test(pin)) return null;
  const { data: all } = await admin.from("staff").select("pin_hash").eq("active", true);
  for (const s of (all || [])) {
    if (s.pin_hash && await verifyPin(pin, s.pin_hash)) return null;
  }
  return pin;
}

async function hiringReplyTo(): Promise<string | undefined> {
  const { data } = await admin.from("app_settings").select("value").eq("key", "hiring.reply_to").maybeSingle();
  const v = data?.value?.email;
  if (v && /@/.test(String(v))) return String(v);
  return REPLY_TO_ENV && /@/.test(REPLY_TO_ENV) ? REPLY_TO_ENV : undefined;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = String(body.action || "");

  // ---- candidate side (token auth) ----
  if (action === "day_one") {
    // 7:30am store-local on someone's first day. Sent from the STORE's own
    // RingCentral line (messaging's `send` resolves the line from `store`) —
    // never the company alerts number, which is for staff notifications.
    // Secret-gated: this is a cron, there's no staff JWT to check.
    const secret = String(body.secret || new URL(req.url).searchParams.get("secret") || "");
    if (!NOTIFY_SECRET || secret !== NOTIFY_SECRET) return json({ error: "forbidden" }, 403);
    // "today" is Pacific — a UTC date would fire a day early all evening.
    const today = new Date(Date.now() - 8 * 3600 * 1000).toISOString().slice(0, 10);
    const { data: due } = await admin.from("staff_intake")
      .select("id, token, invited_name, invited_store, legal_first, preferred_name, phone, i9_docs, start_date")
      .eq("start_date", today)
      .is("dayone_sms_at", null)
      .is("offer_declined_at", null)
      .not("offer_signed_at", "is", null)
      .not("phone", "is", null);
    const results: Record<string, unknown>[] = [];
    for (const it of (due || [])) {
      const first = String(it.preferred_name || it.legal_first || it.invited_name || "").trim().split(/\s+/)[0];
      // "Something else" reads badly inside "bring your ___"
      const docs = it.i9_docs && !/^something else/i.test(String(it.i9_docs))
        ? String(it.i9_docs)
        : "ID and work-authorization documents";
      const msg = "Good morning" + (first ? " " + first : "")
        + ", we are excited to have you start today! Please remember to bring your "
        + docs + " so we can complete your Form I-9 paperwork today.";
      // dry_run composes and reports without sending — safe to exercise against
      // real rows, and how the cron gets verified without texting anyone
      if (body.dry_run) { results.push({ id: it.id, name: first, to: it.phone, store: it.invited_store, message: msg }); continue; }
      let ok = false, err = "";
      try {
        const r = await fetch(SB_URL + "/functions/v1/messaging", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "send", secret: NOTIFY_SECRET, to: it.phone, body: msg,
            store: it.invited_store, template_key: "day_one",
            agent_name: "MRT Onboarding",
          }),
        });
        const j = await r.json().catch(() => ({}));
        ok = r.ok && j.ok !== false;
        if (!ok) err = String(j.error || r.status);
      } catch (e) { err = String((e as Error).message || e); }
      // stamp only on success, so a failure retries on the next run
      if (ok) {
        await admin.from("staff_intake")
          .update({ dayone_sms_at: new Date().toISOString() })
          .eq("id", it.id).is("dayone_sms_at", null);
      }
      results.push({ id: it.id, name: first, ok, ...(err ? { error: err } : {}) });
    }
    return json({ ok: true, date: today, considered: (due || []).length, results });
  }

  if (action === "get") {
    const token = String(body.token || "");
    if (!token) return json({ error: "token required" }, 400);
    const { data } = await admin.from("staff_intake").select(PUBLIC_FIELDS).eq("token", token).maybeSingle();
    if (!data) return json({ error: "not_found" }, 404);
    // Hand the handbook over only when it's the next thing to sign.
    let handbook: unknown[] | undefined, ack: unknown | undefined;
    if (data.offer_body && data.offer_signed_at && !data.offer_declined_at && !data.handbook_signed_at) {
      handbook = await handbookArticles();
      ack = await handbookAck();
    }
    // The letter's "{signature}" line is the owner's countersignature. The PDF
    // already renders it for this same token holder, so hand the page the same
    // image rather than letting the placeholder show through as raw text.
    let owner_sig: string | undefined;
    if (data.offer_body && String(data.offer_body).includes("{signature}")) {
      const b = await ownerSigBytes();
      if (b) owner_sig = "data:image/png;base64," + b64FromBytes(b);
    }
    return json({ ok: true, intake: data, ...(owner_sig ? { owner_sig } : {}), ...(handbook ? { handbook, ack } : {}) });
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
      // Signing ends the offer stage. The new-hire stage arrives as its own
      // email carrying their signed copy — so nothing has to be printed,
      // signed on paper, or brought back to the store. Best-effort: an email
      // failure must never cost them a signature they already gave.
      await sendNewHireEmail({ ...it, offer_signature: sig, offer_signed_name: name, offer_signed_at: now })
        .catch(() => {});
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

  if (action === "handbook_pdf") {
    // The whole Employee Handbook as ONE file, assembled live from the KB's
    // handbook category (same source the candidate accordion signs) — any
    // signed-in staff.
    const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
    const u = auth ? await admin.auth.getUser(auth) : { data: null };
    if (!u.data?.user) return json({ error: "forbidden" }, 403);
    const arts = await handbookArticles();
    if (!arts.length) return json({ error: "no_handbook" }, 404);
    const ack = await handbookAck();
    const body = "# Employee Handbook\n"
      + (ack.version ? "Handbook Version: " + ack.version + "\n" : "")
      + "iRepair Phone Shop, LLC — CPR Cell Phone Repair, Oregon\n"
      + arts.map((a) => "\n{pagebreak}\n# "
          + String(a.title).replace(/^Handbook\s*[—-]\s*/, "")
          + "\n\n" + kbToPdfMarkup(String(a.body))).join("\n");
    const pdf = await buildOfferPdf({ body });
    return json({ ok: true, pdf: b64FromBytes(pdf), filename: "CPR Employee Handbook.pdf" });
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
      ack: it.handbook_signed_at ? await handbookAck() : null,
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
      suggested_pin: /^\d{4}$/.test(String(body.suggested_pin || "")) ? String(body.suggested_pin) : null,
      availability: Array.isArray(body.availability) ? (body.availability as unknown[]).slice(0, 7) : null,
      status: "submitted", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const { error } = await admin.from("staff_intake").update(patch).eq("id", row.id);
    if (error) return json({ error: error.message }, 500);
    const nm = [patch.legal_first, patch.legal_last].filter(Boolean).join(" ") || "A candidate";
    // Everything QuickBooks needs is on the table now, so create the employee.
    // Best-effort and stamped: a QBO outage must never cost a candidate their
    // finished paperwork, and the error is kept so it can be retried by hand.
    const qbo = await createQboEmployee({ ...row, ...patch });
    await alertMgr(row.invited_by, "New-hire form in — " + nm,
      nm + " finished their paperwork" + (row.offer_body ? " (offer + handbook signed)" : "")
      + (qbo.ok ? " — added to QuickBooks, ready to convert."
         : qbo.skipped ? " — ready to convert."
         : " — ready to convert. QuickBooks add failed: " + qbo.error));
    return json({ ok: true, qbo });
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
      + "When you're ready, open the link below to read it and either accept or decline. Accepting takes a signature on the page — no printing, and nothing to bring in:\n"
      + link + "\n\n"
      + "Once it's signed we'll email you the next steps.\n\n"
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
      start_date: /^\d{4}-\d{2}-\d{2}$/.test(String(body.start_date || "")) ? String(body.start_date) : null,
      // structured pay; `pay` above stays the rendered line the offer letter shows
      pay_type: ["hourly", "salary"].includes(String(body.pay_type)) ? String(body.pay_type) : null,
      pay_amount: Number(body.pay_amount) > 0 ? Number(body.pay_amount) : null,
      mrt_role: ["team_member", "admin"].includes(String(body.mrt_role)) ? String(body.mrt_role) : "team_member",
      authorized_stores: Array.isArray(body.authorized_stores)
        ? (body.authorized_stores as unknown[]).map(String).slice(0, 20) : null,
      commission: !!body.commission,
      commission_earns: body.commission && body.commission_earns
        ? {
          accessory: !!body.commission_earns.accessory,
          device: !!body.commission_earns.device,
          services: !!body.commission_earns.services,
        }
        : null,
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
  if (action === "archive_docs") {
    // Backfill: file (or re-file) a promoted hire's paperwork. Idempotent —
    // staff_documents is unique on (staff_id, kind, source).
    const intakeId = Number(body.intake_id);
    const { data: it } = intakeId
      ? await admin.from("staff_intake").select("*").eq("id", intakeId).maybeSingle()
      : await admin.from("staff_intake").select("*").eq("promoted_staff_id", Number(body.staff_id) || 0)
        .order("promoted_at", { ascending: false }).limit(1).maybeSingle();
    if (!it) return json({ error: "not_found" }, 404);
    const staffId = Number(body.staff_id) || Number(it.promoted_staff_id) || 0;
    if (!staffId) return json({ error: "not_promoted" }, 409);
    const docs = await archiveDocs(it, staffId, mgr);
    return json({ ok: true, ...docs });
  }
  if (action === "promote") {
    // copy the intake onto an existing staff row + staff_profiles, stamp the
    // link, and fire module auto-assign for the hire. staff_id required (the
    // staff row is created by the QB Time sync or Team Members first).
    // Doc gating lives in the UI (a paper-signed candidate can still be
    // converted) — but a declined offer is a hard no.
    const intakeId = Number(body.intake_id);
    let staffId = Number(body.staff_id) || 0;
    if (!intakeId) return json({ error: "intake_id required" }, 400);
    const { data: it } = await admin.from("staff_intake").select("*").eq("id", intakeId).maybeSingle();
    if (!it) return json({ error: "not_found" }, 404);
    if (it.offer_declined_at) return json({ error: "declined" }, 409);

    // No staff row yet? Build it. Everything needed was decided in the wizard
    // (role, home + authorized stores, wage type) or on the form (name, PIN),
    // so convert finishes the hire instead of handing back a half-made person.
    let pinNote: string | null = null;
    if (!staffId) {
      const nm = [it.legal_first, it.legal_last].filter(Boolean).join(" ").trim()
        || String(it.invited_name || "").trim();
      if (!nm) return json({ error: "no_name" }, 400);
      const pin = it.suggested_pin ? await pinFreeOrNull(String(it.suggested_pin)) : null;
      if (it.suggested_pin && !pin) pinNote = "their chosen PIN was already taken — set a new one";
      const { data: made, error: cerr } = await admin.from("staff").insert({
        display_name: nm,
        first_name: it.legal_first || null,
        last_name: it.legal_last || null,
        preferred_name: it.preferred_name || null,
        birthday: it.dob || null,
        role: ["team_member", "employee", "admin"].includes(String(it.mrt_role))
          ? (it.mrt_role === "employee" ? "team_member" : it.mrt_role) : "team_member",
        home_store: it.invited_store || null,
        authorized_stores: Array.isArray(it.authorized_stores) && it.authorized_stores.length
          ? it.authorized_stores : null,
        wage_type: it.pay_type === "salary" ? "salary" : "hourly",
        start_date: it.start_date || null,
        active: true,
        ...(pin ? { pin_hash: await hashPin(pin) } : {}),
      }).select("id").single();
      if (cerr) return json({ error: "staff_create_failed", detail: cerr.message }, 500);
      staffId = made.id;
      // the PIN has served its purpose; don't leave it sitting in plaintext
      await admin.from("staff_intake").update({ suggested_pin: null }).eq("id", intakeId);
    }
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
    // commission profile from the wizard's Pay step. earns_override is exactly
    // {accessory,device,services} (assets/commission-engine.js), so it carries
    // over as-is. Only written when the row doesn't already have a profile —
    // a roster row edited by hand on Team Members always wins.
    if (it.pay_type || it.commission) {
      const { data: existing } = await admin.from("commission_roster")
        .select("staff_id").eq("staff_id", staffId).maybeSingle();
      if (!existing) {
        const earns = it.commission
          ? (it.commission_earns || { accessory: true, device: true, services: true })
          : { accessory: false, device: false, services: false };
        await admin.from("commission_roster").insert({
          staff_id: staffId,
          commission_active: !!it.commission,
          earns_override: earns,
        });
      }
    }
    await admin.from("staff_intake").update({
      status: "promoted", promoted_staff_id: staffId, promoted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", intakeId);
    // file the signed paperwork onto the person before the intake row leaves
    // the board — this is the only moment it's guaranteed to still be visible
    const docs = await archiveDocs(it, staffId, mgr).catch(() => ({ filed: 0, errors: ["archive failed"] }));
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
    return json({ ok: true, assigned, staff_id: staffId, docs, ...(pinNote ? { note: pinNote } : {}) });
  }
  return json({ error: "unknown action" }, 400);
});
