// Admin-only profile management. List, create and delete profiles; each carries
// its own my-list / ratings / progress / recommendations (see reco/engine.ts).
import { getRequestUser, listUsers, createUser, deleteUser, setUserPassword, updateProfile, createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/server/auth";
import { json, noStore, checkCsrf, readJsonBody } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A handful of short profile fields — anything past a few KiB is abuse.
const MAX_USERS_BODY_BYTES = 4 * 1024;

export async function GET(request: Request) {
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });
  if (user.is_admin !== 1) return json({ error: "Réservé à l'administrateur" }, { status: 403 });
  return json({
    users: listUsers().map((u) => ({
      id: u.id,
      username: u.username,
      isAdmin: u.is_admin === 1,
      isKids: u.is_kids === 1,
      avatar: u.avatar,
      createdAt: u.created_at,
    })),
    me: user.id,
  });
}

export async function POST(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });
  if (user.is_admin !== 1) return json({ error: "Réservé à l'administrateur" }, { status: 403 });

  const parsed = await readJsonBody<{ username?: string; password?: string; isAdmin?: boolean; isKids?: boolean; avatar?: string }>(request, MAX_USERS_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const result = createUser(body.username ?? "", body.password ?? "", {
    isAdmin: Boolean(body.isAdmin),
    isKids: Boolean(body.isKids),
    avatar: body.avatar,
  });
  if (!result.ok) return json({ error: result.error }, { status: 400 });
  return json({ ok: true, id: result.id });
}

export async function PUT(request: Request) {
  // Admin password reset for another profile, or profile-detail edits (avatar/kids).
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });
  if (user.is_admin !== 1) return json({ error: "Réservé à l'administrateur" }, { status: 403 });

  const parsed = await readJsonBody<{ id?: number; password?: string; avatar?: string; isKids?: boolean }>(request, MAX_USERS_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (typeof body.id !== "number") return json({ error: "id required" }, { status: 400 });

  if (body.avatar !== undefined || body.isKids !== undefined) {
    const result = updateProfile(body.id, { avatar: body.avatar, isKids: body.isKids });
    if (!result.ok) return json({ error: result.error }, { status: 400 });
  }
  if (body.password !== undefined) {
    const result = setUserPassword(body.id, body.password ?? "");
    if (!result.ok) return json({ error: result.error }, { status: 400 });

    // setUserPassword bumped token_version, invalidating every token for that user.
    // If the admin reset their OWN password here, re-issue this session so they
    // aren't silently logged out. Cookie clients update transparently; token
    // clients adopt the returned `token` — token in the body, so no-store.
    if (body.id === user.id) {
      const token = createSessionToken(user.id);
      const res = noStore(json({ ok: true, token }));
      res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(request));
      return res;
    }
  }
  return json({ ok: true });
}

export async function DELETE(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const user = getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });
  if (user.is_admin !== 1) return json({ error: "Réservé à l'administrateur" }, { status: 403 });

  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id)) return json({ error: "id required" }, { status: 400 });
  if (id === user.id) return json({ error: "Vous ne pouvez pas supprimer votre propre profil" }, { status: 400 });
  const result = deleteUser(id);
  if (!result.ok) return json({ error: result.error }, { status: 400 });
  return json({ ok: true });
}
