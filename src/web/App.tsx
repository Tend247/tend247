import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router";
import { lazy, Suspense } from "react";
import type React from "react";
import { useSession } from "./session.tsx";
import { api } from "./api.ts";
import { SignIn } from "./pages/SignIn.tsx";
import { RecordList } from "./pages/RecordList.tsx";
import { RecordNew } from "./pages/RecordNew.tsx";
import { RecordDetail } from "./pages/RecordDetail.tsx";
import { AdminProjects } from "./pages/admin/AdminProjects.tsx";
import { AdminProject } from "./pages/admin/AdminProject.tsx";
import { AdminUsers } from "./pages/admin/AdminUsers.tsx";
import { AdminAudit } from "./pages/admin/AdminAudit.tsx";
import { Trash } from "./pages/Trash.tsx";
import { Approvals, Notifications } from "./pages/Inbox.tsx";
import { WorkflowEditor } from "./pages/admin/WorkflowEditor.tsx";
import { LayoutEditor } from "./pages/admin/LayoutEditor.tsx";
import { AdminTeams } from "./pages/admin/AdminTeams.tsx";
import { AdminAutomation } from "./pages/admin/AdminAutomation.tsx";
import { AdminCalendars } from "./pages/admin/AdminCalendars.tsx";
import { AdminSettings } from "./pages/admin/AdminSettings.tsx";
import { Landing } from "./site/Landing.tsx";
import { Roadmap } from "./site/Roadmap.tsx";
import { Architecture } from "./site/Architecture.tsx";
import { Settings } from "./pages/Settings.tsx";
import { AdminWebhooks } from "./pages/admin/AdminWebhooks.tsx";
import { AdminImport } from "./pages/admin/AdminImport.tsx";
import { Portal } from "./portal/Portal.tsx";
import { Mobile } from "./mobile/Mobile.tsx";
import { DemoBar, DemoMail } from "./demo/DemoBar.tsx";
// Loaded on first visit: charts, planning and the setup guide are not on the everyday path.
const Dashboard = lazy(() => import("./pages/Dashboard.tsx").then((m) => ({ default: m.Dashboard })));
const Plan = lazy(() => import("./agile/Plan.tsx").then((m) => ({ default: m.Plan })));
const SetupWizard = lazy(() => import("./pages/admin/SetupWizard.tsx").then((m) => ({ default: m.SetupWizard })));
import type { Me } from "./types.ts";

/** Where a signed-in person belongs: phones read-only at /m, requesters in the portal, staff in /app. */
export function homeFor(me: Me): string {
  if (me.readOnly) return "/m";
  return me.role === "requester" ? "/portal" : "/app";
}

/**
 * Routes:
 *   /, /roadmap, /architecture   marketing pages (only when TEND247_PUBLIC_SITE is on)
 *   /signin                      sign-in
 *   /app/*                       the product for staff
 *   /portal/*                    the requester portal
 *   /m/*                         phone views (where a paired, read-only phone lands)
 */
export function App() {
  const { me, site, loading } = useSession();
  if (loading || !site) return <div className="center muted">Loading…</div>;
  const home = site.publicSite ? null : <Navigate to={me ? homeFor(me) : "/signin"} replace />;
  const signedIn = (el: React.ReactElement) => (me ? el : <Navigate to={site.demo.enabled ? "/" : "/signin"} replace />);

  return (
    <Routes>
      <Route path="/" element={home ?? <Landing />} />
      <Route path="/roadmap" element={home ?? <Roadmap />} />
      <Route path="/architecture" element={home ?? <Architecture />} />
      <Route path="/signin" element={me ? <Navigate to={homeFor(me)} replace /> : <SignIn />} />
      <Route path="/app/*" element={signedIn(<AppShell />)} />
      <Route path="/portal/*" element={signedIn(me?.readOnly ? <Navigate to="/m" replace /> : <Portal />)} />
      <Route path="/m/*" element={signedIn(<Mobile />)} />
      <Route path="*" element={<Navigate to={site.publicSite ? "/" : me ? homeFor(me) : "/signin"} replace />} />
    </Routes>
  );
}

