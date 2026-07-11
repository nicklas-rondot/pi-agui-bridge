import { randomBytes } from "node:crypto";
import type { AuthValidationResult, AuthorizedSession } from "./types.js";
import { DEFAULT_TOKEN_TTL_MS } from "./types.js";

export class AuthManager {
  private readonly sessions = new Map<string, AuthorizedSession>();
  private readonly tokenTtlMs: number;

  constructor(tokenTtlMs = DEFAULT_TOKEN_TTL_MS) {
    this.tokenTtlMs = tokenTtlMs;
  }

  issue(origin: string, clientName?: string): AuthorizedSession {
    this.pruneExpired();
    const token = randomBytes(24).toString("hex");
    const now = Date.now();
    const session: AuthorizedSession = {
      token,
      origin,
      clientName,
      createdAt: now,
      expiresAt: now + this.tokenTtlMs,
    };

    this.sessions.set(token, session);
    return session;
  }

  validate(token: string | undefined, origin: string | undefined): AuthValidationResult {
    this.pruneExpired();

    if (!token) {
      return {
        ok: false,
        status: 401,
        error: "Missing bearer token.",
      };
    }

    const session = this.sessions.get(token);
    if (!session) {
      return {
        ok: false,
        status: 401,
        error: "Invalid or expired token.",
      };
    }

    if (origin) {
      const normalizedOrigin = normalizeOrigin(origin);
      if (!normalizedOrigin) {
        return {
          ok: false,
          status: 400,
          error: "Invalid Origin header.",
        };
      }

      if (normalizedOrigin !== session.origin) {
        return {
          ok: false,
          status: 403,
          error: `Token is not valid for origin ${normalizedOrigin}.`,
        };
      }
    }

    return {
      ok: true,
      status: 200,
      session,
    };
  }

  clear(): void {
    this.sessions.clear();
  }

  revoke(token: string): void {
    this.sessions.delete(token);
  }

  count(): number {
    this.pruneExpired();
    return this.sessions.size;
  }

  list(): AuthorizedSession[] {
    this.pruneExpired();
    return Array.from(this.sessions.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(token);
      }
    }
  }
}

export function normalizeOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;

  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }

    return parsed.origin;
  } catch {
    return undefined;
  }
}

export function extractBearerToken(headers: Record<string, string | string[] | undefined>, queryToken: string | null): string | undefined {
  const authHeader = headers.authorization;
  const rawHeader = Array.isArray(authHeader) ? authHeader[0] : authHeader;

  if (rawHeader?.startsWith("Bearer ")) {
    return rawHeader.slice("Bearer ".length).trim();
  }

  if (queryToken && queryToken.trim()) {
    return queryToken.trim();
  }

  return undefined;
}
