import { appendFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import type { Logger } from "./types";
import { getConfigDir } from "./config-manager";

const LOG_FILE = "debug.log";

export function createLogger(debug: boolean): Logger {
  const timestamp = () => new Date().toISOString();
  const logPath = join(getConfigDir(), LOG_FILE);

  const writeToFile = (level: string, message: string) => {
    if (debug) {
      const line = `[${timestamp()}] [${level}] ${message}\n`;
      if (!existsSync(logPath)) {
        writeFileSync(logPath, "", "utf-8");
      }
      appendFileSync(logPath, line, "utf-8");
    }
  };

  return {
    info(message: string) {
      console.log(`ℹ️  ${message}`);
      writeToFile("INFO", message);
    },
    warn(message: string) {
      console.log(`⚠️  ${message}`);
      writeToFile("WARN", message);
    },
    error(message: string) {
      console.error(`❌ ${message}`);
      writeToFile("ERROR", message);
    },
    debug(message: string) {
      if (debug) {
        console.log(`🔍 ${message}`);
      }
      writeToFile("DEBUG", message);
    },
  };
}
