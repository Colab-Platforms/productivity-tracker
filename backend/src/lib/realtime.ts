// ===========================================================================
// REAL-TIME (Socket.IO)
//
// What it does: when a task changes, everyone who is allowed to see that task's owner is told "something
// changed" and their page re-asks the normal API. The socket carries a SIGNAL, never task content, so the
// database stays the single source of truth and no sensitive data travels over it.
//
// Who hears what — decided on the SERVER, never by the client:
//   * a socket is authenticated with the same bearer token as the REST API (handshake `auth.token`), and the
//     live user row is checked exactly as `requireAuth` does (suspended / exited / closed company / wrong
//     pinned company are refused);
//   * each socket is put into one room per PERSON whose task events it may receive:
//       employee            -> only themselves
//       manager / HR / admin -> the people the existing `manageableUserIds` rule gives them (plus themselves)
//   * a client cannot join, leave or name a room. The only thing it may send is `resync` ("recompute my rooms"),
//     which takes no arguments, is rate-limited, and is answered from the database again;
//   * rights are re-checked every few minutes, so a suspended or demoted user is cut off without waiting for a
//     token to expire.
//
// If the socket is down the pages keep working: they fall back to ordinary polling (see the frontend hook).
// One backend instance needs no adapter. With several instances behind a load balancer, add the Redis adapter
// (`@socket.io/redis-adapter`) so events reach sockets connected to another instance.
// ===========================================================================

import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server, type Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { prisma } from "./prisma.js";
import { getPinnedCompany } from "./deployment.js";

export type TaskAction = "created" | "assigned" | "updated" | "status" | "approved" | "rejected" | "graded" | "reverted" | "deleted";

// The ONLY payload that ever leaves the server for tasks. No titles, notes, names or counts.
export type TaskChange = {
  eventId: string; // unique, so a client can ignore a duplicate delivery
  taskId: string;
  ownerId: string; // whose task it is (the person the room is named after)
  action: TaskAction;
  at: string; // ISO time the change was committed
};

export type SocketUser = { userId: string; role: string; platformId: string };

export type RealtimeDeps = {
  // null = not allowed in. The default checks the JWT and the live user row, like requireAuth.
  authenticate?: (token: string) => Promise<SocketUser | null>;
  // The people whose task events this user may receive.
  personsFor: (user: SocketUser) => Promise<string[]>;
  origins: string[];
  recheckEveryMs?: number;
};

let io: Server | null = null;

export const roomOf = (personId: string) => `person:${personId}`;
// A room only the person themselves is in (joined by the server, never by the client). Notification signals go
// here and nowhere else, so a manager who can see an employee's tasks does NOT learn that the employee got a notification.
export const inboxRoom = (userId: string) => `inbox:${userId}`;

// Same checks as middlewares/auth.ts, for a token string.
async function defaultAuthenticate(token: string): Promise<SocketUser | null> {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET as string) as { userId?: string };
    if (!payload?.userId) return null;
    const live = await prisma.user.findUnique({
      where: { id: String(payload.userId) },
      select: { status: true, role: true, platformId: true, platform: { select: { isActive: true } } },
    });
    if (!live || live.status === "SUSPENDED" || live.status === "EXITED") return null;
    if (live.platform && !live.platform.isActive) return null;
    const pinned = await getPinnedCompany();
    if (pinned && live.platformId !== pinned.id) return null;
    return { userId: String(payload.userId), role: String(live.role), platformId: live.platformId };
  } catch {
    return null; // bad / expired token, or the pinned company is missing: all look the same to the caller
  }
}

// Make the socket's rooms equal to exactly what the server says it may see (joins the missing, leaves the rest).
async function syncRooms(socket: Socket, deps: RealtimeDeps, user: SocketUser) {
  const allowed = new Set((await deps.personsFor(user)).concat(user.userId).map(roomOf));
  for (const room of socket.rooms) {
    if (room !== socket.id && room.startsWith("person:") && !allowed.has(room)) await socket.leave(room);
  }
  for (const room of allowed) if (!socket.rooms.has(room)) await socket.join(room);
  socket.data.roomCount = allowed.size;
}

