import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
const render = (app: ReactNode) =>
  root.render(
    <StrictMode>
      <BrowserRouter>{app}</BrowserRouter>
    </StrictMode>,
  );

// The static site build loads only the marketing pages; the Worker build loads the product.
// The condition is written out (not imported) so the site build drops the product code entirely.
if (import.meta.env.VITE_SITE_ONLY === "1") {
  void import("./site/SiteApp.tsx").then(({ SiteApp }) => render(<SiteApp />));
} else {
  void Promise.all([import("./session.tsx"), import("./App.tsx")]).then(([{ SessionProvider }, { App }]) =>
    render(
      <SessionProvider>
        <App />
      </SessionProvider>,
    ),
  );
}
