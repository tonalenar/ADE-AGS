import { RouterProvider } from "react-router-dom";
import { router } from "@/app/router";
import { useRepoSyncFailures } from "@/features/memory/repoSyncFailures";
import { useScreenRecordingFailures } from "@/features/recording/screenRecordingFailures";
import { useHousekeepingFailures } from "@/features/runs/housekeepingFailures";
import "@/App.css";

export default function App() {
  // Falha ao finalizar gravação chega aqui com qualquer tela aberta (ver `screen_recording::stop_all_with_deadline`).
  useScreenRecordingFailures();
  // Falha de exportação do repositório de memória também pode acontecer com qualquer tela aberta.
  useRepoSyncFailures();
  useHousekeepingFailures();
  return <RouterProvider router={router} />;
}
