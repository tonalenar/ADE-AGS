import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { DesignStudio } from "./DesignStudio";

/**
 * A rota de tela cheia `/design/:id` (abas e canvas): a mesma `DesignStudio` da aba Design do chat.
 * `?artboard=` e `?page=` dizem onde abrir (é o que a ponte `design.open` monta).
 */
export function DesignPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const artboardId = params.get("artboard");
  const pageId = params.get("page");
  const seq = Number(params.get("seq")) || 0;
  const request = useMemo(() => ({ artboardId, pageId, seq }), [artboardId, pageId, seq]);
  return (
    <div className="h-full w-full">
      <DesignStudio key={id} designId={id} host="page" request={request} padRight />
    </div>
  );
}
