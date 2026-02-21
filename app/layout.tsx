import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ProductAnalyzer",
  description: "Video-to-product analyzer with Azure OpenAI and Supabase",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="sv">
      <body>{children}</body>
    </html>
  );
}
