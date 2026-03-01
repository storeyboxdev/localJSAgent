import { createClient } from "@supabase/supabase-js";

// Admin client — bypasses RLS for server-side operations
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
