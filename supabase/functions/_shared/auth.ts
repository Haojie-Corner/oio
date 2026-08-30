import { createClient } from "npm:@supabase/supabase-js@2";

export async function requireUser(request: Request) {
  const authorization = request.headers.get("Authorization");
  if (!authorization) throw new Error("未登录");

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const token = authorization.replace(/^Bearer\s+/i, "");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new Error("登录已过期");
  return { admin, user: data.user };
}
