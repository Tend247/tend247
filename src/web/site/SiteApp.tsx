import { Navigate, Route, Routes } from "react-router";
import { StaticSiteProvider } from "../session.tsx";
import { SITE_REPO_URL } from "../siteOnly.ts";
import { Landing } from "./Landing.tsx";
import { Roadmap } from "./Roadmap.tsx";
import { Architecture } from "./Architecture.tsx";

/** The static marketing site: landing, roadmap and architecture, and nothing that needs the API. */
export function SiteApp() {
  return (
    <StaticSiteProvider repoUrl={SITE_REPO_URL}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/roadmap" element={<Roadmap />} />
        <Route path="/architecture" element={<Architecture />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </StaticSiteProvider>
  );
}
