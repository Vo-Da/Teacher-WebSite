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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);

  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) return response({ error: "Authentication required" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceRoleKey) return response({ error: "Function environment is incomplete" }, 500);

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return response({ error: "Authentication required" }, 401);

    const body = await request.json();
    const schoolId = text(body.schoolId);
    const action = text(body.action);
    if (!schoolId || !action) return response({ error: "schoolId and action are required" }, 400);

    // The service client is used only after the caller's active administrator role is verified.
    const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: callerMembership, error: membershipError } = await adminClient
      .from("school_memberships")
      .select("id")
      .eq("school_id", schoolId)
      .eq("user_id", userData.user.id)
      .eq("role", "admin")
      .eq("status", "active")
      .maybeSingle();
    if (membershipError || !callerMembership) return response({ error: "Administrator access required" }, 403);

    if (action === "create") {
      const email = text(body.email).toLowerCase();
      const password = text(body.password);
      const fullName = text(body.fullName);
      const role = text(body.role);
      if (!email || !password || fullName.length < 2 || !allowedRoles.has(role)) return response({ error: "Invalid account data" }, 400);
      if (password.length < 8) return response({ error: "Password must contain at least 8 characters" }, 400);

      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName, requested_role: role }
      });
      if (createError || !created.user) return response({ error: createError?.message || "Could not create user" }, 400);

      const userId = created.user.id;
      const { error: profileError } = await adminClient.from("profiles").upsert({
        id: userId,
        full_name: fullName,
        requested_role: role
      });
      const { error: schoolError } = await adminClient.from("school_memberships").insert({
        school_id: schoolId,
        user_id: userId,
        role,
        status: "active",
        approved_by: userData.user.id,
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
    if (userId === userData.user.id) return response({ error: "The current administrator cannot change or delete their own access here" }, 400);

    const { data: target, error: targetError } = await adminClient
      .from("school_memberships")
      .select("id, role")
      .eq("school_id", schoolId)
      .eq("user_id", userId)
      .maybeSingle();
    if (targetError || !target) return response({ error: "Account is not a member of this school" }, 404);

    if (action === "change_role") {
      const role = text(body.role);
      if (!allowedRoles.has(role)) return response({ error: "Invalid role" }, 400);
      const { error } = await adminClient.from("school_memberships").update({ role }).eq("id", target.id);
      if (error) return response({ error: error.message }, 400);
      await adminClient.from("profiles").update({ requested_role: role, updated_at: new Date().toISOString() }).eq("id", userId);
      return response({ message: "Роль користувача оновлено." });
    }

    if (action === "suspend" || action === "activate") {
      const { error } = await adminClient.from("school_memberships").update({ status: action === "suspend" ? "suspended" : "active" }).eq("id", target.id);
      if (error) return response({ error: error.message }, 400);
      return response({ message: action === "suspend" ? "Доступ призупинено." : "Доступ відновлено." });
    }

    if (action === "delete") {
      const { error } = await adminClient.auth.admin.deleteUser(userId);
      if (error) return response({ error: error.message }, 400);
      return response({ message: "Акаунт видалено." });
    }

    return response({ error: "Unknown action" }, 400);
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : "Unexpected server error" }, 500);
  }
});
