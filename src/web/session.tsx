import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api.ts";
import type { Me, Person, Project } from "./types.ts";

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
  loading: boolean;
  reload: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [site, setSite] = useState<SiteConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const who = await api.get<Me>("/api/me");
      const cfg = await api.get<{ projects: Project[] }>("/api/config");
      const ppl = who.role === "requester" ? { users: [] } : await api.get<{ users: Person[] }>("/api/users");
      setMe(who);
      setProjects(cfg.projects);
      setPeople(ppl.users);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) console.error(err);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    api.get<SiteConfig>("/auth/config").then(setSite).catch(() => setSite(null));
    void reload();
  }, [reload]);

  return (
    <SessionContext.Provider value={{ site, me, projects, people, loading, reload }}>{children}</SessionContext.Provider>
  );
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
