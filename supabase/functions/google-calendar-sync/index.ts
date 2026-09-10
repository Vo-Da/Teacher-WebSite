import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const googleCalendarScope = "https://www.googleapis.com/auth/calendar.app.created";

function corsHeaders(request: Request) {
  const configuredOrigin = Deno.env.get("APP_ORIGIN");
  const requestOrigin = request.headers.get("Origin");
  const allowedOrigin = configuredOrigin && requestOrigin === configuredOrigin ? configuredOrigin : configuredOrigin || "*";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin"
  };
}

function response(request: Request, body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" }
  });
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function base64(bytes: Uint8Array) {
  let output = "";
  bytes.forEach((byte) => { output += String.fromCharCode(byte); });
  return btoa(output);
}

function fromBase64(value: string) {
  const output = atob(value);
  return Uint8Array.from(output, (character) => character.charCodeAt(0));
}

async function encryptionKey() {
  const secret = text(Deno.env.get("GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY"));
  if (secret.length < 32) throw new Error("Google Calendar encryption is not configured");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptRefreshToken(token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey();
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(token));
  return { ciphertext: base64(new Uint8Array(ciphertext)), iv: base64(iv) };
}

async function decryptRefreshToken(ciphertext: string, iv: string) {
  const key = await encryptionKey();
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, key, fromBase64(ciphertext));
  return decoder.decode(plaintext);
}

function appOrigin() {
  return text(Deno.env.get("APP_ORIGIN")) || "https://teacher-web-site.vercel.app";
}

function callbackUri(supabaseUrl: string) {
  return `${supabaseUrl}/functions/v1/google-calendar-sync`;
}

function htmlPage(title: string, message: string, retry = false) {
  const action = retry ? '<p><a href="https://teacher-web-site.vercel.app/">Повернутися до School Portal</a></p>' : "";
  return `<!doctype html><html lang="uk"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:Arial,sans-serif;background:#f2f5f7;color:#1b2430;padding:48px"><main style="max-width:560px;margin:auto;background:#fff;border-radius:16px;padding:32px"><h1>${title}</h1><p>${message}</p>${action}</main></body></html>`;
}

function redirectToPortal(result: "connected" | "error") {
  const url = new URL(appOrigin());
  url.searchParams.set("google-calendar", result);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

async function googleTokenRequest(params: URLSearchParams) {
  const result = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  const data = object(await result.json().catch(() => ({})));
  if (!result.ok) throw new Error("Google authorization failed");
  return data;
}

async function googleJson(url: string, accessToken: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const result = await fetch(url, { ...init, headers });
  if (!result.ok) {
    if (result.status === 404) return { missing: true, data: {} };
    throw new Error("Google Calendar request failed");
  }
  return { missing: false, data: object(await result.json().catch(() => ({}))) };
}

async function accessTokenForConnection(connection: Record<string, unknown>) {
  const refreshToken = await decryptRefreshToken(text(connection.refresh_token_ciphertext), text(connection.refresh_token_iv));
  const clientId = text(Deno.env.get("GOOGLE_OAUTH_CLIENT_ID"));
  const clientSecret = text(Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET"));
  if (!clientId || !clientSecret) throw new Error("Google Calendar is not configured");
  const tokens = await googleTokenRequest(new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  }));
  const token = text(tokens.access_token);
  if (!token) throw new Error("Google Calendar connection expired");
  return token;
}

async function activeMembership(admin: ReturnType<typeof createClient>, userId: string, schoolId = "") {
  let query = admin
    .from("school_memberships")
    .select("school_id, schools(timezone)")
    .eq("user_id", userId)
    .eq("status", "active");
  if (schoolId) query = query.eq("school_id", schoolId);
  const { data, error } = await query.order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (error || !data) throw new Error("Active school membership required");
  const school = Array.isArray(data.schools) ? data.schools[0] : data.schools;
  return { schoolId: data.school_id as string, timezone: text(school?.timezone) || "Europe/Kyiv" };
}

async function authenticatedContext(request: Request, admin: ReturnType<typeof createClient>) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (!token) throw new Error("Authentication required");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new Error("Authentication required");
  return data.user;
}

