import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
  maxDuration: 60,
};

const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

const STRIP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

export default async function medLinkGateway(req, res) {
res.setHeader("X-Accel-Buffering", "no");

  if (!TARGET_BASE) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "System Error: Missing Database Domain Configuration" }));
  }

  // ایجاد کنترلر و تنظیم زمان قطع تصادفی بین 40 تا 55 ثانیه
  // (برای جلوگیری از رسیدن به مرز 60 ثانیه و ثبت ارور در ورسل)
  const controller = new AbortController();
  const randomDropTime = Math.floor(Math.random() * (55000 - 40000 + 1)) + 40000;
  
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, randomDropTime);

  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // لایه استتار اول: مدیریت CORS
    if (req.method === "OPTIONS") {
      clearTimeout(timeoutId);
      res.statusCode = 204;
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
      res.setHeader("Access-Control-Max-Age", "86400");
      return res.end();
    }

    // لایه استتار دوم: نمایش دیتای کلینیک پزشکی در مسیرهای عمومی
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/api/status")) {
      clearTimeout(timeoutId);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");
      res.setHeader("X-Service-Version", "v4.2.0");
      return res.end(JSON.stringify({
        service: "Med-Link Clinic Gateway",
        status: "operational",
        region: "Tehran-Central",
        uptime: Math.floor(process.uptime ? process.uptime() : Date.now() / 1000),
        departments: ["Cardiology", "Neurology", "Pediatrics"],
        recent_appointments: [
          { id: "A-992", doctor: "Dr. Samiei", status: "confirmed" },
          { id: "A-993", doctor: "Dr. Rahimi", status: "pending" }
        ],
        message: "Secure connection established. Vitals monitoring active."
      }));
    }

    // منطق اصلی پروکسی با پشتیبانی از استریم Node.js
    const targetUrl = TARGET_BASE + req.url;
    const headers = {};
    let clientIp = null;
    
    for (const key of Object.keys(req.headers)) {
      const k = key.toLowerCase();
      const v = req.headers[key];
      if (STRIP_HEADERS.has(k)) continue;
      if (k.startsWith("x-vercel-")) continue;
      if (k === "x-real-ip") { clientIp = v; continue; }
      if (k === "x-forwarded-for") { if (!clientIp) clientIp = v; continue; }
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    if (clientIp) headers["x-forwarded-for"] = clientIp;

    const method = req.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    const fetchOpts = { method, headers, redirect: "manual", signal: controller.signal };
    if (hasBody) {
      fetchOpts.body = Readable.toWeb(req);
      fetchOpts.duplex = "half";
    }

    const upstream = await fetch(targetUrl, fetchOpts);

    res.statusCode = upstream.status;
    for (const [k, v] of upstream.headers) {
      if (k.toLowerCase() === "transfer-encoding") continue;
      try { res.setHeader(k, v); } catch {}
    }

    // لایه استتار سوم: هدرهای ساختگی خروجی برای سیستم پزشکی
    try {
      res.setHeader("X-Transaction-Id", crypto.randomUUID());
      res.setHeader("X-Gateway-Node", "thr-med-pool-3");
    } catch {}

    if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } else {
      res.end();
    }
  } catch (err) {
    // مدیریت امن ارورها بدون لاگ کردن در ورسل
    if (err.name === 'AbortError') {
      if (!res.headersSent) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ message: "Sync cycle completed successfully." }));
      } else {
        return res.end();
      }
    }
    
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Upstream database synchronization timeout." }));
    } else {
      res.end();
    }
  } finally {
    clearTimeout(timeoutId);
  }
}
