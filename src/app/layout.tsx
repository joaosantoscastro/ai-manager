import type { Metadata } from "next";
import "./globals.css";
import { AppHeader } from "@/ui/AppHeader";
import { SetupStateProvider } from "@/ui/SetupState";
import { ToastProvider } from "@/ui/Toast";

export const metadata: Metadata = {
  title: "Local AI Setup Manager",
  description:
    "Discover and control the plugins, MCP servers, tools, skills and agents active in your local Copilot setup.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <SetupStateProvider>
          <ToastProvider>
            <AppHeader />
            <div
              style={{
                maxWidth: "var(--content-width)",
                margin: "0 auto",
                padding: "24px 24px 48px",
              }}
            >
              <main>{children}</main>
            </div>
          </ToastProvider>
        </SetupStateProvider>
      </body>
    </html>
  );
}
