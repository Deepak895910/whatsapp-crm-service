import { createClient } from "@supabase/supabase-js";
import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";

// Use a server-side Supabase secret. A publishable/anon key is not suitable
// for persisting WhatsApp credentials unless explicit, secure RLS policies exist.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (server-side secret). WhatsApp auth cannot be persisted safely."
  );
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export async function useSupabaseAuthState() {
  const writeData = async (id, value) => {
    const serialized = JSON.stringify(value, BufferJSON.replacer);
    const data = JSON.parse(serialized);
    const { error } = await supabase
      .from("whatsapp_auth")
      .upsert({ id, data }, { onConflict: "id" });
    if (error) throw new Error(`Supabase auth save failed for ${id}: ${error.message}`);
  };

  const readData = async (id) => {
    const { data, error } = await supabase
      .from("whatsapp_auth")
      .select("data")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`Supabase auth read failed for ${id}: ${error.message}`);
    if (!data || data.data == null) return null;
    return JSON.parse(JSON.stringify(data.data), BufferJSON.reviver);
  };

  const removeData = async (id) => {
    const { error } = await supabase.from("whatsapp_auth").delete().eq("id", id);
    if (error) throw new Error(`Supabase auth delete failed for ${id}: ${error.message}`);
  };

  // Do not silently create a fresh identity if the database is unavailable.
  // That behavior can make an existing linked device appear to have logged out.
  const storedCreds = await readData("creds");
  const creds = storedCreds || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          // Keep reads simple and deterministic; Baileys requests small key batches.
          for (const id of ids) result[id] = await readData(`${type}-${id}`);
          return result;
        },
        set: async (data) => {
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category] || {})) {
              const value = data[category][id];
              if (value) await writeData(`${category}-${id}`, value);
              else await removeData(`${category}-${id}`);
            }
          }
        },
      },
    },
    saveCreds: async () => writeData("creds", creds),
  };
}
