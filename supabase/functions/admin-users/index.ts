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
      const { error } = await adminClient.auth.admin.deleteUser(userId);
      if (error) {
        if (error.message.toLowerCase().includes("database error deleting user")) {
          return response({ error: "Account has learning or financial history. Suspend access instead." }, 400);
        }
        return response({ error: error.message }, 400);
      }
      return response({ message: "Акаунт видалено." });
    }

    return response({ error: "Unknown action" }, 400);
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : "Unexpected server error" }, 500);
  }
});
