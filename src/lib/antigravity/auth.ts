import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import open from "open";

import { getConfigDir } from "../config-manager";
import { CLIENT_ID, CLIENT_SECRET } from "./constants";

// ============ Constants ============
const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
const TOKEN_FILE = "antigravity_token.json";

function getTokenFilePath(): string {
  return join(getConfigDir(), TOKEN_FILE);
}

/**
 * 尝试从旧路径迁移 Token 文件
 */
function migrateOldToken(): void {
  const oldTokenPath = join(process.cwd(), TOKEN_FILE);
  const newTokenPath = getTokenFilePath();

  if (existsSync(oldTokenPath) && !existsSync(newTokenPath)) {
    try {
      const oldContent = readFileSync(oldTokenPath, "utf-8");
      writeFileSync(newTokenPath, oldContent, "utf-8");
      // 迁移成功后删除旧文件
      unlinkSync(oldTokenPath);
      console.log(`✅ 已将 Token 迁移至: ${newTokenPath}`);
    } catch (e) {
      console.warn(`⚠️ Token 迁移失败: ${e}`);
    }
  }
}

// ============ Types ============
export interface TokenStore {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  project_id?: string;
  email?: string;
}

interface AntigravityTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

interface AntigravityUserInfo {
  email: string;
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: { id: string } | string;
}

// ============ PKCE Utils ============
function base64URLEncode(str: Buffer) {
  return str.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest();
}

function generatePKCE() {
  const verifier = base64URLEncode(randomBytes(32));
  const challenge = base64URLEncode(sha256(Buffer.from(verifier)));
  return { verifier, challenge };
}

// ============ Auth Logic ============

export function loginWithAntigravity(): Promise<TokenStore> {
  const { verifier, challenge } = generatePKCE();
  const port = 51121;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);

      if (url.pathname === "/oauth-callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.end(`Login failed: ${error}`);
          server.close();
          reject(new Error(error));
          return;
        }

        if (code) {
          res.end("Login successful! You can close this window now.");
          server.close();

          // 使用 .then/.catch 代替 async/await，避免在回调中使用 async
          exchangeToken(code, verifier)
            .then((tokens) => {
              saveToken(tokens);
              resolve(tokens);
            })
            .catch(reject);
        }
      }
    });

    server.on("error", (err) => {
      reject(new Error(`Failed to start OAuth server: ${err.message}`));
    });

    server.listen(port, () => {
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", SCOPES.join(" "));
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("access_type", "offline");

      console.log("Opening browser for login...");
      open(authUrl.toString());
    });
  });
}

async function exchangeToken(code: string, verifier: string): Promise<TokenStore> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  const data = (await res.json()) as AntigravityTokenResponse;
  const now = Date.now();

  // Get User Info for email
  let email = "";
  try {
    const userRes = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (userRes.ok) {
      const userData = (await userRes.json()) as AntigravityUserInfo;
      email = userData.email;
    }
  } catch (e) {}

  // Resolve Project ID (Try Prod First)
  let projectId = "";
  try {
    projectId = await fetchProjectID(data.access_token);
  } catch (e) {}

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: now + data.expires_in * 1000,
    project_id: projectId,
    email,
  };
}

async function fetchProjectID(accessToken: string): Promise<string> {
  const url = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "antigravity/1.11.5 windows/amd64",
      "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
      "Client-Metadata":
        '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
    },
    body: JSON.stringify({
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    }),
  });

  if (res.ok) {
    const data = (await res.json()) as LoadCodeAssistResponse;
    if (typeof data.cloudaicompanionProject === "string") {
      return data.cloudaicompanionProject || "";
    }
    return data.cloudaicompanionProject?.id || "";
  }
  return "";
}

export function saveToken(token: TokenStore) {
  writeFileSync(getTokenFilePath(), JSON.stringify(token, null, 2));
}

export function loadToken(): TokenStore | null {
  // 尝试迁移旧 Token
  migrateOldToken();

  const path = getTokenFilePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export async function getAccessToken(): Promise<string> {
  const token = loadToken();
  if (!token) throw new Error("Not logged in");

  if (Date.now() < token.expires_at - 60000) {
    return token.access_token;
  }

  // Refresh Token
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) throw new Error("Failed to refresh token");
  const data = (await res.json()) as AntigravityTokenResponse;

  const newToken: TokenStore = {
    ...token,
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
    // Update refresh token if returned
    refresh_token: data.refresh_token || token.refresh_token,
  };

  saveToken(newToken);
  return newToken.access_token;
}
