import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import bcrypt from "npm:bcryptjs@3.0.3";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const REFRESH_TTL_REMEMBER = 30 * 24 * 60 * 60;
const REFRESH_TTL_SESSION = 24 * 60 * 60;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyPassword(password: string, storedHash: string) {
  if (storedHash.startsWith("$2")) {
    return { ok: await bcrypt.compare(password, storedHash), upgrade: false };
  }
  if (/^[0-9a-f]{64}$/i.test(storedHash)) {
    const candidate = await sha256Hex(password);
    let mismatch = candidate.length ^ storedHash.length;
    for (let i = 0; i < Math.min(candidate.length, storedHash.length); i += 1) {
      mismatch |= candidate.charCodeAt(i) ^ storedHash.charCodeAt(i);
    }
    return { ok: mismatch === 0, upgrade: mismatch === 0 };
  }
  return { ok: false, upgrade: false };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const presentedKey = (req.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!serviceKey || !presentedKey || presentedKey !== serviceKey) {
    return json({ error: "unauthorized" }, 401);
  }

  try {
    const body = await req.json().catch(() => null);
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const refreshHash = typeof body?.refresh_token_hash === "string"
      ? body.refresh_token_hash
      : "";
    const remember = body?.remember !== false;
    if (!username || !password || !/^[0-9a-f]{64}$/i.test(refreshHash)) {
      return json({ error: "invalid_request" }, 400);
    }

    const db = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await db
      .from("panel_users")
      .select("id,username,email,display_name,role,active,account_status,frozen_until,locked_until,failed_login_count,password_hash")
      .limit(200);
    if (error) throw error;

    const normalized = username.toLocaleLowerCase("en-US");
    const matches = (data ?? []).filter((candidate) =>
      String(candidate.username).toLocaleLowerCase("en-US") === normalized ||
      (candidate.email != null &&
        String(candidate.email).toLocaleLowerCase("en-US") === normalized)
    );
    const user = matches.length === 1 ? matches[0] : null;
    const now = new Date();

    if (
      user?.account_status === "frozen" && user.frozen_until &&
      new Date(user.frozen_until).getTime() <= now.getTime()
    ) {
      await db.from("panel_users").update({
        active: true,
        account_status: "active",
        frozen_until: null,
        status_reason: null,
      }).eq("id", user.id);
      user.active = true;
      user.account_status = "active";
      user.frozen_until = null;
    }

    if (!user || !user.active || (user.account_status && user.account_status !== "active")) {
      return json({ error: "invalid_credentials" }, 401);
    }
    if (user.locked_until && new Date(user.locked_until).getTime() > now.getTime()) {
      return json({ error: "locked", until: user.locked_until }, 423);
    }

    const verified = await verifyPassword(password, String(user.password_hash));
    if (!verified.ok) {
      const failed = Number(user.failed_login_count ?? 0) + 1;
      await db.from("panel_users").update({
        failed_login_count: failed,
        locked_until: failed >= MAX_FAILED
          ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString()
          : null,
      }).eq("id", user.id);
      return json({ error: "invalid_credentials" }, 401);
    }

    const updates: Record<string, unknown> = {
      failed_login_count: 0,
      locked_until: null,
      last_login_at: now.toISOString(),
    };
    if (verified.upgrade) updates.password_hash = await bcrypt.hash(password, 12);
    const ttl = remember ? REFRESH_TTL_REMEMBER : REFRESH_TTL_SESSION;
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();

    const [{ error: updateError }, { error: refreshError }] = await Promise.all([
      db.from("panel_users").update(updates).eq("id", user.id),
      db.from("panel_refresh_tokens").insert({
        user_id: user.id,
        token_hash: refreshHash.toLowerCase(),
        expires_at: expiresAt,
        remember,
      }),
    ]);
    if (updateError) throw updateError;
    if (refreshError) throw refreshError;

    return json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("panel-login-fallback failed", error);
    return json({ error: "auth_unavailable" }, 503);
  }
});
