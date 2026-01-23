import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import open from "open";

import { ANTIGRAVITY_ENDPOINTS, CLIENT_ID, CLIENT_SECRET, COMMON_HEADERS } from "./constants";

import { type TokenStore, tokenPool } from "./token-pool";

// ============ Constants ============
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

// ============ Types ============
export type { TokenStore } from "./token-pool";

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

// ============ PKCE & State Utils ============
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

function generateState() {
  return base64URLEncode(randomBytes(16));
}

// ============ Server Utils ============
function startServer(
  startPort: number,
  maxAttempts = 10,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryListen = () => {
      if (attempt >= maxAttempts) {
        reject(
          new Error(
            `Could not find a free port after ${maxAttempts} attempts starting from ${startPort}`,
          ),
        );
        return;
      }

      const port = startPort + attempt;
      const server = createServer();

      server.on("error", (err: unknown) => {
        const errno = err as NodeJS.ErrnoException;
        if (errno.code === "EADDRINUSE") {
          attempt++;
          tryListen();
          return;
        }
        reject(err);
      });

      server.listen(port, "127.0.0.1", () => {
        resolve({ server, port });
      });
    };

    tryListen();
  });
}

// ============ Auth Logic ============

export async function loginWithAntigravity(): Promise<TokenStore> {
  const { verifier, challenge } = generatePKCE();
  const state = generateState();

  const { server, port } = await startServer(51121);
  const redirectUri = `http://localhost:${port}/oauth-callback`;

  return new Promise((resolve, reject) => {
    // Timeout safety
    const timeout = setTimeout(
      () => {
        server.close();
        reject(new Error("Login timed out after 5 minutes"));
      },
      5 * 60 * 1000,
    );

    server.on("request", async (req, res) => {
      // Basic URL parsing to handle query params
      const incomingUrl = new URL(req.url || "/", `http://localhost:${port}`);

      if (incomingUrl.pathname === "/oauth-callback") {
        const code = incomingUrl.searchParams.get("code");
        const error = incomingUrl.searchParams.get("error");
        const returnedState = incomingUrl.searchParams.get("state");

        res.setHeader("Content-Type", "text/html; charset=utf-8");

        if (error) {
          res.end(getErrorHtml(error));
          shutdown();
          reject(new Error(error));
          return;
        }

        if (returnedState !== state) {
          const errorMsg = "State mismatch (CSRF protection)";
          res.end(getErrorHtml(errorMsg));
          shutdown();
          reject(new Error(errorMsg));
          return;
        }

        if (code) {
          res.end(getSuccessHtml());
          shutdown();

          try {
            const tokens = await exchangeToken(code, verifier, redirectUri);
            tokenPool.addToken(tokens);
            console.log(`Successfully logged in as ${tokens.email}`);
            resolve(tokens);
          } catch (e) {
            reject(e);
          }
        } else {
          res.end(getErrorHtml("No code returned"));
          shutdown();
          reject(new Error("No code returned"));
        }
      }
    });

    function shutdown() {
      clearTimeout(timeout);
      server.close();
    }

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", SCOPES.join(" "));
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("prompt", "consent"); // Force consent to ensure refresh_token

    console.log(`Opening browser for login (Port ${port})...`);
    open(authUrl.toString());
  });
}

async function exchangeToken(
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<TokenStore> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  const data = (await res.json()) as AntigravityTokenResponse;
  const now = Date.now();

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

  let projectId = "";
  try {
    projectId = await fetchProjectID(data.access_token);
  } catch (e) {
    console.warn("Failed to fetch Project ID initially:", e);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: now + data.expires_in * 1000,
    project_id: projectId,
    email,
  };
}

export async function fetchProjectID(accessToken: string): Promise<string> {
  let lastError: unknown;

  // Try each endpoint with timeout
  for (const baseUrl of ANTIGRAVITY_ENDPOINTS) {
    const url = `${baseUrl}/v1internal:loadCodeAssist`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...COMMON_HEADERS,
        },
        body: JSON.stringify({
          metadata: {
            ideType: "IDE_UNSPECIFIED",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
          },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = (await res.json()) as LoadCodeAssistResponse;
        const pid =
          typeof data.cloudaicompanionProject === "string"
            ? data.cloudaicompanionProject
            : data.cloudaicompanionProject?.id;

        if (pid) return pid;
      } else {
        // If 403/401, probably no point trying other endpoints, but let's be safe and try all for 5xx
        console.warn(`fetchProjectID failed at ${baseUrl}: ${res.status}`);
      }
    } catch (e) {
      clearTimeout(timeout);
      lastError = e;
      console.warn(`fetchProjectID network error at ${baseUrl}:`, e);
    }
  }

  throw lastError || new Error("Failed to fetch ProjectID from all endpoints");
}

// Wrapper for backward compatibility if needed, but preferably use tokenPool directly
export async function getAccessToken(): Promise<string> {
  const { token } = await tokenPool.getAccessToken();
  return token;
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