export function startRealtime(httpServer: HttpServer, deps: RealtimeDeps): Server {
  const authenticate = deps.authenticate ?? defaultAuthenticate;

  io = new Server(httpServer, {
    cors: { origin: deps.origins, credentials: true },
    transports: ["websocket", "polling"], // polling only as a fallback for networks that block websockets
    maxHttpBufferSize: 1e4, // nothing useful ever arrives from a client, so keep the door small
    connectTimeout: 10_000,
  });

  // 1. Authenticate before anything else. The token is read from the handshake, never from a URL.
  io.use(async (socket, next) => {
    const token = typeof socket.handshake.auth?.token === "string" ? socket.handshake.auth.token : "";
    const user = token ? await authenticate(token) : null;
    if (!user) return next(new Error("NOT_AUTHENTICATED"));
    socket.data.user = user;
    socket.data.token = token;
    next();
  });

  io.on("connection", async (socket) => {
    const user = socket.data.user as SocketUser;
    try {
      await syncRooms(socket, deps, user);
      await socket.join(inboxRoom(user.userId));
      socket.emit("ready", { rooms: socket.data.roomCount as number });
    } catch {
      socket.disconnect(true);
      return;
    }

    // The ONLY client->server message: "recompute my rooms". No arguments are read, at most once per 5 seconds.
    let last = 0;
    socket.on("resync", async () => {
      if (Date.now() - last < 5000) return;
      last = Date.now();
      try {
        const fresh = await authenticate(socket.data.token as string);
        if (!fresh) return socket.disconnect(true);
        socket.data.user = fresh;
        await syncRooms(socket, deps, fresh);
        socket.emit("ready", { rooms: socket.data.roomCount as number });
      } catch {
        /* keep the existing rooms; the next resync will retry */
      }
    });
    // Everything else a client sends is ignored: there is no join/leave/subscribe message to abuse.
  });

  // 2. Periodic re-check: a suspended, demoted or moved user loses access without waiting for token expiry.
  const timer = setInterval(async () => {
    if (!io) return;
    for (const socket of await io.fetchSockets()) {
      try {
        const fresh = await authenticate(socket.data.token as string);
        if (!fresh) socket.disconnect(true);
      } catch {
        /* try again next round */
      }
    }
  }, deps.recheckEveryMs ?? 3 * 60_000);
  timer.unref();

  return io;
}

export async function stopRealtime() {
  if (io) await io.close();
  io = null;
}

// Called by the task service AFTER the database write has succeeded. Never throws, so a socket problem can
// never fail a task save. A no-op when real-time is not running (scripts, tests, a server started without it).
export function emitTaskChange(change: { taskId: string; ownerId: string; action: TaskAction }): void {
  try {
    if (!io) return;
    const payload: TaskChange = { eventId: randomUUID(), taskId: change.taskId, ownerId: change.ownerId, action: change.action, at: new Date().toISOString() };
    io.to(roomOf(change.ownerId)).emit("tasks:changed", payload);
  } catch (e) {
    console.error("[realtime] emit failed:", e instanceof Error ? e.message : e);
  }
}

// Policies. Same connection, same person-based rooms, same rule: the signal carries NO content (no titles, no
// names, no counts) and a page that hears it simply asks the normal API again. `userIds` are the people the
// change concerns (a policy's audience, or the person who just acknowledged); anyone whose rights include those
// people (HR/Admin of the company) is in their rooms already. Never throws, and a no-op when real-time is off.
export type PolicyAction = "published" | "updated" | "archived" | "restored" | "acknowledged" | "draft";
export type PolicyChange = { eventId: string; policyId: string; action: PolicyAction; at: string };

export function emitPolicyChange(change: { userIds: string[]; policyId: string; action: PolicyAction }): void {
  try {
    if (!io || change.userIds.length === 0) return;
    const payload: PolicyChange = { eventId: randomUUID(), policyId: change.policyId, action: change.action, at: new Date().toISOString() };
    io.to([...new Set(change.userIds)].map(roomOf)).emit("policies:changed", payload);
  } catch (e) {
    console.error("[realtime] policy emit failed:", e instanceof Error ? e.message : e);
  }
}

// Notifications. The signal carries NO content: the page that hears it asks the normal API for its own inbox.
// Goes only to each recipient's private inbox room. Never throws; a no-op when real-time is off.
export type NotificationSignal = { eventId: string; at: string };

// In-person meeting participation changed (someone joined, ended, or a manager corrected a record). Goes ONLY to the
// private inbox rooms of the people named (the organizer and the person concerned), never to managers or HR who can
// merely see that person, so HR learns nothing about who is in a stand-up. The signal carries no names or times;
// the screen refetches over REST, which enforces who may see what.
export type MeetingSignal = { eventId: string; at: string; meetingId: string };

export function emitMeetingChange(userIds: string[], meetingId: string): void {
  try {
    if (!io || userIds.length === 0) return;
    const payload: MeetingSignal = { eventId: randomUUID(), at: new Date().toISOString(), meetingId };
    io.to([...new Set(userIds)].map(inboxRoom)).emit("meetings:changed", payload);
  } catch (e) {
    console.error("[realtime] meeting emit failed:", e instanceof Error ? e.message : e);
  }
}

export function emitNotificationChange(userIds: string[]): void {
  try {
    if (!io || userIds.length === 0) return;
    const payload: NotificationSignal = { eventId: randomUUID(), at: new Date().toISOString() };
    io.to([...new Set(userIds)].map(inboxRoom)).emit("notifications:changed", payload);
  } catch (e) {
    console.error("[realtime] notification emit failed:", e instanceof Error ? e.message : e);
  }
}
