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

        res.setHeader("Content-Type", "text/html; charset=utf-8");

        if (error) {
          res.end(getErrorHtml(error));
          server.close();
          reject(new Error(error));
          return;
        }

        if (code) {
          res.end(getSuccessHtml());
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

// ============ HTML Templates ============

function getSuccessHtml(): string {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录成功 - Marker Cleaner</title>
    <style>
        :root {
            --primary: #6366f1;
            --primary-hover: #4f46e5;
            --bg: #f8fafc;
            --card-bg: rgba(255, 255, 255, 0.8);
            --text: #1e293b;
        }

        body {
            margin: 0;
            padding: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: linear-gradient(135deg, #e0e7ff 0%, #f1f5f9 100%);
            color: var(--text);
            overflow: hidden;
        }

        .container {
            text-align: center;
            padding: 3rem;
            background: var(--card-bg);
            backdrop-filter: blur(12px);
            border-radius: 24px;
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.3);
            max-width: 400px;
            width: 90%;
            transform: translateY(0);
            animation: slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes slideUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .icon-box {
            width: 80px;
            height: 80px;
            background: #dcfce7;
            color: #16a34a;
            border-radius: 50%;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 0 auto 1.5rem;
            font-size: 2.5rem;
            animation: scaleIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        @keyframes scaleIn {
            from { transform: scale(0); }
            to { transform: scale(1); }
        }

        h1 {
            margin: 0 0 0.5rem;
            font-size: 1.75rem;
            font-weight: 700;
            background: linear-gradient(to right, #4f46e5, #9333ea);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        p {
            color: #64748b;
            line-height: 1.6;
            margin-bottom: 2rem;
        }

        .badge {
            display: inline-block;
            padding: 0.5rem 1rem;
            background: #eff6ff;
            color: #2563eb;
            border-radius: 9999px;
            font-size: 0.875rem;
            font-weight: 500;
            margin-bottom: 1rem;
        }

        .btn {
            background: var(--primary);
            color: white;
            border: none;
            padding: 0.75rem 1.5rem;
            border-radius: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            text-decoration: none;
        }

        .btn:hover {
            background: var(--primary-hover);
            transform: translateY(-1px);
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }

        .close-hint {
            font-size: 0.75rem;
            color: #94a3b8;
            margin-top: 1.5rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon-box">✓</div>
        <div class="badge">已授权</div>
        <h1>登录成功</h1>
        <p>您的账号已成功关联至 Marker Cleaner。您可以立即返回终端应用并关闭此窗口。</p>
        <button class="btn" onclick="window.close()">关闭此页</button>
        <div class="close-hint">如果此窗口未自动关闭，请手动关闭</div>
    </div>
</body>
</html>
  `;
}

function getErrorHtml(error: string): string {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录失败 - Marker Cleaner</title>
    <style>
        :root {
            --danger: #ef4444;
            --bg: #fef2f2;
            --text: #1e293b;
        }

        body {
            margin: 0;
            padding: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            font-family: -apple-system, sans-serif;
            background: var(--bg);
            color: var(--text);
        }

        .container {
            text-align: center;
            padding: 3rem;
            background: white;
            border-radius: 20px;
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
            max-width: 400px;
            width: 90%;
        }

        .icon-box {
            width: 70px;
            height: 70px;
            background: #fee2e2;
            color: var(--danger);
            border-radius: 50%;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 0 auto 1.5rem;
            font-size: 2rem;
        }

        h1 { margin: 0 0 1rem; color: var(--danger); }
        .error-msg { background: #f8fafc; padding: 1rem; border-radius: 8px; font-family: monospace; font-size: 0.9rem; color: #475569; margin-bottom: 2rem; overflow-wrap: break-word; }
        .btn { background: #64748b; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 10px; cursor: pointer; text-decoration: none; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon-box">!</div>
        <h1>登录遇到问题</h1>
        <p>授权过程中发生了错误：</p>
        <div class="error-msg">${error}</div>
        <button class="btn" onclick="window.close()">关闭重试</button>
    </div>
</body>
</html>
  `;
}
