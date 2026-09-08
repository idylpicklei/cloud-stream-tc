import { HomePage } from "./pages/HomePage";
import { HostPage } from "./pages/HostPage";
import { ViewerPage } from "./pages/ViewerPage";

function path(): string {
  return window.location.pathname.replace(/\/+$/, "") || "/";
}

export default function App() {
  const route = path();

  if (route === "/host") return <HostPage />;
  if (route === "/watch" || route === "/viewer") return <ViewerPage />;
  return <HomePage />;
}
