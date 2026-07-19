/**
 * Boonthavorn Booking Dashboard — server
 *
 * Data sources (auto-detected):
 *  - CALENDLY_TOKEN set  -> polls Calendly API (works on FREE plan, no webhook needed)
 *  - CALENDLY_TOKEN unset -> mock mode (demo data relative to current time)
 *
 * Views:
 *  - /            admin view (all branches)
 *  - /b/<branch>  branch view, filtered (e.g. /b/เกษตร matches "สาขาเกษตร-นวมินทร์")
 *
 * Real-time to browser: Server-Sent Events (/api/stream) + polling fallback.
 * Webhook endpoint (/webhook/calendly) is ready for paid plans.
 */
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = (process.env.CALENDLY_TOKEN || "").trim();
const POLL_SECONDS = Math.max(20, parseInt(process.env.POLL_SECONDS || "45", 10));
const PASSWORD = (process.env.DASHBOARD_PASSWORD || "").trim();
const TZ_OFFSET_MIN = 7 * 60; // Asia/Bangkok (+07:00)
const LOGO_URL =
  process.env.LOGO_URL ||
  "https://www.boonthavorn.com/media/logo/websites/1/btv-logo-2X.png";
const DAYS_AHEAD = Math.min(30, Math.max(0, parseInt(process.env.DAYS_AHEAD || "7", 10)));

// English URL slug -> exact option text in the Calendly form dropdown
const BRANCH_SLUGS = {
  "ratchada": "บุญถาวร สาขารัชดา (Boonthavorn Ratchada)",
  "kaset-nawamin": "บุญถาวร สาขาเกษตร-นวมินทร์ (Boonthavorn Kaset Nawamin)",
  "bangna": "บุญถาวร สาขาบางนา (Boonthavorn Bangna)",
  "ratchapruek": "บุญถาวร สาขาราชพฤกษ์ (Boonthavorn Ratchapruek)",
  "phuttamonthon": "บุญถาวร สาขาพุธมณฑล (Boonthavorn Phuttamonthon)",
  "rangsit": "บุญถาวร สาขารังสิต (Boonthavorn Rangsit)",
  "rama2": "บุญถาวร สาขาพระราม 2 (Boonthavorn Rama 2)",
  "pattaya": "บุญถาวร สาขาพัทยา (Boonthavorn Pattaya)",
  "huahin": "บุญถาร สาขาหัวหิน (Boonthavorn Huahin)",
  "korat": "บุญถาวร สาขาโคราช (Boonthavorn Korat)",
  "udonthani": "บุญถาวร สาขาอุดรธานี (Boonthavorn Udonthani)",
  "chiangmai": "บุญถาวร สาขาเชียงใหม่ (Boonthavorn Chiangmai)",
  "phitsanulok": "บุญถาวร สาขาพิษณุโลก (Boonthavorn Phitsanulok)",
  "suratthani": "บุญถาวร สาขาสุราษฎร์ธานี (Boonthavorn Suratthani)",
};

// ---------- optional basic auth ----------
app.use((req, res, next) => {
  if (!PASSWORD || req.path === "/webhook/calendly") return next();
  const hdr = req.headers.authorization || "";
  const [scheme, b64] = hdr.split(" ");
  if (scheme === "Basic" && b64) {
    const pass = Buffer.from(b64, "base64").toString().split(":").slice(1).join(":");
    if (pass === PASSWORD) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="dashboard"');
  return res.status(401).send("Authentication required");
});

// ---------- pages & logo ----------
app.get(["/", "/b/:branch"], (req, res) =>
  res.sendFile(path.join(__dirname, "index.html"))
);

let logoCache = null;
app.get("/logo.png", (req, res) => {
  res.sendFile(path.join(__dirname, "logo.png"), async (err) => {
    if (!err) return; // served local override
    try {
      if (!logoCache) {
        const r = await fetch(LOGO_URL);
        if (!r.ok) throw new Error("logo fetch " + r.status);
        logoCache = Buffer.from(await r.arrayBuffer());
      }
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "public, max-age=86400");
      res.send(logoCache);
    } catch (e) {
      if (!res.headersSent) res.status(404).end();
    }
  });
});

// ---------- state ----------
let cache = {
  source: TOKEN ? "calendly" : "mock",
  updatedAt: null,
  error: null,
  branches: BRANCH_SLUGS,
  bookings: [],
};
let lastHash = "";
const sseClients = new Set();
const inviteeCache = new Map(); // event uri -> invitee info

