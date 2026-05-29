import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Dashboard from "./pages/dashboard";
import Signin from "./pages/signin";
import Signup from "./pages/signup";
import SharedBrain from "./pages/shared";

// ── QueryClient ──
// Create once at module level, not inside the component.
// If you create it inside App, every re-render of App creates a new client
// and throws away all cached data.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,              // retry failed requests once
      refetchOnWindowFocus: true,  // refetch when user tabs back — keeps data fresh
    },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/signup" element={<Signup />} />
          <Route path="/signin" element={<Signin />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/share/:hash" element={<SharedBrain />} />
          <Route path="*" element={<Navigate to="/signup" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;