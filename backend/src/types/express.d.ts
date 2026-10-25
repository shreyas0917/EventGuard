import "express";

declare global {
  namespace Express {
    interface Request {
      /** Original HTTP body bytes captured by express.json verify callback */
      rawBody?: Buffer;
    }
  }
}

export {};
