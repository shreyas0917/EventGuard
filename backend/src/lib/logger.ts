export const logger = {
  info: (msg: string, data?: any) => {
    console.log(`[INFO] ${msg}`, data ? JSON.stringify(data) : "");
  },
  error: (msg: string, err?: any) => {
    console.error(`[ERROR] ${msg}`, err ? err.message || err : "");
  },
  warn: (msg: string, data?: any) => {
    console.warn(`[WARN] ${msg}`, data ? JSON.stringify(data) : "");
  },
  debug: (msg: string, data?: any) => {
    if (process.env.NODE_ENV === "development") {
      console.log(`[DEBUG] ${msg}`, data ? JSON.stringify(data) : "");
    }
  },
};
