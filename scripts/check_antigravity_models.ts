import { tokenPool } from "../src/lib/antigravity/token-pool";
import { loadConfig } from "../src/lib/config-manager";

// Load API Key from config or local auth storage
const config = loadConfig();
let TOKEN = config.providerSettings?.antigravity?.apiKey || process.env.ANTIGRAVITY_TOKEN;

const ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com", // Sandbox (Preferred)
  "https://cloudcode-pa.googleapis.com", // Production
];

interface FetchModelsResponse {
  models?: Record<string, unknown>;
}

async function listModels(endpoint: string) {
  console.log(`\n--- Listing models at ${endpoint} ---`);
  try {
    const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "User-Agent": "antigravity/1.11.5 darwin/arm64",
        "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (response.status === 200) {
      const data = (await response.json()) as FetchModelsResponse;
      console.log("✅ Success! Found models:");

      // Extract and print ALL model IDs
      const models = data.models || {};
      const allIds = Object.keys(models).sort();

      console.log("\nAll Available Models:");
      console.log(allIds);

      // Check for specific interest models based on user feedback
      const checkList = [
        "gemini-3-flash",
        "gemini-3-pro-high",
        "gemini-3-pro-low",
        "gemini-3-pro-image",
      ];
      console.log("\nSpecific Validation:");
      checkList.forEach((id) => {
        const exists = !!models[id];
        console.log(`- ${id}: ${exists ? "✅ AVAILABLE" : "❌ NOT FOUND"}`);
      });
    } else {
      console.log(`❌ Error: ${response.status} ${response.statusText}`);
      try {
        const text = await response.text();
        console.log(text.slice(0, 200)); // Limit error log
      } catch {}
    }
  } catch (e) {
    console.error(`❌ Fetch failed: ${e}`);
  }
}

async function main() {
  if (!TOKEN) {
    try {
      const poolToken = await tokenPool.getAccessToken();
      TOKEN = poolToken.token;
      console.log(`✅ Loaded token for ${poolToken.email} from token pool.`);
    } catch {
      // Ignore
    }
  }

  if (!TOKEN) {
    console.error("❌ No Antigravity Token found in config, env, or token pool.");
    process.exit(1);
  }

  console.log("🔍 Testing Antigravity Model Availability...");
  for (const ep of ENDPOINTS) {
    await listModels(ep);
  }
}

main();
