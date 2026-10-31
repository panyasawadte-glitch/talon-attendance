import { createClient } from "npm:@supabase/supabase-js@2";

const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "";
const db = createClient(Deno.env.get("SUPABASE_URL")!, KEY, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const enc = new TextEncoder();
const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (d: string | Uint8Array) =>
  toHex(await crypto.subtle.digest("SHA-256", typeof d === "string" ? enc.encode(d) : d));
async function hmac(msg: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
function dist(a1: number, o1: number, a2: number, o2: number) {
  const r = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(r(a2 - a1) / 2) ** 2 + Math.cos(r(a1)) * Math.cos(r(a2)) * Math.sin(r(o2 - o1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
function ham(a: string, b: string) {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { n += x & 1; x >>= 1; }
  }
  return n;
}

const GESTURES = [
  "ชู 1 นิ้ว", "ชู 2 นิ้ว", "ชู 3 นิ้ว", "ชู 4 นิ้ว", "ยกนิ้วโป้ง",
  "ชี้ไปที่โลโก้ร้าน", "แตะโลโก้ร้านด้วยมือ", "โบกมือ", "ทำมือรูปตัว V", "วางมือบนเคาน์เตอร์",
];

async function makeChallenge() {
  const i = Math.floor(Math.random() * GESTURES.length);
  const payload = btoa(JSON.stringify({ i, n: crypto.randomUUID(), e: Date.now() + 3 * 60 * 1000 }));
  return { token: payload + "." + (await hmac(payload)), prompt: GESTURES[i] };
}
async function readChallenge(t: string) {
  const [p, s] = String(t || "").split(".");
  if (!p || !s || s !== (await hmac(p))) return null;
  const d = JSON.parse(atob(p));
  return Date.now() > d.e ? null : d;
}

async function info() {
  const [b, e] = await Promise.all([
    db.from("branches").select("id,name").eq("active", true).order("id"),
    db.from("employees").select("id,name").eq("active", true).order("name"),
  ]);
  return { branches: b.data ?? [], employees: e.data ?? [] };
}

async function checkin(b: any) {
  const eid = Number(b.employee_id);
  const act = b.act;
  const { data: emp } = await db.from("employees").select("*").eq("id", eid).eq("active", true).maybeSingle();
  if (!emp || !emp.pin_hash || emp.pin_hash !== (await sha256(KEY + ":" + eid + ":" + String(b.pin))))
    return { ok: false, message: "ชื่อหรือรหัส PIN ไม่ถูกต้อง" };
  if (act !== "in" && act !== "out") return { ok: false, message: "คำสั่งไม่ถูกต้อง" };

  const ch = await readChallenge(b.challenge);
  if (!ch) return { ok: false, message: "รหัสท่าทางหมดอายุ กรุณากดเริ่มใหม่" };
  const used = await db.from("attendance").select("id", { count: "exact", head: true }).eq("challenge", b.challenge);
  if (used.count) return { ok: false, message: "รหัสนี้ถูกใช้แล้ว กรุณากดเริ่มใหม่" };

  const lat = Number(b.lat), lng = Number(b.lng), acc = Number(b.accuracy);
  if (!isFinite(lat) || !isFinite(lng)) return { ok: false, message: "ไม่พบตำแหน่ง GPS กรุณาเปิดตำแหน่งแล้วลองใหม่" };
  if (!(acc > 0) || acc > 1500) return { ok: false, message: "สัญญาณ GPS ยังไม่แม่นพอ ลองขยับไปที่โล่งแล้วถ่ายใหม่" };

  const { data: brs } = await db.from("branches").select("*").eq("active", true).not("lat", "is", null);
  let best: any = null, bd = Infinity;
  for (const x of brs ?? []) {
    const d = dist(lat, lng, x.lat, x.lng);
    if (d < bd) { bd = d; best = x; }
  }
  if (!best) return { ok: false, message: "ยังไม่มีพิกัดสาขาในระบบ" };
  if (bd - Math.min(acc, 1000) > best.radius_m) {
    await db.from("attendance").insert({
      employee_id: eid, branch_id: best.id, action: act, lat, lng, accuracy_m: acc,
      device_id: b.device_id, flags: ["outside_branch"], status: "rejected", note: `ห่างสาขา ${Math.round(bd)} ม.`,
    });
    return { ok: false, message: "คุณอยู่นอกพื้นที่สาขา ระบบไม่บันทึกเวลา" };
  }

  const [head, data] = String(b.photo || "").split(",");
  if (!head?.startsWith("data:image/jpeg") || !data) return { ok: false, message: "ไม่พบรูปถ่าย" };
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  if (bytes.length > 1_500_000) return { ok: false, message: "รูปใหญ่เกินไป ลองใหม่" };
  const exact = (await sha256(bytes)).slice(0, 16);
  const dh = String(b.dhash || "").toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(dh)) return { ok: false, message: "ข้อมูลรูปไม่ครบ ลองใหม่" };

  const flags: string[] = [];
  if (acc > 50) flags.push("gps_low_accuracy");
  if (bd > best.radius_m) flags.push("outside_branch");
  if (emp.device_id && emp.device_id !== b.device_id) flags.push("device_changed");

  const { data: prev } = await db.from("attendance").select("action,server_time,branch_id")
    .eq("employee_id", eid).neq("status", "rejected").order("server_time", { ascending: false }).limit(1).maybeSingle();
  if (act === "in" && prev?.action === "in") flags.push("missed_checkout");
  if (act === "out" && (!prev || prev.action === "out")) flags.push("out_without_in");
  if (prev && prev.branch_id !== best.id) {
    const pb = (brs ?? []).find((x: any) => x.id === prev.branch_id);
    if (pb) {
      const km = dist(pb.lat, pb.lng, best.lat, best.lng) / 1000;
      const hrs = Math.max((Date.now() - new Date(prev.server_time).getTime()) / 3600000, 0.01);
      if (km > 2 && km / hrs > 100) flags.push("impossible_travel");
    }
  }

  const since = new Date(Date.now() - 60 * 864e5).toISOString();
  const { data: old } = await db.from("attendance").select("photo_hash")
    .eq("employee_id", eid).gte("server_time", since).not("photo_hash", "is", null);
  for (const o of old ?? []) {
    const [odh, oex] = String(o.photo_hash).split(":");
    if (oex === exact) { flags.push("photo_exact_duplicate"); break; }
    if (ham(odh, dh) <= 5) { flags.push("photo_similar"); break; }
  }

  const path = `${eid}/${new Date().toISOString().replace(/[:.]/g, "-")}_${exact.slice(0, 6)}.jpg`;
  const up = await db.storage.from("selfies").upload(path, bytes, { contentType: "image/jpeg" });
  if (up.error) return { ok: false, message: "อัปโหลดรูปไม่สำเร็จ ลองใหม่" };

  const ins = await db.from("attendance").insert({
    employee_id: eid, branch_id: best.id, action: act, lat, lng, accuracy_m: acc,
    challenge: b.challenge, photo_path: path, photo_hash: dh + ":" + exact,
    device_id: b.device_id, flags, status: flags.length ? "flagged" : "ok",
  }).select("server_time").single();
  if (ins.error) return { ok: false, message: "บันทึกไม่สำเร็จ ลองใหม่" };

  if (!emp.device_id) await db.from("employees").update({ device_id: b.device_id }).eq("id", eid);
  return {
    ok: true, time: ins.data.server_time,
    message: `${emp.name} ${act === "in" ? "เข้างาน" : "ออกงาน"}ที่ ${best.name} สำเร็จ`,
  };
}

async function admin(b: any) {
  if (!ADMIN_PASSWORD || b.password !== ADMIN_PASSWORD) {
    await new Promise((r) => setTimeout(r, 1000));
    return { ok: false, error: "รหัสผู้ดูแลไม่ถูกต้อง" };
  }
  const dateOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
  switch (b.action) {
    case "admin_login":
      return { ok: true };

    case "admin_records": {
      if (!dateOk(b.from) || !dateOk(b.to)) return { ok: false, error: "วันที่ไม่ถูกต้อง" };
      let q = db.from("attendance")
        .select("id,action,server_time,lat,lng,accuracy_m,challenge,photo_path,flags,status,note,employees(name),branches(name)")
        .gte("server_time", `${b.from}T00:00:00+07:00`).lte("server_time", `${b.to}T23:59:59+07:00`)
        .order("server_time", { ascending: false }).limit(500);
      if (b.only_flagged) q = q.in("status", ["flagged", "rejected"]);
      const { data, error } = await q;
      if (error) return { ok: false, error: error.message };
      const paths = (data ?? []).map((r: any) => r.photo_path).filter(Boolean);
      const urls: Record<string, string> = {};
      if (paths.length) {
        const s = await db.storage.from("selfies").createSignedUrls(paths, 3600);
        for (const u of s.data ?? []) if (u.path && u.signedUrl) urls[u.path] = u.signedUrl;
      }
      const rows = (data ?? []).map((r: any) => {
        let prompt = "";
        try { prompt = GESTURES[JSON.parse(atob(String(r.challenge).split(".")[0])).i] ?? ""; } catch (_) { /* ไม่มีท่า */ }
        return { ...r, photo_url: urls[r.photo_path] ?? null, prompt };
      });
      return { ok: true, rows };
    }

    case "admin_review": {
      if (!["approved", "rejected"].includes(b.status)) return { ok: false, error: "สถานะไม่ถูกต้อง" };
      const r = await db.from("attendance").update({ status: b.status, note: b.note ?? null }).eq("id", Number(b.id));
      return r.error ? { ok: false, error: r.error.message } : { ok: true };
    }

    case "admin_lists": {
      const [e, br] = await Promise.all([
        db.from("employees").select("id,name,type,active,pin_hash").order("id"),
        db.from("branches").select("*").order("id"),
      ]);
      return {
        ok: true,
        employees: (e.data ?? []).map((x: any) => ({ id: x.id, name: x.name, type: x.type, active: x.active, has_pin: !!x.pin_hash })),
        branches: br.data ?? [],
      };
    }

    case "admin_save_employee": {
      const row: any = { name: String(b.name).trim(), type: b.type === "floater" ? "floater" : "regular", active: b.active !== false };
      let id = b.id ? Number(b.id) : 0;
      if (id) {
        const r = await db.from("employees").update(row).eq("id", id);
        if (r.error) return { ok: false, error: r.error.message };
      } else {
        const r = await db.from("employees").insert(row).select("id").single();
        if (r.error) return { ok: false, error: r.error.message };
        id = r.data.id;
      }
      if (b.pin) {
        if (!/^\d{4,6}$/.test(String(b.pin))) return { ok: false, error: "PIN ต้องเป็นตัวเลข 4-6 หลัก" };
        await db.from("employees").update({ pin_hash: await sha256(KEY + ":" + id + ":" + String(b.pin)), device_id: null }).eq("id", id);
      }
      return { ok: true, id };
    }

    case "admin_save_branch": {
      const num = (v: any) => (v === "" || v == null ? null : Number(v));
      const row: any = { name: String(b.name).trim(), lat: num(b.lat), lng: num(b.lng), radius_m: Number(b.radius_m) || 150, active: b.active !== false };
      const r = b.id ? await db.from("branches").update(row).eq("id", Number(b.id)) : await db.from("branches").insert(row);
      return r.error ? { ok: false, error: r.error.message } : { ok: true };
    }

    case "admin_manual": {
      const r = await db.from("attendance").insert({
        employee_id: Number(b.employee_id), branch_id: Number(b.branch_id), action: b.act === "out" ? "out" : "in",
        server_time: new Date(b.time).toISOString(), flags: ["manual"], status: "approved", note: b.note ?? "เพิ่มโดยผู้ดูแล",
      });
      return r.error ? { ok: false, error: r.error.message } : { ok: true };
    }

    case "admin_report": {
      if (!dateOk(b.from) || !dateOk(b.to)) return { ok: false, error: "วันที่ไม่ถูกต้อง" };
      const r = await db.from("payroll_report").select("*").gte("work_date", b.from).lte("work_date", b.to)
        .order("employee").order("work_date");
      return r.error ? { ok: false, error: r.error.message } : { ok: true, rows: r.data };
    }
  }
  return { ok: false, error: "unknown admin action" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json();
    if (b.action === "info") return json(await info());
    if (b.action === "challenge") return json(await makeChallenge());
    if (b.action === "checkin") return json(await checkin(b));
    if (String(b.action).startsWith("admin_")) return json(await admin(b));
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