// ---------- helpers ----------
function bangkokDayRange() {
  // from today 00:00 (Bangkok) up to DAYS_AHEAD days into the future
  const nowBkk = new Date(Date.now() + TZ_OFFSET_MIN * 60000);
  const start = new Date(
    Date.UTC(nowBkk.getUTCFullYear(), nowBkk.getUTCMonth(), nowBkk.getUTCDate()) -
      TZ_OFFSET_MIN * 60000
  );
  const end = new Date(start.getTime() + (1 + DAYS_AHEAD) * 24 * 3600 * 1000);
  return { start, end };
}

async function cly(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`Calendly ${r.status} ${url.split("?")[0]}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const VIDEO_TYPES = new Set([
  "google_conference", "zoom", "zoom_conference", "gotomeeting",
  "microsoft_teams_conference", "webex_conference", "custom_conference",
]);

function normalizeLocation(loc) {
  if (!loc) return { type: "branch", detail: "", joinUrl: "" };
  if (VIDEO_TYPES.has(loc.type)) {
    return { type: "video", detail: "Video call", joinUrl: loc.join_url || "" };
  }
  return { type: "branch", detail: loc.location || loc.type || "", joinUrl: "" };
}

// Map Calendly custom-question answers to fields by keywords in the question text
function parseAnswers(qas) {
  const out = { phone: "", branch: "", detail: "" };
  for (const q of qas || []) {
    const question = (q.question || "").toLowerCase();
    const answer = (q.answer || "").trim();
    if (!answer) continue;
    if (!out.phone && /(phone|เบอร์|โทร)/i.test(question)) out.phone = answer;
    else if (!out.branch && /(branch|สาขา)/i.test(question)) out.branch = answer;
    else if (!out.detail && /(detail|รายละเอียด|เพิ่มเติม|note|หัวข้อ|เรื่อง)/i.test(question)) out.detail = answer;
  }
  return out;
}

async function listScheduledEvents(scopeParam, status, range) {
  const out = [];
  let url =
    `https://api.calendly.com/scheduled_events?${scopeParam}` +
    `&min_start_time=${encodeURIComponent(range.start.toISOString())}` +
    `&max_start_time=${encodeURIComponent(range.end.toISOString())}` +
    `&status=${status}&count=100`;
  while (url) {
    const j = await cly(url);
    out.push(...j.collection);
    url = (j.pagination && j.pagination.next_page) || null;
  }
  return out;
}

async function inviteeOf(eventUri) {
  if (inviteeCache.has(eventUri)) return inviteeCache.get(eventUri);
  let info = { name: "-", email: "", phone: "", branch: "", detail: "", lineUserId: "" };
  try {
    const j = await cly(`${eventUri}/invitees?count=1`);
    const inv = j.collection[0];
    if (inv) {
      const ans = parseAnswers(inv.questions_and_answers);
      info = {
        name: inv.name || "-",
        email: inv.email || "",
        phone: ans.phone || inv.text_reminder_number || "",
        branch: ans.branch,
        detail: ans.detail,
        lineUserId: (inv.tracking && inv.tracking.utm_content) || "",
      };
    }
  } catch (e) {
    console.error("invitee fetch failed:", e.message);
  }
  inviteeCache.set(eventUri, info);
  if (inviteeCache.size > 500) inviteeCache.delete(inviteeCache.keys().next().value);
  return info;
}

async function fetchCalendly() {
  const me = await cly("https://api.calendly.com/users/me");
  const range = bangkokDayRange();
  let events = [];
  const scopes = [
    `organization=${encodeURIComponent(me.resource.current_organization)}`,
    `user=${encodeURIComponent(me.resource.uri)}`,
  ];
  for (const scope of scopes) {
    try {
      const [active, canceled] = await Promise.all([
        listScheduledEvents(scope, "active", range),
        listScheduledEvents(scope, "canceled", range),
      ]);
      events = [...active, ...canceled];
      break;
    } catch (e) {
      if (scope === scopes[scopes.length - 1]) throw e;
    }
  }

  const bookings = [];
  for (const ev of events) {
    const loc = normalizeLocation(ev.location);
    const inv = await inviteeOf(ev.uri);
    const host = (ev.event_memberships && ev.event_memberships[0]) || {};
    bookings.push({
      id: ev.uri.split("/").pop(),
      title: ev.name || "",
      start: ev.start_time,
      end: ev.end_time,
      status: ev.status, // active | canceled
      type: loc.type, // branch | video
      locationDetail: loc.detail,
      joinUrl: loc.joinUrl,
      staff: host.user_name || "-",
      customer: inv.name,
      email: inv.email,
      phone: inv.phone,
      branch: inv.branch || (loc.type === "branch" ? loc.detail : ""),
      detail: inv.detail,
      lineUserId: inv.lineUserId ? "linked" : "",
    });
  }
  bookings.sort((a, b) => new Date(a.start) - new Date(b.start));
  return bookings;
}

