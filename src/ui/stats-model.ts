import { redactSecrets } from '../core/vendor/redact-secrets';
import { controlTokens, emptyControls } from '../query/query-text';
import type { StatsResult } from '../query/stats';

/** Pure Statistics helpers (no vscode dependency). */

/** R10.4 – text cells (titles, workspace labels, model, mode and tool names) redacted unless the user turned it off. */
export function redactStats(r: StatsResult, redact: boolean): StatsResult {
  if (!redact) return r;
  const red = redactSecrets;
  const top = (list: StatsResult['top']['byPrompts']): StatsResult['top']['byPrompts'] => list.map((s) => ({ ...s, title: red(s.title), workspaceName: red(s.workspaceName) }));
  const share = (list: StatsResult['models']): StatsResult['models'] => list.map((m) => ({ ...m, name: red(m.name) }));
  return {
    ...r,
    workspaces: r.workspaces.map((w) => ({ ...w, label: red(w.label) })),
    models: share(r.models),
    modes: share(r.modes),
    tools: r.tools.map((t) => ({ ...t, tool: red(t.tool) })),
    top: { byPrompts: top(r.top.byPrompts), byCredits: top(r.top.byCredits), byDuration: top(r.top.byDuration) },
    facets: { ...r.facets, groups: r.facets.groups.map((g) => ({ ...g, label: red(g.label) })) },
  };
}

/** Widget 6 click → `tool:` search (R9.2), written like a Search Panel control token (R7.13). */
export function toolQuery(tool: string): string {
  return controlTokens('tool', { ...emptyControls(), tool: [tool] })[0] ?? '';
}
