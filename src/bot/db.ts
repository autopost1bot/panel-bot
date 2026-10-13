import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient<any> | null = null;

// Database access (service key — all authorization is done in the engine).
export async function getDb(): Promise<any> {
  if (!client) {
    const url = process.env["SUPABASE_URL"];
    const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}

/** SHA-256 hex password hashing with a per-tenant salt. */
export async function hashPassword(tenantId: number, username: string, password: string): Promise<string> {
  const data = new TextEncoder().encode(`botpwd:${tenantId}:${username.toLowerCase()}:${password}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
