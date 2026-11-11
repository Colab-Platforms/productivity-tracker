import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { guardUuidParams, isBadInput } from "../../lib/params.js";
import * as chat from "./chat.service.js";

const router = Router();
guardUuidParams(router, ["id", "userId", "messageId"]);

// Every service error code needs an entry here, otherwise it becomes a 500.
const MESSAGES: Record<string, { status: number; message: string }> = {
  FEATURES_NOT_READY: { status: 503, message: "Chat isn't switched on for this system yet." },
  USER_NOT_FOUND: { status: 404, message: "User not found." },
  NOT_FOUND: { status: 404, message: "That conversation was not found." },
  PERSON_NOT_FOUND: { status: 400, message: "Everyone chosen must be an active person." },
  PERSON_REQUIRED: { status: 400, message: "Choose at least one person." },
  TITLE_REQUIRED: { status: 400, message: "Give the group a name." },
  TITLE_TOO_LONG: { status: 400, message: "Keep the group name under 80 characters." },
  TITLE_INVALID: { status: 400, message: "The group name must be text." },
  TOO_MANY_MEMBERS: { status: 400, message: "A group can have at most 100 people." },
  MESSAGE_EMPTY: { status: 400, message: "Type a message first." },
  MESSAGE_TOO_LONG: { status: 400, message: "Keep a message under 4000 characters." },
  SENDING_TOO_FAST: { status: 429, message: "You are sending too fast. Wait a moment." },
  NOT_YOURS: { status: 403, message: "You can only change your own messages." },
  REPLY_NOT_FOUND: { status: 400, message: "The message you are replying to was not found in this chat." },
  BAD_EMOJI: { status: 400, message: "That reaction is not available." },
  MESSAGE_DELETED: { status: 409, message: "That message was deleted." },
  EDIT_WINDOW_PASSED: { status: 409, message: "A message can be edited for 15 minutes after it is sent." },
  NOT_ADMIN: { status: 403, message: "Only a group admin can do that." },
  DIRECT_CANT_CHANGE: { status: 400, message: "A one-to-one chat has no members to change." },
  BAD_CURSOR: { status: 400, message: "That page marker is not valid." },
};

function fail(res: Response, error: unknown) {
  if (isBadInput(error)) {
    res.status(400).json({ error: "One of the values sent is not valid." });
    return;
  }
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const known = MESSAGES[code];
  if (known) return res.status(known.status).json({ error: known.message });
  console.error("Chat error:", error);
  return res.status(500).json({ error: "Something went wrong" });
}

const run = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    fail(res, e);
  }
};
const uid = (req: Request) => req.user!.userId;

router.use(requireAuth);

router.get("/people", run((req) => chat.people(uid(req), req.query.q)));
router.get("/unread", run((req) => chat.unreadTotal(uid(req))));
router.get("/conversations", run((req) => chat.listConversations(uid(req))));
router.post("/conversations", run((req) => chat.openConversation(uid(req), req.body ?? {})));
router.get("/conversations/:id/messages", run((req) => chat.getMessages(uid(req), String(req.params.id), req.query.before)));
router.post("/conversations/:id/messages", run((req) => chat.sendMessage(uid(req), String(req.params.id), req.body ?? {})));
router.delete("/conversations/:id/messages/:messageId", run((req) => chat.deleteMessage(uid(req), String(req.params.id), String(req.params.messageId))));
router.patch("/conversations/:id/messages/:messageId", run((req) => chat.editMessage(uid(req), String(req.params.id), String(req.params.messageId), req.body ?? {})));
router.post("/conversations/:id/messages/:messageId/reactions", run((req) => chat.toggleReaction(uid(req), String(req.params.id), String(req.params.messageId), req.body ?? {})));
router.post("/conversations/:id/read", run((req) => chat.markRead(uid(req), String(req.params.id))));
router.patch("/conversations/:id", run((req) => chat.renameGroup(uid(req), String(req.params.id), req.body ?? {})));
router.post("/conversations/:id/members", run((req) => chat.addMembers(uid(req), String(req.params.id), req.body ?? {})));
router.delete("/conversations/:id/members/:userId", run((req) => chat.removeMember(uid(req), String(req.params.id), String(req.params.userId))));

export default router;
