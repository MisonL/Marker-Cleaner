import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config-manager";
import open from "open";
import type { Logger } from "./types";

const LOG_FILE = "debug.log";
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_LOG_FILES = 7; // Keep last 7 logs

class LogManager {
  private logPath: string;
  private logDir: string;

  constructor() {
    this.logDir = getConfigDir();
    this.logPath = join(this.logDir, LOG_FILE);
    this.init();
  }

  private init() {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
    this.rotateIfNeeded();
    this.cleanOldLogs();
  }

  private rotateIfNeeded() {
    if (existsSync(this.logPath)) {
      const stats = statSync(this.logPath);
      if (stats.size > MAX_LOG_SIZE) {
        const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
        const newPath = join(this.logDir, `debug_${timestamp}.log`);
        renameSync(this.logPath, newPath);
      }
    }
  }

  private cleanOldLogs() {
    try {
      const files = readdirSync(this.logDir)
        .filter(f => f.startsWith("debug_") && f.endsWith(".log"))
        .map(f => ({ name: f, time: statSync(join(this.logDir, f)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time); // Newest first

      if (files.length > MAX_LOG_FILES) {
        files.slice(MAX_LOG_FILES).forEach(f => {
          unlinkSync(join(this.logDir, f.name));
        });
      }
    } catch (error) {
      console.error("Failed to clean old logs:", error);
    }
  }

  public write(level: string, message: string) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}\n`;
    try {
        if (!existsSync(this.logPath)) {
            writeFileSync(this.logPath, "", "utf-8");
        }
        appendFileSync(this.logPath, line, "utf-8");
    } catch (e) {
        console.error("Failed to write log:", e);
    }
  }

  public openLogFolder() {
    open(this.logDir);
  }
}

const logManager = new LogManager();

export function createLogger(debug: boolean): Logger & { openLogFolder: () => void } {
  return {
    info(message: string) {
      console.log(`ℹ️  ${message}`);
      logManager.write("INFO", message);
    },
    warn(message: string) {
      console.log(`⚠️  ${message}`);
      logManager.write("WARN", message);
    },
    error(message: string) {
      console.error(`❌ ${message}`);
      logManager.write("ERROR", message);
    },
    debug(message: string) {
      if (debug) {
        console.log(`🔍 ${message}`);
      }
      logManager.write("DEBUG", message);
    },
    openLogFolder() {
      logManager.openLogFolder();
    }
  };
}
