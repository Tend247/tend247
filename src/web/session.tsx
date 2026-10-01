import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api.ts";
import type { Me, Person, Project, Team } from "./types.ts";

export interface SiteConfig {
  workspace: { slug: string; name: string; demo: boolean } | null;
  devLogin: boolean;
  oidc: boolean;
  magicLinks: boolean;
  publicSite: boolean;
  repoUrl: string | null;
}

interface Session {
  site: SiteConfig | null;
  me: Me | null;
  projects: Project[];
  people: Person[];
  teams: Team[];
  settings: { attachmentMaxMb: number; timezone: string };
  unread: number;
  loading: boolean;
  reload: () => Promise<void>;
  refreshUnread: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [site, setSite] = useState<SiteConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [settings, setSettings] = useState({ attachmentMaxMb: 25, timezone: "UTC" });
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);

  const refreshUnread = useCallback(async () => {
    try {
      const n = await api.get<{ unread: number }>("/api/notifications?unread=1");
      setUnread(n.unread);
    } catch {
      /* signed out */
    }
  }, []);

  const reload = useCallback(async () => {
    try {
      const who = await api.get<Me>("/api/me");
      const cfg = await api.get<{ projects: Project[]; settings: Session["settings"] }>("/api/config");
      const staff = who.role !== "requester";
      const ppl = staff ? await api.get<{ users: Person[] }>("/api/users") : { users: [] };
      const tms = staff ? await api.get<{ teams: Team[] }>("/api/teams") : { teams: [] };
      setMe(who);
      setProjects(cfg.projects);
      setSettings(cfg.settings);
      setPeople(ppl.users);
      setTeams(tms.teams);
      void refreshUnread();
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) console.error(err);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, [refreshUnread]);

  useEffect(() => {
    api.get<SiteConfig>("/auth/config").then(setSite).catch(() => setSite(null));
    void reload();
  }, [reload]);

  // Keep the notification badge roughly current.
  useEffect(() => {
    if (!me) return;
    const t = setInterval(() => void refreshUnread(), 60_000);
    return () => clearInterval(t);
  }, [me, refreshUnread]);

  return (
    <SessionContext.Provider value={{ site, me, projects, people, teams, settings, unread, loading, reload, refreshUnread }}>
      {children}
    </SessionContext.Provider>
  );
}

/** A fixed, signed-out session for the static marketing site (no API behind it). */
export function StaticSiteProvider({ repoUrl, children }: { repoUrl: string | null; children: ReactNode }) {
  const value: Session = {
    site: { workspace: null, devLogin: false, oidc: false, magicLinks: false, publicSite: true, repoUrl },
    me: null,
    projects: [],
    people: [],
    teams: [],
    settings: { attachmentMaxMb: 25, timezone: "UTC" },
    unread: 0,
    loading: false,
    reload: async () => {},
    refreshUnread: async () => {},
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

export function personName(people: Person[], id: string | null | undefined): string {
  if (!id) return "Unassigned";
  return people.find((p) => p.id === id)?.displayName ?? "Someone";
}

export function allRecordTypes(projects: Project[]) {
  return projects.flatMap((p) => p.recordTypes.map((t) => ({ ...t, project: p })));
}