function mockBookings() {
  const at = (min, dur) => {
    const s = new Date(Date.now() + min * 60000);
    return { start: s.toISOString(), end: new Date(s.getTime() + dur * 60000).toISOString() };
  };
  const B = BRANCH_SLUGS;
  const rows = [
    [-150, 45, "คุณสมชาย วงศ์สุวรรณ", "somchai@gmail.com", "081-234-5678", "branch", B["kaset-nawamin"], "ดูกระเบื้องห้องน้ำ", "active"],
    [-90, 30, "คุณอรทัย ศรีบุญ", "orathai@gmail.com", "089-876-5432", "video", "", "ปรึกษาออกแบบห้องครัว", "active"],
    [-20, 45, "คุณพิมพ์ชนก ตั้งใจ", "pim@gmail.com", "086-111-2233", "branch", B["ratchada"], "เลือกสุขภัณฑ์", "active"],
    [35, 30, "คุณวีระ จันทร์เพ็ญ", "weera@gmail.com", "082-555-6677", "video", "", "สอบถามโปรโมชัน", "active"],
    [75, 45, "คุณมะลิ ทองดี", "mali@gmail.com", "084-999-0011", "branch", B["kaset-nawamin"], "งบ 2 แสน รีโนเวทบ้าน", "active"],
    [120, 30, "คุณกิตติ พูนสุข", "kitti@gmail.com", "087-333-4455", "video", "", "", "canceled"],
    [180, 45, "คุณนภา แก้วใส", "napa@gmail.com", "085-777-8899", "branch", B["ratchapruek"], "ดูโคมไฟ", "active"],
    [1500, 45, "คุณเอก บุญมาก", "ake@gmail.com", "081-000-1122", "branch", B["rangsit"], "ดูห้องครัวชุดใหญ่", "active"],
    [1620, 30, "คุณฝน ใจเย็น", "fon@gmail.com", "090-222-3344", "video", "", "ปรึกษางบรีโนเวท", "active"],
  ];
  return rows.map(([min, dur, name, email, phone, type, branch, detail, status], i) => ({
    id: "mock-" + i,
    title: type === "video" ? "ปรึกษาออนไลน์ (video call)" : "นัดหมายที่สาขา",
    ...at(min, dur),
    status,
    type,
    locationDetail: branch || "Video call",
    joinUrl: type === "video" ? "https://meet.google.com/mock-demo" : "",
    staff: ["คุณนก", "คุณเบียร์", "คุณแพร"][i % 3],
    customer: name,
    email,
    phone,
    branch,
    detail,
    lineUserId: "linked",
  }));
}

async function refresh(reason) {
  try {
    const bookings = TOKEN ? await fetchCalendly() : mockBookings();
    cache = { source: TOKEN ? "calendly" : "mock", updatedAt: new Date().toISOString(), error: null, branches: BRANCH_SLUGS, bookings };
  } catch (e) {
    console.error(`refresh failed (${reason}):`, e.message);
    cache = { ...cache, updatedAt: new Date().toISOString(), error: e.message };
  }
  const hash = crypto.createHash("md5").update(JSON.stringify(cache.bookings) + cache.error).digest("hex");
  if (hash !== lastHash) {
    lastHash = hash;
    const payload = `data: ${JSON.stringify(cache)}\n\n`;
    for (const res of sseClients) res.write(payload);
  }
}

// ---------- API ----------
app.get("/api/bookings", (req, res) => res.json(cache));

app.get("/api/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(cache)}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
});

// Ready for paid-plan webhooks: instant refresh when someone books/cancels
app.post("/webhook/calendly", (req, res) => {
  res.status(200).json({ ok: true });
  refresh("webhook");
});

app.get("/healthz", (req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`Dashboard on :${PORT} | source=${cache.source} | poll=${POLL_SECONDS}s | auth=${PASSWORD ? "on" : "off"}`);
  refresh("startup");
  setInterval(() => refresh("poll"), POLL_SECONDS * 1000);
});
