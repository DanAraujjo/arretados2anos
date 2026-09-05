import { HomeClient } from "@/components/HomeClient";
import { loadPhotos } from "@/lib/photos";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { photos, hint } = await loadPhotos();
  return <HomeClient photos={photos} hint={hint} />;
}
