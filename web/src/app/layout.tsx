import type { Metadata, Viewport } from "next";
import { Bebas_Neue, Sora } from "next/font/google";
import "./globals.css";

const bebas = Bebas_Neue({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-bebas",
});

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
});

export const metadata: Metadata = {
  title: "Arretados 2 Anos — Encontre você nas fotos",
  description:
    "Reconhecimento facial e vídeo animado com as fotos do Arretados do Vôlei.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Arretados",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0a1f4d",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className={`${bebas.variable} ${sora.variable} h-dvh overflow-hidden`}>
      <body className="flex h-dvh flex-col overflow-hidden antialiased">{children}</body>
    </html>
  );
}
