import { TokenMeterBadge } from "./Badge";
import { zh, en } from "./locales";

/** Dictionary namespace owned by this plugin (design §4.2). */
export const NS = "composer-tokens";

/** Required services (design §4.1: slots / sessions / locale). */
export const inject = ["slots", "sessions", "locale"];

/**
 * Resolve the per-session input-trigger controller for reference
 * serialization (send-path codec, design §4.4). Every failure degrades to
 * undefined — the badge then counts the display text with a `~` marker.
 */
function resolveController(ctx: { get(name: string): unknown }, sessionId: string): unknown {
  try {
    const sessions = ctx.get("sessions") as { scope(id: string): { effect(fn: () => void, id: string): unknown } | undefined } | undefined;
    const inputTriggers = ctx.get("inputTriggers") as { sessionOf(actx: unknown): unknown } | undefined;
    if (sessions === undefined || inputTriggers === undefined) return undefined;
    const actx = sessions.scope(sessionId);
    if (actx === undefined) return undefined;
    return inputTriggers.sessionOf(actx);
  } catch {
    return undefined;
  }
}

/**
 * Client plugin body: register the zh/en dictionaries and mount the token
 * badge into the composer input's inline right seat.
 */
export function apply(ctx: {
  get(name: string): unknown;
  effect(fn: () => unknown, label: string): unknown;
  locale: { register(ns: string, dicts: object): unknown };
  slots: {
    inject(name: string, register: () => unknown): unknown;
    register(
      entry: {
        name: string;
        id: string;
        order: number;
        locale: string;
        inject(sessionId: string): object;
      },
      component: unknown
    ): unknown;
  };
}) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "composer-tokens: dictionaries");
  ctx.slots.inject("conversation.input.right", () =>
    ctx.slots.register(
      {
        name: "conversation.input.right",
        id: "composer-tokens",
        order: 10,
        locale: NS,
        inject: (sessionId) => ({
          api: (ctx.get("connection") as { api?: object } | undefined)?.api,
          controller: resolveController(ctx, sessionId),
        }),
      },
      TokenMeterBadge
    )
  );
}