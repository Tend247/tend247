import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router";
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

/**
 * Routes:
 *   /, /roadmap, /architecture   marketing pages (only when TEND247_PUBLIC_SITE is on)
 *   /signin                      sign-in
 *   /app/*                       the product, signed in
 */
export function App() {
  const { me, site, loading } = useSession();
  if (loading || !site) return <div className="center muted">Loading…</div>;
  const home = site.publicSite ? null : <Navigate to="/app" replace />;

  return (
    <Routes>
      <Route path="/" element={home ?? <Landing />} />
      <Route path="/roadmap" element={home ?? <Roadmap />} />
      <Route path="/architecture" element={home ?? <Architecture />} />
      <Route path="/signin" element={me ? <Navigate to="/app" replace /> : <SignIn />} />
      <Route path="/app/*" element={me ? <AppShell /> : <Navigate to="/signin" replace />} />
      <Route path="*" element={<Navigate to={site.publicSite ? "/" : "/app"} replace />} />
    </Routes>
  );
}

function AppShell() {
  const { me, reload, unread } = useSession();
  const navigate = useNavigate();
  if (!me) return null;

  async function signOut() {
    await api.post("/auth/logout");
    await reload();
    navigate("/signin");
  }

  const isAdmin = me.role === "admin";
  const staff = me.role !== "requester";
  return (
    <div className="shell app">
      <header className="topbar">
        <NavLink to="/app" className="brand">
          Tend <span className="accent">24/7</span>
        </NavLink>
        <nav>
          <NavLink to="/app" end>
            {staff ? "Records" : "My requests"}
          </NavLink>
          {staff && <NavLink to="/app/approvals">Approvals</NavLink>}
          {isAdmin && <NavLink to="/app/admin">Admin</NavLink>}
          {isAdmin && <NavLink to="/app/trash">Trash</NavLink>}
        </nav>
        <div className="spacer" />
        <NavLink to="/app/notifications" className="bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>
          Notifications{unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
        </NavLink>
        <span className="muted small">
          {me.displayName} · {me.role}
        </span>
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </header>
      <main className="content">
        <Routes>
          <Route index element={<RecordList />} />
          <Route path="records/new" element={<RecordNew />} />
          <Route path="records/:key" element={<RecordDetail />} />
          <Route path="notifications" element={<Notifications />} />
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
      </main>
    </div>
  );
}
