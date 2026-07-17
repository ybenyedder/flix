import { json } from "@/server/http";
import { UploadError } from "@/server/upload/manager";

/** Map an upload-manager error to a JSON response. A known UploadError carries
 *  its HTTP status and, on a 409, the authoritative resume offset (`received`)
 *  so the client can re-sync; anything else is an opaque 500. Shared by the
 *  three upload routes (init / append / finalize) so they can't drift. */
export function mapUploadError(err: unknown) {
  if (err instanceof UploadError) {
    const payload: Record<string, unknown> = { error: err.message };
    if (typeof err.received === "number") payload.received = err.received;
    return json(payload, { status: err.status });
  }
  return json({ error: "Erreur de téléversement" }, { status: 500 });
}
