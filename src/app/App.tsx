import { RouterProvider } from "react-router-dom";
import { router } from "@/app/router";
import { useScreenRecordingFailures } from "@/features/recording/screenRecordingFailures";
import "@/App.css";

export default function App() {
  // Falha ao finalizar gravação chega aqui com qualquer tela aberta (ver `screen_recording::stop_all_with_deadline`).
  useScreenRecordingFailures();
  return <RouterProvider router={router} />;
}
