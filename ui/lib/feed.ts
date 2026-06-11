import type { ActivityItem } from "./types";

/**
 * Shorten an absolute path for the activity feed. Paths inside a run
 * workspace become workspace-relative; paths under the mission cwd become
 * cwd-relative; anything else keeps its last two segments.
 */
export function shortPath(p: string, cwd?: string): string {
  if (!p.startsWith("/") && !/^[A-Za-z]:\\/.test(p)) return p;
  const ws = p.replace(/^.*?\/runs\/run_[a-z0-9]+\/workspace\/?/, "");
  if (ws !== p) return ws || "workspace/";
  if (cwd && p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  if (cwd && p === cwd) return ".";
  const segs = p.split("/").filter(Boolean);
  if (segs.length <= 2) return p;
  return "…/" + segs.slice(-2).join("/");
}

/**
 * Turn a raw failed-tool summary ("ERROR: ENOENT: no such file or directory,
 * open '/long/path'") into a calm one-liner. Display-only — the journal keeps
 * the full text.
 */
export function summarizeToolError(raw: string, cwd?: string): string {
  const s = raw.replace(/\s+/g, " ").trim();
  const enoent = s.match(/ENOENT[^']*'([^']*)'/);
  if (enoent) return `file not found: ${shortPath(enoent[1], cwd)}`;
  if (/ENOENT/.test(s)) return "file not found";
  if (/EACCES|EPERM/.test(s)) return "permission denied";
  if (/ETIMEDOUT|timed? ?out/i.test(s)) return "timed out";
  if (/EEXIST/.test(s)) return "already exists";
  if (/EISDIR/.test(s)) return "path is a directory";
  if (/ENOTDIR/.test(s)) return "path is not a directory";
  const exit = s.match(/exit(?:ed)?(?: with)? code (\d+)/i);
  if (exit) return `exited with code ${exit[1]}`;
  const cleaned = s.replace(/^(ERROR|Error)[:\s]+/g, "").trim();
  return cleaned.length > 120 ? cleaned.slice(0, 117) + "…" : cleaned || "failed";
}

export type ActivityGroup = ActivityItem & { count?: number };

/**
 * File-shaped tools whose ok-result summary adds nothing the call row didn't
 * already say — absorbing them lets back-to-back calls fold into one row.
 * Shell/search/fetch results stay: their summaries carry real signal.
 */
const ABSORB_OK_RESULT = new Set(["read_file", "list_dir", "write_file", "replace_in_file", "save_artifact"]);

/**
 * Collapse runs of repeated tool calls into single rows ("read_file ×4").
 * Quiet ok results between same-tool calls are absorbed; a failed result
 * always surfaces and breaks the group.
 */
export function groupActivity(items: ActivityItem[]): ActivityGroup[] {
  const out: ActivityGroup[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (
      item.kind === "result" &&
      item.ok &&
      last?.kind === "tool" &&
      last.name === item.name &&
      last.taskId === item.taskId &&
      ABSORB_OK_RESULT.has(item.name ?? "")
    ) {
      continue;
    }
    if (item.kind === "tool" && last?.kind === "tool" && last.name === item.name && last.taskId === item.taskId) {
      // Keep the first item's id so the React key stays stable as the group grows.
      out[out.length - 1] = { ...item, id: last.id, count: (last.count ?? 1) + 1 };
      continue;
    }
    out.push(item);
  }
  return out;
}
