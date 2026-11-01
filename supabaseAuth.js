import { createClient } from "@supabase/supabase-js";
import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";

const supabaseUrl = process.env.SUPABASE_URL || "https://spcjilhhjeudvyyfwqyt.supabase.co";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || "sb_publishable_ZbZYXO2lesGT2mCEybGYbQ_OqYjeuGY";

export const supabase = createClient(supabaseUrl, supabaseKey);

export async function useSupabaseAuthState() {
  const writeData = async (id, data) => {
    try {
      const serialized = JSON.stringify(data, BufferJSON.replacer);
      await supabase.from("whatsapp_auth").upsert({
        id,
        data: JSON.parse(serialized),
      });
    } catch (err) {
      console.error("Supabase write error:", err);
    }
  };

  const readData = async (id) => {
    try {
      const { data, error } = await supabase
        .from("whatsapp_auth")
        .select("data")
        .eq("id", id)
        .maybeSingle();

      if (error || !data || !data.data) return null;
      return JSON.parse(JSON.stringify(data.data), BufferJSON.reviver);
    } catch (err) {
      console.error("Supabase read error:", err);
      return null;
    }
  };

  const removeData = async (id) => {
    try {
      await supabase.from("whatsapp_auth").delete().eq("id", id);
    } catch (err) {
      console.error("Supabase remove error:", err);
    }
  };

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          for (const id of ids) {
            let value = await readData(`${type}-${id}`);
            if (type === "app-state-sync-key" && value) {
              value = JSON.parse(JSON.stringify(value), BufferJSON.reviver);
            }
            result[id] = value;
          }
          return result;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              const val = data[category][id];
              if (val) {
                await writeData(`${category}-${id}`, val);
              } else {
                await removeData(`${category}-${id}`);
              }
            }
          }
        },
      },
    },
    saveCreds: () => writeData("creds", creds),
  };
}
