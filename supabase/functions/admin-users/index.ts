import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

const allowedRoles = new Set(["admin", "teacher", "student"]);

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function roles(value: unknown) {
  const candidates = Array.isArray(value) ? value : [value];
  return [...new Set(candidates.map(text).filter((role) => allowedRoles.has(role)))];
}

function preferredProfileRole(userRoles: string[]) {
  return userRoles.includes("teacher") ? "teacher" : userRoles.includes("student") ? "student" : "admin";
}

function uniqueIds(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

async function removeStoredFiles(
  adminClient: ReturnType<typeof createClient>,
  schoolId: string,
  userId: string,
  lessonIds: string[],
  homeworkIds: string[],
  homeworkStudentIds: string[],
  submissionIds: string[]
) {
  const { data: attachments, error: attachmentsError } = await adminClient
    .from("file_attachments")
    .select("storage_path, uploaded_by, lesson_id, homework_id, homework_student_id, submission_id")
    .eq("school_id", schoolId);
  if (attachmentsError) throw new Error(attachmentsError.message);

  const lessonIdSet = new Set(lessonIds);
  const homeworkIdSet = new Set(homeworkIds);
  const homeworkStudentIdSet = new Set(homeworkStudentIds);
  const submissionIdSet = new Set(submissionIds);
  const paths = uniqueIds((attachments || []).filter((attachment) =>
    attachment.uploaded_by === userId ||
    lessonIdSet.has(attachment.lesson_id) ||
    homeworkIdSet.has(attachment.homework_id) ||
    homeworkStudentIdSet.has(attachment.homework_student_id) ||
    submissionIdSet.has(attachment.submission_id)
  ).map((attachment) => attachment.storage_path));

  for (let start = 0; start < paths.length; start += 100) {
    const { error } = await adminClient.storage.from("portal-files").remove(paths.slice(start, start + 100));
    if (error) throw new Error(error.message);
  }

  if (paths.length) {
    const { error } = await adminClient.from("file_attachments").delete().in("storage_path", paths);
    if (error) throw new Error(error.message);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);

  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) return response({ error: "Authentication required" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return response({ error: "Function environment is incomplete" }, 500);

    // Verify the caller's access token before using the privileged server client.
    const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const accessToken = authorization.replace(/^Bearer\s+/i, "").trim();
    const { data: { user }, error: userError } = await adminClient.auth.getUser(accessToken);
    if (userError || !user) return response({ error: "Authentication required" }, 401);

    const body = await request.json();
    const schoolId = text(body.schoolId);
    const action = text(body.action);
    if (!schoolId || !action) return response({ error: "schoolId and action are required" }, 400);

    const { data: callerMembership, error: membershipError } = await adminClient
      .from("school_memberships")
      .select("id")
      .eq("school_id", schoolId)
      .eq("user_id", user.id)
      .contains("roles", ["admin"])
      .eq("status", "active")
      .maybeSingle();
    if (membershipError || !callerMembership) return response({ error: "Administrator access required" }, 403);

    if (action === "create") {
      const email = text(body.email).toLowerCase();
      const password = text(body.password);
      const fullName = text(body.fullName);
      const userRoles = roles(body.roles ?? body.role);
      if (!email || !password || fullName.length < 2 || !userRoles.length) return response({ error: "Invalid account data" }, 400);
      if (password.length < 8) return response({ error: "Password must contain at least 8 characters" }, 400);

      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName, requested_role: preferredProfileRole(userRoles) }
      });
      if (createError || !created.user) return response({ error: createError?.message || "Could not create user" }, 400);

      const userId = created.user.id;
      const { error: profileError } = await adminClient.from("profiles").upsert({
        id: userId,
        full_name: fullName,
        requested_role: preferredProfileRole(userRoles)
      });
      const { error: schoolError } = await adminClient.from("school_memberships").insert({
        school_id: schoolId,
        user_id: userId,
        roles: userRoles,
        status: "active",
        approved_by: user.id,
        approved_at: new Date().toISOString()
      });
      if (profileError || schoolError) {
        await adminClient.auth.admin.deleteUser(userId);
        return response({ error: profileError?.message || schoolError?.message || "Could not grant access" }, 400);
      }
      await adminClient.from("registration_requests").delete().eq("user_id", userId);
      return response({ message: "Акаунт створено та активовано." });
    }

    const userId = text(body.userId);
    if (!userId) return response({ error: "userId is required" }, 400);
    const { data: target, error: targetError } = await adminClient
      .from("school_memberships")
      .select("id, roles")
      .eq("school_id", schoolId)
      .eq("user_id", userId)
      .maybeSingle();
    if (targetError || !target) return response({ error: "Account is not a member of this school" }, 404);

    if (action === "set_roles" || action === "change_role") {
      const userRoles = roles(action === "change_role" ? body.role : body.roles);
      if (!userRoles.length) return response({ error: "Select at least one role" }, 400);
      const targetRoles = Array.isArray(target.roles) ? target.roles : [];
      const removesAdmin = targetRoles.includes("admin") && !userRoles.includes("admin");
      if (removesAdmin) {
        const { count, error: countError } = await adminClient
          .from("school_memberships")
          .select("id", { count: "exact", head: true })
          .eq("school_id", schoolId)
          .eq("status", "active")
          .contains("roles", ["admin"]);
        if (countError) return response({ error: countError.message }, 400);
        if ((count || 0) <= 1) return response({ error: "At least one active administrator must remain" }, 400);
      }
      const { error } = await adminClient.from("school_memberships").update({ roles: userRoles }).eq("id", target.id);
      if (error) return response({ error: error.message }, 400);
      await adminClient.from("profiles").update({ requested_role: preferredProfileRole(userRoles), updated_at: new Date().toISOString() }).eq("id", userId);
      return response({ message: "Ролі користувача оновлено." });
    }

    if (action === "suspend" || action === "activate") {
      const { error } = await adminClient.from("school_memberships").update({ status: action === "suspend" ? "suspended" : "active" }).eq("id", target.id);
      if (error) return response({ error: error.message }, 400);
      return response({ message: action === "suspend" ? "Доступ призупинено." : "Доступ відновлено." });
    }

    if (action === "delete") {
      if (userId === user.id) return response({ error: "The current administrator cannot delete their own account here" }, 400);
      const [otherMembershipsResult, ownedSchoolsResult, lessonsResult, teacherHomeworkResult, studentHomeworkResult, studentSubmissionsResult] = await Promise.all([
        adminClient.from("school_memberships").select("school_id").eq("user_id", userId).neq("school_id", schoolId).limit(1),
        adminClient.from("schools").select("id").eq("owner_id", userId),
        adminClient.from("lessons").select("id").eq("school_id", schoolId).eq("teacher_id", userId),
        adminClient.from("homework").select("id").eq("school_id", schoolId).eq("teacher_id", userId),
        adminClient.from("homework_students").select("id").eq("student_id", userId),
        adminClient.from("homework_submissions").select("id").eq("student_id", userId)
      ]);
      const initialError = [otherMembershipsResult, ownedSchoolsResult, lessonsResult, teacherHomeworkResult, studentHomeworkResult, studentSubmissionsResult]
        .map((result) => result.error)
        .find(Boolean);
      if (initialError) return response({ error: initialError.message }, 400);
      if ((otherMembershipsResult.data || []).length) {
        return response({ error: "Account belongs to another school and cannot be deleted here" }, 400);
      }

      const ownedSchoolIds = (ownedSchoolsResult.data || []).map((school) => school.id);
      if (ownedSchoolIds.some((id) => id !== schoolId)) {
        return response({ error: "Account owns another school and cannot be deleted here" }, 400);
      }

      const lessonIds = (lessonsResult.data || []).map((lesson) => lesson.id);
      const homeworkIds = (teacherHomeworkResult.data || []).map((homework) => homework.id);
      let teacherHomeworkStudents: Array<{ id: string }> = [];
      let homeworkStudentSubmissions: Array<{ id: string }> = [];
      if (homeworkIds.length) {
        const { data, error } = await adminClient.from("homework_students").select("id").in("homework_id", homeworkIds);
        if (error) return response({ error: error.message }, 400);
        teacherHomeworkStudents = data || [];
      }
      const homeworkStudentIds = uniqueIds([
        ...teacherHomeworkStudents.map((item) => item.id),
        ...(studentHomeworkResult.data || []).map((item) => item.id)
      ]);
      if (homeworkStudentIds.length) {
        const { data, error } = await adminClient.from("homework_submissions").select("id").in("homework_student_id", homeworkStudentIds);
        if (error) return response({ error: error.message }, 400);
        homeworkStudentSubmissions = data || [];
      }
      const submissionIds = uniqueIds([
        ...homeworkStudentSubmissions.map((item) => item.id),
        ...(studentSubmissionsResult.data || []).map((item) => item.id)
      ]);

      try {
        await removeStoredFiles(adminClient, schoolId, userId, lessonIds, homeworkIds, homeworkStudentIds, submissionIds);

        const { error: ledgerError } = await adminClient
          .from("wallet_ledger")
          .delete()
          .eq("school_id", schoolId)
          .or(`student_id.eq.${userId},teacher_id.eq.${userId},created_by.eq.${userId}`);
        if (ledgerError) throw new Error(ledgerError.message);

        if (homeworkIds.length) {
          const { error } = await adminClient.from("homework").delete().in("id", homeworkIds);
          if (error) throw new Error(error.message);
        }
        if (lessonIds.length) {
          const { error } = await adminClient.from("lessons").delete().in("id", lessonIds);
          if (error) throw new Error(error.message);
        }
        if (ownedSchoolIds.includes(schoolId)) {
          const { error } = await adminClient.from("schools").update({ owner_id: user.id }).eq("id", schoolId);
          if (error) throw new Error(error.message);
        }

        const { error } = await adminClient.auth.admin.deleteUser(userId);
        if (error) throw new Error(error.message);
      } catch (error) {
        return response({ error: error instanceof Error ? error.message : "Could not delete account" }, 400);
      }
      return response({ message: "Акаунт і всі пов’язані дані видалено." });
    }

    return response({ error: "Unknown action" }, 400);
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : "Unexpected server error" }, 500);
  }
});
