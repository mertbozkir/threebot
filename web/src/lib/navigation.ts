import type { Bot } from "./types";
import type { Dialog } from "../store";

export type Navigation =
  | { view: "list" }
  | { view: "chat"; slug: string; threadId: string | null }
  | { view: "exchange"; slug: string; threadId: string | null; otherSlug: string }
  | { view: "projects"; itemId: string | null }
  | { view: "map" }
  | { view: "room"; roomId: string }
  | { view: "overlay"; slug: string | null; threadId: string | null; details: boolean; dialog: Dialog };

type RouteState = { selected: string | null; selectedThreadId: string | null; exchangeBotSlug: string | null; detailsOpen: boolean; dialog: Dialog; page?: "projects" | "map" | "room" | null; projectItemId?: string | null; selectedRoom?: string | null };

export function navigationFor(state: RouteState, narrow: boolean): Navigation {
  if (state.dialog === "search" || (narrow && (state.dialog || (state.detailsOpen && state.selected && state.page !== "room")))) return { view: "overlay", slug: state.selected, threadId: state.selectedThreadId, details: state.detailsOpen, dialog: state.dialog };
  if (state.page === "room" && state.selectedRoom) return { view: "room", roomId: state.selectedRoom };
  if (state.page === "map") return { view: "map" };
  if (state.page === "projects") return { view: "projects", itemId: state.projectItemId ?? null };
  if (!state.selected) return { view: "list" };
  return state.exchangeBotSlug
    ? { view: "exchange", slug: state.selected, threadId: state.selectedThreadId, otherSlug: state.exchangeBotSlug }
    : { view: "chat", slug: state.selected, threadId: state.selectedThreadId };
}

export function navigationUrl(route: Navigation, pathname: string) {
  const query = new URLSearchParams();
  if (route.view === "room") query.set("room", route.roomId);
  else if (route.view === "map") query.set("page", "map");
  else if (route.view === "projects") {
    if (route.itemId) query.set("item", route.itemId);
    else query.set("page", "projects");
  } else if (route.view !== "list") {
    if (route.slug) query.set("bot", route.slug);
    if (route.threadId) query.set("thread", route.threadId);
    if (route.view === "exchange") query.set("exchange", route.otherSlug);
  }
  return `${pathname}${query.size ? `?${query}` : ""}`;
}

function isDialog(value: unknown): value is Dialog {
  if (value === null || value === "new-bot" || value === "adopt-project" || value === "settings" || value === "search" || value === "connect-apps") return true;
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === "connect-apps") return "url" in value && typeof value.url === "string";
  if (value.kind === "room") return !("id" in value) || value.id === undefined || typeof value.id === "string";
  if (value.kind === "main-bot") {
    if ("initialSlug" in value && value.initialSlug !== undefined && typeof value.initialSlug !== "string") return false;
    if (!("intent" in value) || typeof value.intent !== "object" || value.intent === null || !("kind" in value.intent)) return false;
    const intent = value.intent;
    return intent.kind === "replace" || ((intent.kind === "hide" || intent.kind === "delete") && "slug" in intent && typeof intent.slug === "string");
  }
  return (value.kind === "delete-bot" || value.kind === "rename-bot" || value.kind === "computer") && "slug" in value && typeof value.slug === "string";
}

/** Browser history is external data, including entries from older builds. */
export function readNavigation(value: unknown): Navigation | null {
  if (typeof value !== "object" || value === null || !("view" in value)) return null;
  if (value.view === "list") return { view: "list" };
  if (value.view === "map") return { view: "map" };
  if (value.view === "projects") return "itemId" in value && (value.itemId === null || (typeof value.itemId === "string" && /^[a-z0-9]{4,24}$/.test(value.itemId))) ? { view: "projects", itemId: value.itemId } : null;
  if (value.view === "room") return "roomId" in value && typeof value.roomId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.roomId) ? { view: "room", roomId: value.roomId } : null;
  if (!("slug" in value) || !("threadId" in value) || (value.threadId !== null && typeof value.threadId !== "string")) return null;
  if (value.view === "overlay" && (value.slug === null || typeof value.slug === "string") && "dialog" in value && isDialog(value.dialog) && "details" in value && typeof value.details === "boolean") return { view: "overlay", slug: value.slug, threadId: value.threadId, dialog: value.dialog, details: value.details };
  if (typeof value.slug !== "string") return null;
  if (value.view === "chat") return { view: "chat", slug: value.slug, threadId: value.threadId };
  if (value.view === "exchange" && "otherSlug" in value && typeof value.otherSlug === "string") return { view: "exchange", slug: value.slug, threadId: value.threadId, otherSlug: value.otherSlug };
  return null;
}

export function restoreNavigation(route: Navigation, bots: Record<string, Bot>) {
  if (route.view === "room") return { page: "room" as const, selectedRoom: route.roomId, projectItemId: null, exchangeBotSlug: null, dialog: null, detailsOpen: false };
  if (route.view === "map") return { page: "map" as const, projectItemId: null, exchangeBotSlug: null, dialog: null, detailsOpen: false };
  if (route.view === "projects") return { page: "projects" as const, projectItemId: route.itemId, exchangeBotSlug: null, dialog: null };
  const selected = route.view !== "list" && route.slug && bots[route.slug] ? route.slug : null;
  // A "new room" dialog has no id and is not a destination: restoring it after a history pop left the
  // create form open on top of the room that had just been created.
  const dialog = route.view === "overlay" ? route.dialog : null;
  const transient = typeof dialog === "object" && dialog !== null && dialog.kind === "room" && !dialog.id;
  return {
    page: null,
    projectItemId: null,
    selected,
    selectedThreadId: selected && route.view !== "list" ? route.threadId : null,
    exchangeBotSlug: route.view === "exchange" && bots[route.otherSlug] ? route.otherSlug : null,
    detailsOpen: route.view === "overlay" && route.details,
    dialog: transient ? null : dialog,
  };
}
