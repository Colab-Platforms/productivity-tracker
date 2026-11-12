import type { Request } from "express";

// The caller's address. With `trust proxy` set in server.ts, Express reads it from the proxy's X-Forwarded-For
// safely (counting hops from the proxy side), so a client cannot invent one by sending its own header.
export function clientIp(req: Request): string | null {
  return req.ip || req.socket?.remoteAddress || null;
}