function AppShell() {
  const { me, reload, unread, site, projects } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  if (!me) return null;
  // Phones stay in the read-only views; requesters use the portal (links in emails still work).
  if (me.readOnly) return <Navigate to={location.pathname.replace(/^\/app\/records\//, "/m/records/").replace(/^\/app.*$/, "/m")} replace />;
  if (me.role === "requester") {
    const m = /^\/app\/records\/([^/]+)/.exec(location.pathname);
    return <Navigate to={m ? `/portal/requests/${m[1]}` : "/portal"} replace />;
  }

  async function signOut() {
    await api.post("/auth/logout");
    await reload();
    navigate(site?.demo.enabled ? "/" : "/signin");
  }

  const isAdmin = me.role === "admin";
  // Requesters were redirected to the portal above.
  const staff = true;
  return (
    <div className="shell app">
      {me.demo && <DemoBar />}
      <header className="topbar">
        <NavLink to="/app" className="brand">
          Tend <span className="accent">24/7</span>
        </NavLink>
        <nav>
          <NavLink to="/app" end>
            Records
          </NavLink>
          {staff && projects.some((p) => p.agile) && <NavLink to="/app/plan">Planning</NavLink>}
          {staff && <NavLink to="/app/dashboard">Dashboard</NavLink>}
          {staff && <NavLink to="/app/approvals">Approvals</NavLink>}
          {isAdmin && <NavLink to="/app/admin">Admin</NavLink>}
          {isAdmin && <NavLink to="/app/trash">Trash</NavLink>}
        </nav>
        <div className="spacer" />
        <NavLink to="/app/notifications" className="bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>
          Notifications{unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
        </NavLink>
        <NavLink to="/app/settings" className="muted small">
          {me.displayName} · {me.role}
        </NavLink>
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </header>
      <main className="content">
        <Suspense fallback={<p className="muted">Loading…</p>}>
        <Routes>
          <Route index element={<RecordList />} />
          <Route path="records/new" element={<RecordNew />} />
          <Route path="records/:key" element={<RecordDetail />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="settings" element={<Settings />} />
          <Route path="demo-mail" element={me.demo ? <DemoMail /> : <Navigate to="/app" replace />} />
          {staff && <Route path="dashboard" element={<Dashboard />} />}
          {staff && <Route path="plan" element={<Plan />} />}
          {staff && <Route path="plan/:projectId" element={<Plan />} />}
          {staff && <Route path="plan/:projectId/:tab" element={<Plan />} />}
          {isAdmin && <Route path="admin/new" element={<SetupWizard />} />}
          {isAdmin && <Route path="admin/webhooks" element={<AdminWebhooks />} />}
          {isAdmin && <Route path="admin/import" element={<AdminImport />} />}
          {staff && <Route path="approvals" element={<Approvals />} />}
          {isAdmin && <Route path="admin/record-types/:id/workflow" element={<WorkflowEditor />} />}
          {isAdmin && <Route path="admin/record-types/:id/layout" element={<LayoutEditor />} />}
          {isAdmin && <Route path="admin/teams" element={<AdminTeams />} />}
          {isAdmin && <Route path="admin/automation" element={<AdminAutomation />} />}
          {isAdmin && <Route path="admin/calendars" element={<AdminCalendars />} />}
          {isAdmin && <Route path="admin/settings" element={<AdminSettings />} />}
          {isAdmin && <Route path="admin" element={<AdminProjects />} />}
          {isAdmin && <Route path="admin/projects/:id" element={<AdminProject />} />}
          {isAdmin && <Route path="admin/users" element={<AdminUsers />} />}
          {isAdmin && <Route path="admin/audit" element={<AdminAudit />} />}
          {isAdmin && <Route path="trash" element={<Trash />} />}
          <Route path="*" element={<p className="muted">Page not found.</p>} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
}
