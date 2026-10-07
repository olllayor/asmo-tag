export type StartHint = { id: string; configure: boolean };

export function readStartHint(search: string, hash: string, initData?: string): StartHint | null {
  const query = new URLSearchParams(search);
  const launch = new URLSearchParams(hash.replace(/^#/, ""));
  const raw = (initData ? new URLSearchParams(initData).get("start_param") : null)
    ?? query.get("tgWebAppStartParam")
    ?? launch.get("tgWebAppStartParam")
    ?? query.get("startapp");
  if (!raw) return null;
  const configure = raw.startsWith("c_");
  return { id: configure ? raw.slice(2) : raw, configure };
}
