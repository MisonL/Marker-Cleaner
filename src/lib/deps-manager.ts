import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module"; 
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execSync, spawn } from "node:child_process";

export type PackageManager = "npm" | "bun" | "pnpm" | "yarn" | null;

export class DependencyManager {
  private static instance: DependencyManager;

  private constructor() {}

  static getInstance(): DependencyManager {
    if (!DependencyManager.instance) {
      DependencyManager.instance = new DependencyManager();
    }
    return DependencyManager.instance;
  }

  /**
   * Check if sharp is available by trying to require it
   */
  async checkSharp(): Promise<boolean> {
    try {
      // First try standard import (dev environment/bundled)
      // @ts-ignore
      await import("sharp");
      return true;
    } catch (e) {
      // Then try local deps folder
      try {
        const depsDir = this.getDepsDir();
        // Create a require function anchored in the deps directory
        // We point it to a file inside deps so resolution works from there
        const customRequire = createRequire(join(depsDir, "package.json")); 
        customRequire("sharp");
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  /**
   * Resolve sharp module for usage
   */
  async loadSharp(): Promise<any> {
    try {
      // @ts-ignore
      return await import("sharp");
    } catch {
      const depsDir = this.getDepsDir();
      const customRequire = createRequire(join(depsDir, "package.json"));
      return customRequire("sharp");
    }
  }

  private getDepsDir(): string {
    return join(process.cwd(), "deps");
  }

  private getLocalSharpPath(): string {
    return join(this.getDepsDir(), "node_modules", "sharp");
  }

  /**
   * Detect available package manager
   */
  detectPackageManager(): PackageManager {
    // On Windows, prefer npm over bun for native builds if available, as bun on windows is experimental
    const isWin = process.platform === "win32";

    if (isWin) {
      try {
        execSync("npm --version", { stdio: "ignore" });
        return "npm";
      } catch {}
    }

    try {
      execSync("bun --version", { stdio: "ignore" });
      return "bun";
    } catch {}

    try {
      execSync("npm --version", { stdio: "ignore" });
      return "npm";
    } catch {}

    return null;
  }

  /**
   * Install sharp using available package manager into ./deps
   */
  installSharp(onLog?: (msg: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const pm = this.detectPackageManager();
      if (!pm) {
        reject(new Error("No package manager (npm/bun) found. Please install Node.js first."));
        return;
      }

      const depsDir = this.getDepsDir();
      
      // 1. Create deps dir if not exists
      if (!existsSync(depsDir)) {
        mkdirSync(depsDir, { recursive: true });
      }

      // 2. Create minimal package.json if not exists (Avoids 'init' clutter)
      const pkgJsonPath = join(depsDir, "package.json");
      if (!existsSync(pkgJsonPath)) {
        writeFileSync(pkgJsonPath, JSON.stringify({
          name: "marker-cleaner-deps",
          version: "1.0.0",
          private: true,
          description: "Auto-generated dependencies for Marker Cleaner Runtime",
          license: "UNLICENSED"
        }, null, 2));
      }

      const cmd = pm;
      // Force npm on Windows to use cmd shim if needed, but exec/spawn usually handles it. 
      // Safest to just run the command name if it's in PATH.
      
      const args = pm === "npm" ? ["install", "sharp"] : ["add", "sharp"];

      console.log(`Installing sharp using ${pm} in ${depsDir}...`);
      onLog?.(`🔥 Starting installation with ${pm}...`);

      const child = spawn(cmd, args, {
        stdio: "pipe", // Capture output
        shell: true,
        cwd: depsDir, 
      });

      child.stdout?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (line.trim()) onLog?.(line.trim().slice(0, 60)); // Limit length
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
           if (line.trim()) onLog?.(line.trim().slice(0, 60));
        }
      });

      child.on("close", (code: number) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Installation failed with code ${code}`));
        }
      });

      child.on("error", (err: Error) => {
        reject(err);
      });
    });
  }
}
