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
      console.error(`Supabase write error for ${id}:`, err);
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
      console.error(`Supabase read error for ${id}:`, err);
      return null;
    }
  };

  const removeData = async (id) => {
    try {
      await supabase.from("whatsapp_auth").delete().eq("id", id);
    } catch (err) {
      console.error(`Supabase remove error for ${id}:`, err);
    }
  };

  // 1. Load creds from Supabase or initialize new ones
  const storedCreds = await readData("creds");
  const creds = storedCreds ? JSON.parse(JSON.stringify(storedCreds), BufferJSON.reviver) : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (value) {
                result[id] = JSON.parse(JSON.stringify(value), BufferJSON.reviver);
              }
            })
          );
          return result;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const keyName = `${category}-${id}`;
              if (value) {
                const serialized = JSON.stringify(value, BufferJSON.replacer);
                tasks.push(writeData(keyName, JSON.parse(serialized)));
              } else {
                tasks.push(removeData(keyName));
              }
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    // 2. Ensure creds are strictly saved to Supabase whenever updated
    saveCreds: async () => {
      const serializedCreds = JSON.stringify(creds, BufferJSON.replacer);
      await writeData("creds", JSON.parse(serializedCreds));
    },
  };
}
