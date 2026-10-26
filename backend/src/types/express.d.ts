import "express";
import type { AuthContext } from "../lib/auth.js";

declare global {
  namespace Express {
    interface Request {
      /** Original HTTP body bytes captured by express.json verify callback */
      rawBody?: Buffer;
      /** Verified identity from the bearer token, set by the authenticate middleware */
      auth?: AuthContext;
    }
  }
}

export {};
