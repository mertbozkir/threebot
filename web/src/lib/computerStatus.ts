import type { ComputerStatus } from "./types";

export type ConnectionTone = "good" | "attention";

const STATE_LABELS: Partial<Record<ComputerStatus["state"], string>> = {
  off: "Not running",
  stopped: "Sleeping",
  building: "Updating…",
  starting: "Starting…",
  stopping: "Stopping…",
  unavailable: "Unavailable",
  failed: "Failed",
};

/** The Connection pill: green with the runtime while the computer is usable, otherwise the reason. */
export function connectionPill(status: Pick<ComputerStatus, "state" | "reason" | "runtime">): { text: string; tone: ConnectionTone } {
  if (status.state === "healthy") return { text: status.runtime ? `Connected · ${status.runtime}` : "Connected", tone: "good" };
  return { text: status.reason ?? STATE_LABELS[status.state] ?? "Not running", tone: "attention" };
}

/** The note under "Update Bot's computer": whether the image the container runs is the current one. */
export function updateNote(status: Pick<ComputerStatus, "state" | "image">): { text: string } {
  if (status.state === "building") return { text: "Rebuilding with fresh packages…" };
  return { text: status.image.latest ? "✓ Your computer is on the latest version" : "An update is available" };
}
