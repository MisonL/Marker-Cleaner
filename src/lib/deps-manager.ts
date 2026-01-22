import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";

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
      // @ts-ignore
      await import("sharp");
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Detect available package manager
   */
  detectPackageManager(): PackageManager {
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
   * Install sharp using available package manager
   */
  installSharp(): Promise<void> {
    return new Promise((resolve, reject) => {
      const pm = this.detectPackageManager();
      if (!pm) {
        reject(new Error("No package manager (npm/bun) found. Please install Node.js first."));
        return;
      }

      const cmd = pm;
      const args = pm === "npm" ? ["install", "sharp"] : ["add", "sharp"];

      console.log(`Installing sharp using ${pm}...`);

      // Ensure package.json exists, otherwise bundlers might fail or warn
      if (!existsSync("package.json")) {
        try {
           execSync(`${pm} init -y`, { stdio: "ignore" });
        } catch (e) {
           // Ignore init errors, try to proceed
        }
      }

      const child = spawn(cmd, args, {
        stdio: "inherit",
        shell: true,
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Installation failed with code ${code}`));
        }
      });

      child.on("error", (err) => {
        reject(err);
      });
    });
  }
}
