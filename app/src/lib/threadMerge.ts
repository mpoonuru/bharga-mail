import type { Thread } from "@/types";

/**
 * The conversation list comes from the core without message bodies (bodies load
 * on open, see `hydrateThread`). A list refresh must therefore not replace bodies
 * that are already loaded: a message's body never changes for the same message
 * id, so it is carried over from the previous list. Messages that are new since
 * the last load stay empty until the conversation is hydrated again.
 */
export function keepLoadedBodies(fresh: Thread[], previous: Thread[]): Thread[] {
  const loaded = new Map<string, string>();
  for (const thread of previous) {
    for (const message of thread.messages) {
      if (message.bodyHtml) loaded.set(`${thread.id}\u0000${message.id}`, message.bodyHtml);
    }
  }
  if (loaded.size === 0) return fresh;
  return fresh.map((thread) => {
    let changed = false;
    const messages = thread.messages.map((message) => {
      if (message.bodyHtml) return message;
      const body = loaded.get(`${thread.id}\u0000${message.id}`);
      if (!body) return message;
      changed = true;
      return { ...message, bodyHtml: body };
    });
    return changed ? { ...thread, messages } : thread;
  });
}

/** True when some message of the thread has no body loaded yet. */
export function needsBodies(thread: Thread): boolean {
  return thread.messages.some((message) => !message.bodyHtml);
}

/** Identity of a thread's message set: changes when a message arrives or leaves. */
export function messageSignature(thread: Thread): string {
  return thread.messages.map((message) => message.id).join("\u0000");
}