async function connectionForUser(admin: ReturnType<typeof createClient>, schoolId: string, userId: string) {
  const { data, error } = await admin
    .from("google_calendar_connections")
    .select("id, school_id, user_id, calendar_id, calendar_summary, refresh_token_ciphertext, refresh_token_iv")
    .eq("school_id", schoolId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as Record<string, unknown> | null;
}

async function syncLessonForConnection(
  admin: ReturnType<typeof createClient>,
  connection: Record<string, unknown>,
  lesson: Record<string, unknown>,
  subjectName: string,
  timezone: string
) {
  const connectionId = text(connection.id);
  const lessonId = text(lesson.id);
  const { data: existingLink, error: linkError } = await admin
    .from("google_calendar_event_links")
    .select("id, google_event_id")
    .eq("connection_id", connectionId)
    .eq("lesson_id", lessonId)
    .maybeSingle();
  if (linkError) throw linkError;

  const accessToken = await accessTokenForConnection(connection);
  const calendarId = encodeURIComponent(text(connection.calendar_id));
  const isCancelled = ["cancelled", "cancelled_paid"].includes(text(lesson.status));
  if (isCancelled) {
    if (existingLink?.google_event_id) {
      await googleJson(
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(existingLink.google_event_id)}`,
        accessToken,
        { method: "DELETE" }
      );
      const { error } = await admin.from("google_calendar_event_links").delete().eq("id", existingLink.id);
      if (error) throw error;
    }
    return;
  }

  const meetingUrl = text(lesson.meeting_url);
  const event = {
    summary: `${subjectName}: ${text(lesson.title)}`,
    description: meetingUrl ? `Посилання на заняття: ${meetingUrl}` : "",
    location: text(lesson.location_text),
    start: { dateTime: text(lesson.starts_at), timeZone: timezone },
    end: { dateTime: text(lesson.ends_at), timeZone: timezone }
  };

  let googleEventId = text(existingLink?.google_event_id);
  if (googleEventId) {
    const updated = await googleJson(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(googleEventId)}`,
      accessToken,
      { method: "PATCH", body: JSON.stringify(event) }
    );
    if (updated.missing) googleEventId = "";
  }
  if (!googleEventId) {
    const created = await googleJson(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
      accessToken,
      { method: "POST", body: JSON.stringify(event) }
    );
    googleEventId = text(created.data.id);
    if (!googleEventId) throw new Error("Google Calendar did not create an event");
  }

  const { error } = await admin.from("google_calendar_event_links").upsert({
    connection_id: connectionId,
    lesson_id: lessonId,
    google_event_id: googleEventId,
    synced_at: new Date().toISOString()
  }, { onConflict: "connection_id,lesson_id" });
  if (error) throw error;
}

async function loadLessonContext(admin: ReturnType<typeof createClient>, lessonId: string) {
  const { data: lesson, error } = await admin
    .from("lessons")
    .select("id, school_id, teacher_id, subject_id, title, starts_at, ends_at, status, meeting_url, location_text")
    .eq("id", lessonId)
    .maybeSingle();
  if (error || !lesson) throw new Error("Lesson not found");
  const [{ data: students, error: studentsError }, { data: subject, error: subjectError }, { data: school, error: schoolError }] = await Promise.all([
    admin.from("lesson_students").select("student_id").eq("lesson_id", lesson.id),
    admin.from("subjects").select("name").eq("id", lesson.subject_id).maybeSingle(),
    admin.from("schools").select("timezone").eq("id", lesson.school_id).maybeSingle()
  ]);
  if (studentsError || subjectError || schoolError) throw new Error("Unable to read lesson data");
  return {
    lesson: lesson as Record<string, unknown>,
    studentIds: (students || []).map((row) => text(row.student_id)).filter(Boolean),
    subjectName: text(subject?.name) || "Заняття",
    timezone: text(school?.timezone) || "Europe/Kyiv"
  };
}

async function syncOneLesson(
  admin: ReturnType<typeof createClient>,
  actorId: string,
  lessonId: string
) {
  const context = await loadLessonContext(admin, lessonId);
  const membership = await activeMembership(admin, actorId, text(context.lesson.school_id));
  const participantIds = [...new Set([text(context.lesson.teacher_id), ...context.studentIds])];
  if (!participantIds.includes(actorId)) {
    const { data: adminRole, error } = await admin
      .from("school_memberships")
      .select("roles")
      .eq("school_id", membership.schoolId)
      .eq("user_id", actorId)
      .eq("status", "active")
      .maybeSingle();
    if (error || !Array.isArray(adminRole?.roles) || !adminRole.roles.includes("admin")) throw new Error("Lesson access denied");
  }

  const { data: connections, error } = await admin
    .from("google_calendar_connections")
    .select("id, school_id, user_id, calendar_id, calendar_summary, refresh_token_ciphertext, refresh_token_iv")
    .eq("school_id", text(context.lesson.school_id))
    .in("user_id", participantIds);
  if (error) throw error;
  for (const connection of connections || []) {
    await syncLessonForConnection(admin, connection, context.lesson, context.subjectName, context.timezone);
  }
}

async function removeLessonEvents(
  admin: ReturnType<typeof createClient>,
  actorId: string,
  lessonId: string
) {
  const context = await loadLessonContext(admin, lessonId);
  const membership = await activeMembership(admin, actorId, text(context.lesson.school_id));
  const participantIds = [...new Set([text(context.lesson.teacher_id), ...context.studentIds])];
  if (!participantIds.includes(actorId)) {
    const { data: adminRole, error } = await admin
      .from("school_memberships")
      .select("roles")
      .eq("school_id", membership.schoolId)
      .eq("user_id", actorId)
      .eq("status", "active")
      .maybeSingle();
    if (error || !Array.isArray(adminRole?.roles) || !adminRole.roles.includes("admin")) throw new Error("Lesson access denied");
  }

  const { data: links, error: linksError } = await admin
    .from("google_calendar_event_links")
    .select("id, connection_id, google_event_id")
    .eq("lesson_id", lessonId);
  if (linksError) throw linksError;
  const connectionIds = [...new Set((links || []).map((link) => text(link.connection_id)).filter(Boolean))];
  if (!connectionIds.length) return;
  const { data: connections, error: connectionsError } = await admin
    .from("google_calendar_connections")
    .select("id, calendar_id, refresh_token_ciphertext, refresh_token_iv")
    .in("id", connectionIds);
  if (connectionsError) throw connectionsError;
  const connectionById = new Map((connections || []).map((connection) => [text(connection.id), connection as Record<string, unknown>]));

  for (const link of links || []) {
    const connection = connectionById.get(text(link.connection_id));
    if (!connection) continue;
    const accessToken = await accessTokenForConnection(connection);
    await googleJson(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(text(connection.calendar_id))}/events/${encodeURIComponent(text(link.google_event_id))}`,
      accessToken,
      { method: "DELETE" }
    );
  }
}

async function syncUserLessons(
  admin: ReturnType<typeof createClient>,
  schoolId: string,
  userId: string
) {
  const connection = await connectionForUser(admin, schoolId, userId);
  if (!connection) return 0;
  const { data: lessons, error } = await admin
    .from("lessons")
    .select("id, school_id, teacher_id, subject_id, title, starts_at, ends_at, status, meeting_url, location_text")
    .eq("school_id", schoolId)
    .gte("ends_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("starts_at")
    .limit(500);
  if (error) throw error;
  const lessonIds = (lessons || []).map((lesson) => text(lesson.id));
  const { data: lessonStudents, error: studentError } = lessonIds.length
    ? await admin.from("lesson_students").select("lesson_id, student_id").in("lesson_id", lessonIds)
    : { data: [], error: null };
  if (studentError) throw studentError;
  const participants = new Map<string, string[]>();
  (lessonStudents || []).forEach((row) => {
    const list = participants.get(text(row.lesson_id)) || [];
    list.push(text(row.student_id));
    participants.set(text(row.lesson_id), list);
  });
  const subjectIds = [...new Set((lessons || []).map((lesson) => text(lesson.subject_id)).filter(Boolean))];
  const { data: subjects, error: subjectError } = subjectIds.length
    ? await admin.from("subjects").select("id, name").in("id", subjectIds)
    : { data: [], error: null };
  if (subjectError) throw subjectError;
  const subjectNames = new Map((subjects || []).map((subject) => [text(subject.id), text(subject.name)]));
  const { data: school, error: schoolError } = await admin.from("schools").select("timezone").eq("id", schoolId).maybeSingle();
  if (schoolError) throw schoolError;
  const timezone = text(school?.timezone) || "Europe/Kyiv";

  let synced = 0;
  for (const lesson of lessons || []) {
    const isParticipant = text(lesson.teacher_id) === userId || (participants.get(text(lesson.id)) || []).includes(userId);
    if (!isParticipant) continue;
    await syncLessonForConnection(admin, connection, lesson, subjectNames.get(text(lesson.subject_id)) || "Заняття", timezone);
    synced += 1;
  }
  return synced;
}

async function handleCallback(request: Request, admin: ReturnType<typeof createClient>, supabaseUrl: string) {
  const url = new URL(request.url);
  const state = text(url.searchParams.get("state"));
  const code = text(url.searchParams.get("code"));
  if (!state || !code) return new Response(htmlPage("Не вдалося підключити Google Calendar", "Від Google не надійшов код підтвердження.", true), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });

  const { data: pending, error } = await admin
    .from("google_calendar_oauth_states")
    .select("state, school_id, user_id")
    .eq("state", state)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error || !pending) return new Response(htmlPage("Посилання вже неактивне", "Повернись у School Portal і запусти підключення ще раз.", true), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
  await admin.from("google_calendar_oauth_states").delete().eq("state", state);

  try {
    const clientId = text(Deno.env.get("GOOGLE_OAUTH_CLIENT_ID"));
    const clientSecret = text(Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET"));
    if (!clientId || !clientSecret) throw new Error("Google Calendar is not configured");
    const tokens = await googleTokenRequest(new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUri(supabaseUrl),
      grant_type: "authorization_code"
    }));
    const refreshToken = text(tokens.refresh_token);
    const accessToken = text(tokens.access_token);
    if (!refreshToken || !accessToken) throw new Error("Google did not grant offline access");
    const { data: school, error: schoolError } = await admin.from("schools").select("timezone").eq("id", pending.school_id).maybeSingle();
    if (schoolError || !school) throw new Error("School not found");
    const calendarResult = await googleJson("https://www.googleapis.com/calendar/v3/calendars", accessToken, {
      method: "POST",
      body: JSON.stringify({ summary: "School Portal", timeZone: text(school.timezone) || "Europe/Kyiv" })
    });
    const calendarId = text(calendarResult.data.id);
    if (!calendarId) throw new Error("Google Calendar was not created");
    const encrypted = await encryptRefreshToken(refreshToken);
    const { error: connectionError } = await admin.from("google_calendar_connections").upsert({
      school_id: pending.school_id,
      user_id: pending.user_id,
      calendar_id: calendarId,
      calendar_summary: text(calendarResult.data.summary) || "School Portal",
      refresh_token_ciphertext: encrypted.ciphertext,
      refresh_token_iv: encrypted.iv,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: "school_id,user_id" });
    if (connectionError) throw connectionError;
    await syncUserLessons(admin, pending.school_id, pending.user_id);
    return redirectToPortal("connected");
  } catch (_) {
    return redirectToPortal("error");
  }
}

Deno.serve(async (request) => {
  const supabaseUrl = text(Deno.env.get("SUPABASE_URL"));
  const serviceRoleKey = text(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if (!supabaseUrl || !serviceRoleKey) return response(request, { error: "Server configuration is missing" }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  if (request.method === "GET") return handleCallback(request, admin, supabaseUrl);
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return response(request, { error: "Method not allowed" }, 405);

  try {
    const user = await authenticatedContext(request, admin);
    const payload = object(await request.json().catch(() => ({})));
    const action = text(payload.action);
    const requestedSchoolId = text(payload.schoolId);
    const membership = await activeMembership(admin, user.id, requestedSchoolId);

    if (action === "status") {
      const connection = await connectionForUser(admin, membership.schoolId, user.id);
      return response(request, { connected: Boolean(connection), calendarName: text(connection?.calendar_summary) });
    }

    if (action === "connect") {
      const clientId = text(Deno.env.get("GOOGLE_OAUTH_CLIENT_ID"));
      const clientSecret = text(Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET"));
      if (!clientId || !clientSecret || !text(Deno.env.get("GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY"))) {
        return response(request, { error: "Google Calendar ще не налаштований на сервері." }, 503);
      }
      const state = crypto.randomUUID();
      const { error } = await admin.from("google_calendar_oauth_states").insert({
        state,
        school_id: membership.schoolId,
        user_id: user.id,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
      });
      if (error) throw error;
      const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authorizationUrl.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUri(supabaseUrl),
        response_type: "code",
        scope: googleCalendarScope,
        access_type: "offline",
        prompt: "consent",
        state
      }).toString();
      return response(request, { authorizationUrl: authorizationUrl.toString() });
    }

    if (action === "disconnect") {
      const { error } = await admin
        .from("google_calendar_connections")
        .delete()
        .eq("school_id", membership.schoolId)
        .eq("user_id", user.id);
      if (error) throw error;
      return response(request, { message: "Синхронізацію з Google Calendar вимкнено." });
    }

    if (action === "sync") {
      const lessonId = text(payload.lessonId);
      if (lessonId) {
        await syncOneLesson(admin, user.id, lessonId);
        return response(request, { message: "Заняття синхронізовано." });
      }
      const count = await syncUserLessons(admin, membership.schoolId, user.id);
      return response(request, { message: "Календар синхронізовано.", count });
    }

    if (action === "remove") {
      const lessonId = text(payload.lessonId);
      if (!lessonId) return response(request, { error: "Lesson id is required" }, 400);
      await removeLessonEvents(admin, user.id, lessonId);
      return response(request, { message: "Події Google Calendar прибрано." });
    }

    return response(request, { error: "Unknown action" }, 400);
  } catch (error) {
    const message = text(error instanceof Error ? error.message : "");
    const safeMessage = [
      "Authentication required",
      "Active school membership required",
      "Lesson access denied",
      "Lesson not found",
      "Google Calendar is not configured",
      "Google Calendar connection expired"
    ].includes(message) ? message : "Не вдалося виконати дію з Google Calendar.";
    return response(request, { error: safeMessage }, message === "Authentication required" ? 401 : 400);
  }
});
