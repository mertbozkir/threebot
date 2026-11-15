import { assetUrl } from "../store";
import { workspaceEnvironment } from "./workspaceTransport";
import type { LibraryResource } from "./workspaceLinks";
import { workspaceFileKind } from "./workspaceLinks";

// Package 1 adds the optional scope argument. A one-argument local signer remains
// compatible; workspaceEnvironment rejects remote keys without scoped transport.
const signAsset: (resource: Record<string, unknown>, environmentId?: string) => Promise<string> = assetUrl;
export function workspaceAssetUrl(resource: LibraryResource, scopeThreadId: string | null = null) {
  const owner = resource._tag === "workspace-file" ? resource.threadId : scopeThreadId;
  if (resource._tag === "workspace-file") {
    const kind = workspaceFileKind(resource.path);
    // T3 workspace-file grants cover browser documents and images, not text or
    // audio/video. media-file resolves relative paths in the owning thread.
    // Download disposition permits arbitrary files; fetch can still read text.
    if (["text", "file", "sheet", "doc", "audio", "video"].includes(kind)) {
      return signAsset({ ...resource, _tag: "media-file", ...(["text", "file", "sheet", "doc"].includes(kind) ? { disposition: "attachment" } : {}) }, workspaceEnvironment(owner));
    }
  }
  return signAsset(resource, workspaceEnvironment(owner));
}
