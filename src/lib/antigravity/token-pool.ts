import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config-manager";
import { CLIENT_ID, CLIENT_SECRET } from "./constants";
// Cyclic import avoidance: Use dynamic import or pass fetcher?
// Actually, auth.ts imports tokenPool, so importing fetchProjectID from auth.ts here creates a cycle.
// We will assume fetchProjectID is passed or we duplicate the minimal fetch logic/import it dynamically.
// For now, let's use a dynamic import in the method to break the cycle.

const TOKENS_FILE = "antigravity_tokens.json";
const OLD_TOKEN_FILE = "antigravity_token.json";

export interface TokenStore {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  project_id?: string;
  email?: string;
  rate_limited_until?: number; // Persisted backoff
  last_used?: number; // For Round Robin / LRU
}

interface AntigravityTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

export class TokenPool {
  private tokens: TokenStore[] = [];
  private filePath: string;

  constructor() {
    this.filePath = join(getConfigDir(), TOKENS_FILE);
    this.load();
    this.migrateOldToken();
  }

  private load() {
    if (existsSync(this.filePath)) {
      try {
        this.tokens = JSON.parse(readFileSync(this.filePath, "utf-8"));
      } catch (e) {
        console.error("Failed to load token pool:", e);
        this.tokens = [];
      }
    }
  }

  private save() {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.tokens, null, 2));
    } catch (e) {
      console.error("Failed to save token pool:", e);
    }
  }

  private migrateOldToken() {
    const oldPath = join(getConfigDir(), OLD_TOKEN_FILE);
    if (existsSync(oldPath)) {
      try {
        const oldToken = JSON.parse(readFileSync(oldPath, "utf-8"));
        if (oldToken.access_token) {
          this.addToken(oldToken);
          unlinkSync(oldPath);
          console.log("Migrated single token to token pool.");
        }
      } catch (e) {
        // Ignore corrupted old file
      }
    }
  }

  public getCount(): number {
    return this.tokens.length;
  }

  public getTokens(): TokenStore[] {
    return [...this.tokens];
  }

  public addToken(newToken: TokenStore) {
    // Deduplicate by email if available
    if (newToken.email) {
      const idx = this.tokens.findIndex((t) => t.email === newToken.email);
      if (idx >= 0) {
        this.tokens[idx] = { ...this.tokens[idx], ...newToken };
      } else {
        this.tokens.push(newToken);
      }
    } else {
      const idx = this.tokens.findIndex((t) => t.refresh_token === newToken.refresh_token);
      if (idx >= 0) {
        this.tokens[idx] = { ...this.tokens[idx], ...newToken };
      } else {
        this.tokens.push(newToken);
      }
    }
    this.save();
  }

  public removeToken(email: string) {
    this.tokens = this.tokens.filter((t) => t.email !== email);
    this.save();
  }

  /**
   * Mark an account as rate limited for a duration and PERSIST it.
   */
  public reportRateLimit(email: string, durationMs = 60000) {
    const idx = this.tokens.findIndex((t) => t.email === email);
    const token = this.tokens[idx];
    if (idx >= 0 && token) {
      token.rate_limited_until = Date.now() + durationMs;
      this.save(); // Persist the penalty
      const until = token.rate_limited_until;
      const untilText = until ? new Date(until).toLocaleTimeString() : "unknown";
      console.log(`[TokenPool] Account ${email} backed off until ${untilText}`);
    }
  }

  /**
   * Get a usable access token, refreshing if necessary.
   * Strategy: Filter out constrained -> Sort by last_used (LRU) -> Pick first
   */
  public async getAccessToken(
    excludedEmails: Set<string> = new Set(),
  ): Promise<{ token: string; project_id: string; email: string }> {
    if (this.tokens.length === 0) {
      throw new Error("No accounts logged in. Please login first.");
    }

    const now = Date.now();

    // 1. Filter candidates
    const candidates = this.tokens.filter((t) => {
      // Exclude explicitly ignored (e.g. failed in this request loop)
      if (t.email && excludedEmails.has(t.email)) return false;

      // Exclude rate limited (persisted)
      if (t.rate_limited_until && t.rate_limited_until > now) return false;

      return true;
    });

    if (candidates.length === 0) {
      // If all are excluded or rate limited, decide fallback.
      // If excludedEmails is populated, it means we tried some and failed.
      // If all are rate limited, we might just have to wait or pick the soonest one?
      // Current behavior: Throw to trigger upstream backoff or failure.
      throw new Error("All accounts are currently unavailable (rate limited or excluded).");
    }

    // 2. Selection: Least Recently Used (sort by last_used ASC)
    // Undefined last_used counts as 0 (very old)
    candidates.sort((a, b) => (a.last_used || 0) - (b.last_used || 0));

    const selectedToken = candidates[0]; // Pick the stale-est one

    if (!selectedToken) {
      throw new Error("Unexpected error: No token selected.");
    }

    // 3. Mark usage immediate (optimistic) to rotate for next parallel call
    selectedToken.last_used = now;
    this.save(); // Persist usage stats

    // 4. Check for missing Project ID and try to heal
    if (!selectedToken.project_id) {
      try {
        // Dynamic import to break cycle
        const { fetchProjectID } = await import("./auth");
        console.log(`[TokenPool] Healing missing Project ID for ${selectedToken.email}...`);
        const pid = await fetchProjectID(selectedToken.access_token);
        if (pid) {
          selectedToken.project_id = pid;
          this.addToken(selectedToken); // Save
        }
      } catch (e) {
        console.warn(`[TokenPool] Failed to heal Project ID for ${selectedToken.email}`, e);
      }
    }

    // 5. Refresh if needed
    if (selectedToken.expires_at - now < 30000) {
      // 30s buffer
      try {
        const refreshed = await this.refreshToken(selectedToken);
        this.addToken(refreshed);
        return {
          token: refreshed.access_token,
          project_id: refreshed.project_id || "",
          email: refreshed.email || "",
        };
      } catch (e) {
        console.error(`Token refresh failed for ${selectedToken.email}. Removing.`);
        this.removeToken(selectedToken.email || "");
        // Recursive retry with the rest
        return this.getAccessToken(excludedEmails);
      }
    }

    return {
      token: selectedToken.access_token,
      project_id: selectedToken.project_id || "",
      email: selectedToken.email || "",
    };
  }

  private async refreshToken(token: TokenStore): Promise<TokenStore> {
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

    if (!res.ok) {
      // If 400 invalid_grant, token is dead
      if (res.status === 400) {
        throw new Error("Invalid Refresh Token");
      }
      throw new Error(`Refresh failed: ${await res.text()}`);
    }
    const data = (await res.json()) as AntigravityTokenResponse;

    return {
      ...token,
      access_token: data.access_token,
      expires_at: Date.now() + data.expires_in * 1000,
      refresh_token: data.refresh_token || token.refresh_token,
    };
  }
}

// Singleton Instance
export const tokenPool = new TokenPool();
