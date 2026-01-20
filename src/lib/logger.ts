import { appendFileSync, existsSync, writeFileSync } from "fs";
import type { Logger } from "./types";

const LOG_FILE = "debug.log";

export function createLogger(debug: boolean): Logger {
  const timestamp = () => new Date().toISOString();

  const writeToFile = (level: string, message: string) => {
    if (debug) {
      const line = `[${timestamp()}] [${level}] ${message}\n`;
      if (!existsSync(LOG_FILE)) {
        writeFileSync(LOG_FILE, "", "utf-8");
      }
      appendFileSync(LOG_FILE, line, "utf-8");
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
