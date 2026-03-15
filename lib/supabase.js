import { createClient } from "@supabase/supabase-js";

// Admin client — bypasses RLS for server-side operations.
// null when SUPABASE_URL is not configured (knowledge base features disabled).
export const supabaseAdmin = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;
